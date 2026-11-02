import {
  BadGatewayException, ForbiddenException, HttpException, Injectable, Logger, NotFoundException, PayloadTooLargeException, ServiceUnavailableException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createWriteStream, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { addMediaItem, agMusicItemIds, agMusicTracksOfProject, findAgMusicItem, MEDIA_MAX_BYTES, newMediaKey, type MediaItem } from '@ag-studio/engine';
import { AgMusicClient, AgMusicClientError, type AgMusicExportStatus, type AgMusicTrackType } from '../ag-music/client';
import { EngineService } from '../studio/engine.service';
import { MediaLibraryService } from './media-library.service';

/** Copying a whole track from ag-music's bucket to Studio's: a 300 MB WAV well within it. */
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;

/** One ag-music track as Studio's picker shows it; `mediaId`: the person's item already fetched from it. */
export interface AgMusicPickerTrack {
  trackId: number; code: string | null; type: AgMusicTrackType; name: string; artists: string[]; categories: string[];
  durationMs: number | null; bpm: number | null; thumbnailUrl: string | null; mediaId: string | null;
}

const log = new Logger('AgMusic');

/**
 * ag-music's refusals as Studio's: no access 403, gone 404, not approved or a copyright violation 422, down 502. A 401
 * is ag-music not accepting Studio's tokens (issuer, audience): a setup fault, not the person's access, so 502 and logged.
 */
export function toAgMusicHttpError(e: unknown): unknown {
  if (!(e instanceof AgMusicClientError)) return e;
  if (e.status === 401) {
    log.error(`ag-music refused the token: ${e.message}`);
    return new BadGatewayException({ code: 'ag_music_unauthorized', message: 'ag-music không nhận phiên đăng nhập của Studio, báo quản trị kiểm tra cấu hình' });
  }
  if (e.status === 403) {
    return new ForbiddenException({ code: 'ag_music_forbidden', message: 'Bạn chưa có quyền xem bài hát ở ag-music' });
  }
  if (e.status === 404) return new NotFoundException({ code: 'ag_music_not_found', message: 'Không thấy bài này ở ag-music' });
  if (e.code === 'TrackNotApproved') return new UnprocessableEntityException({ code: 'track_not_approved', message: 'Bài chưa được duyệt ở ag-music' });
  if (e.code === 'TrackCopyrightViolation') {
    return new UnprocessableEntityException({ code: 'track_copyright_violation', message: 'Bài vi phạm bản quyền, không dùng được' });
  }
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
  /** Copies running in this process, by person and track: a second click waits for the first instead of copying again. */
  private readonly copying = new Map<string, Promise<MediaItem>>();

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
   * (ag-music checks the person may see it, that it is approved and not a copyright violation). The download is counted
   * once the copy is in the library, so a failed copy or a retry counts nothing more.
   */
  async fetch(ownerId: string, accessToken: string, trackId: number): Promise<MediaItem> {
    const api = this.api();
    const known = await findAgMusicItem(this.engine.db, ownerId, trackId);
    if (known) return known;
    const key = `${ownerId}:${trackId}`;
    const running = this.copying.get(key);
    if (running) return running;
    const copy = this.copy(api, ownerId, accessToken, trackId).finally(() => this.copying.delete(key));
    this.copying.set(key, copy);
    return copy;
  }

  /**
   * Before a final render or a Premiere export, asked as the person starting it: the ag-music tracks the project uses must
   * still be usable there. Removed, no longer approved, or a copyright violation: refused (422 `ag_music_track_unusable`,
   * naming them). A track the person cannot see on ag-music is not refused (someone else may have picked it), nor is
   * anything when ag-music cannot be asked (it being down does not stop renders; logged).
   */
  async requireUsableInProject(projectId: string, accessToken: string): Promise<void> {
    if (!this.client) return;
    const tracks = await agMusicTracksOfProject(this.engine.db, projectId);
    if (!tracks.length) return;
    const blocked: { trackId: number; name: string; reason: string }[] = [];
    for (let i = 0; i < tracks.length; i += 100) {
      const part = tracks.slice(i, i + 100);
      let statuses: AgMusicExportStatus[];
      try {
        statuses = await this.client.exportStatus(accessToken, part.map((t) => t.trackId));
      } catch (e) {
        log.warn(`could not ask ag-music whether project ${projectId}'s tracks are usable: ${(e as Error).message}`);
        return;
      }
      for (const st of statuses) {
        if (st.usable || !st.reason || st.reason === 'NOT_FOUND') continue;
        blocked.push({ trackId: st.trackId, name: part.find((t) => t.trackId === st.trackId)?.name ?? String(st.trackId), reason: st.reason });
      }
    }
    if (blocked.length) {
      throw new UnprocessableEntityException({
        code: 'ag_music_track_unusable',
        message: `Nhạc từ ag-music không còn dùng được: ${blocked.map((b) => b.name).join(', ')} (đã gỡ, chưa duyệt hoặc vi phạm bản quyền). Bỏ khỏi dự án hoặc chọn bài khác rồi render lại.`,
        tracks: blocked,
      });
    }
  }

  private async copy(api: AgMusicClient, ownerId: string, accessToken: string, trackId: number): Promise<MediaItem> {
    const x = await agMusicErrors(() => api.exportTrack(accessToken, trackId));
    const { name } = this.media.check(x.fileName, x.sizeBytes, 'audio');
    const { key } = newMediaKey(ownerId, name);
    const dir = mkdtempSync(join(tmpdir(), 'ag-music-'));
    try {
      const file = join(dir, 'track');
      await download(x.url, file, MEDIA_MAX_BYTES.audio);
      if (statSync(file).size === 0) throw new BadGatewayException({ code: 'ag_music_unavailable', message: 'File tải từ ag-music bị rỗng' });
      await this.engine.bucket.putFile(key, file, x.contentType ?? undefined);
      const item = await addMediaItem(this.engine.db, this.engine.bucket, {
        ownerId, key, name,
        origin: { system: 'ag-music', trackId: x.trackId, fileId: x.fileId, code: x.code, type: x.type, origin: x.origin, copyrightStatus: x.copyrightStatus },
      });
      // The item is there whatever ag-music answers: a lost count is better than a copy thrown away
      await api.confirmExport(accessToken, trackId).catch((e: unknown) => log.warn(`ag-music did not count the download of track ${trackId}: ${(e as Error).message}`));
      return item;
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
