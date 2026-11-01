import {
  BadGatewayException, ForbiddenException, HttpException, Injectable, NotFoundException, PayloadTooLargeException, ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createWriteStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { addMediaItem, agMusicItemIds, findAgMusicItem, MEDIA_MAX_BYTES, newMediaKey, type MediaItem } from '@ag-studio/engine';
import { AgMusicClient, AgMusicClientError, type AgMusicTrackType } from '../ag-music/client';
import { EngineService } from '../studio/engine.service';
import { MediaLibraryService } from './media-library.service';

/** Copying a whole track from ag-music's bucket to Studio's: a 300 MB WAV well within it. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** One ag-music track as Studio's picker shows it; `mediaId`: the person's item already fetched from it. */
export interface AgMusicPickerTrack {
  trackId: number; code: string | null; type: AgMusicTrackType; name: string; artists: string[]; categories: string[];
  durationMs: number | null; bpm: number | null; thumbnailUrl: string | null; mediaId: string | null;
}

/** ag-music's refusals as Studio's: no access 403, gone 404, not approved 422, down 502. */
export function toAgMusicHttpError(e: unknown): unknown {
  if (!(e instanceof AgMusicClientError)) return e;
  if (e.status === 401 || e.status === 403) {
    return new ForbiddenException({ code: 'ag_music_forbidden', message: 'Bạn chưa có quyền xem bài hát ở ag-music' });
  }
  if (e.status === 404) return new NotFoundException({ code: 'ag_music_not_found', message: 'Không thấy bài này ở ag-music' });
  if (e.code === 'TrackNotApproved') return new UnprocessableEntityException({ code: 'track_not_approved', message: 'Bài chưa được duyệt ở ag-music' });
  if (e.status >= 400 && e.status < 500) return new UnprocessableEntityException({ code: 'ag_music_refused', message: e.message });
  return new BadGatewayException({ code: 'ag_music_unavailable', message: 'ag-music đang không trả lời, thử lại sau' });
}

async function agMusicErrors<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toAgMusicHttpError(e);
  }
}

/**
 * Music from ag-music-v2 into someone's media library (2026-11-01), so they no longer download a track there to upload
 * it here: they pick among the approved tracks they may see, and Studio copies the main audio to the bucket under them as
 * an audio item that remembers the track. Every call goes as that person (their access token), so ag-music decides
 * what they see and counts the download. `AG_MUSIC_API_URL` unset: off.
 */
@Injectable()
export class AgMusicService {
  private readonly client: AgMusicClient | null;

  constructor(config: ConfigService, private readonly engine: EngineService, private readonly media: MediaLibraryService) {
    const url = config.get<string>('AG_MUSIC_API_URL');
    this.client = url ? new AgMusicClient({ baseUrl: url }) : null;
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  private api(): AgMusicClient {
    if (!this.client) throw new ServiceUnavailableException({ code: 'ag_music_disabled', message: 'Studio chưa nối với ag-music' });
    return this.client;
  }

  async tracks(ownerId: string, accessToken: string, q: { q?: string; type?: AgMusicTrackType; page: number; size: number }) {
    const api = this.api();
    const r = await agMusicErrors(() => api.listTracks(accessToken, { keyword: q.q, types: q.type ? [q.type] : undefined, page: q.page, size: q.size }));
    const have = await agMusicItemIds(this.engine.db, ownerId, r.items.map((t) => t.id));
    const items: AgMusicPickerTrack[] = r.items.map((t) => ({
      trackId: t.id, code: t.code ?? null, type: t.type, name: t.name, artists: (t.artists ?? []).map((a) => a.name),
      categories: (t.categories ?? []).map((c) => c.name), durationMs: t.durationMs ?? null, bpm: t.bpm ?? null,
      thumbnailUrl: t.thumbnailUrl ?? null, mediaId: have.get(t.id) ?? null,
    }));
    return { items, total: r.totalElements, page: r.page, size: r.size };
  }

  /** A link to listen to the track before picking it (straight from ag-music's bucket). */
  async listen(accessToken: string, trackId: number): Promise<{ url: string; expiresAt: string }> {
    const api = this.api();
    const p = await agMusicErrors(() => api.playback(accessToken, trackId));
    return { url: p.audioUrl, expiresAt: p.expiresAt };
  }

  /**
   * The track's main audio as an item of the person's library: the one already fetched from it, or a copy made now
   * (ag-music checks the person may see it and that it is approved, and counts a download).
   */
  async fetch(ownerId: string, accessToken: string, trackId: number): Promise<MediaItem> {
    const api = this.api();
    const known = await findAgMusicItem(this.engine.db, ownerId, trackId);
    if (known) return known;
    const x = await agMusicErrors(() => api.exportTrack(accessToken, trackId));
    const { name } = this.media.check(x.fileName, x.sizeBytes, 'audio');
    const { key } = newMediaKey(ownerId, name);
    const dir = mkdtempSync(join(tmpdir(), 'ag-music-'));
    try {
      const file = join(dir, 'track');
      await download(x.url, file, MEDIA_MAX_BYTES.audio);
      if (statSync(file).size === 0) throw new BadGatewayException({ code: 'ag_music_unavailable', message: 'File tải từ ag-music bị rỗng' });
      await this.engine.bucket.putFile(key, file, x.contentType ?? undefined);
      return await addMediaItem(this.engine.db, this.engine.bucket, {
        ownerId, key, name,
        origin: { system: 'ag-music', trackId: x.trackId, fileId: x.fileId, code: x.code, type: x.type, origin: x.origin, copyrightStatus: x.copyrightStatus },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

/** Streams the signed link ag-music gave to `dest`, stopping past `maxBytes`. */
export async function download(url: string, dest: string, maxBytes: number, timeoutMs = DOWNLOAD_TIMEOUT_MS): Promise<void> {
  const tooLarge = () => new PayloadTooLargeException({ code: 'file_too_large', message: `File lớn hơn ${Math.round(maxBytes / 1024 ** 2)} MB` });
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new BadGatewayException({ code: 'ag_music_unavailable', message: `Không tải được file từ ag-music: ${(e as Error).message}` });
  }
  if (!res.ok || !res.body) throw new BadGatewayException({ code: 'ag_music_unavailable', message: `Không tải được file từ ag-music: HTTP ${res.status}` });
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooLarge();
  let seen = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      seen += chunk.length;
      cb(seen > maxBytes ? tooLarge() : null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(res.body as never), cap, createWriteStream(dest));
  } catch (e) {
    if (e instanceof HttpException) throw e;
    throw new BadGatewayException({ code: 'ag_music_unavailable', message: `Tải file từ ag-music bị ngắt: ${(e as Error).message}` });
  }
}
