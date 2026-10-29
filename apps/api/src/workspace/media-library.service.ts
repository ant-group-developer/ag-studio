import { Injectable, PayloadTooLargeException, UnsupportedMediaTypeException } from '@nestjs/common';
import { extname } from 'node:path';
import {
  addMediaItem, addMediaToProject, MEDIA_MAX_BYTES, mediaAt, mediaKindOf, newMediaKey, REFERENCE_UPLOAD_MAX_BYTES, REFERENCE_VIDEO_EXTS,
  type MediaItem, type MediaKind, type MediaUse, type SourceRecord,
} from '@ag-studio/engine';
import { EngineService } from '../studio/engine.service';
import { safeFileName } from './file-names';
import { UPLOAD_LINK_TTL_SECONDS } from './raw-uploads';

/** What a person's audio or video upload becomes in a project when they did not say: audio, else a reference video. */
export const defaultUse = (kind: MediaKind): MediaUse => (kind === 'audio' ? 'audio' : 'reference');

/**
 * Uploads into someone's media library (plan 2026-10-29 P2): every audio, video and photo file goes to the bucket under
 * the person who uploads it, never to the server's disk, and a project uses it through a source. Shared by the
 * library's own routes (`me/media`), the Inputs tab and the Files tab.
 */
@Injectable()
export class MediaLibraryService {
  constructor(private readonly engine: EngineService) {}

  /** The kind of a file that goes to the library (audio, video, photo), or null for a document (it stays in the workspace). */
  kindOf(name: string): MediaKind | null {
    return mediaKindOf(name);
  }

  /** Refuses a file the library does not take for `use`: an unknown type (415), too large for its kind or use (413). */
  check(rawName: string, size: number, use?: MediaUse): { name: string; kind: MediaKind } {
    const name = safeFileName(rawName);
    if (use === 'reference' && !(REFERENCE_VIDEO_EXTS as readonly string[]).includes(extname(name).toLowerCase())) {
      throw new UnsupportedMediaTypeException({ code: 'not_video', message: `Video mẫu phải là file video (${REFERENCE_VIDEO_EXTS.join(', ')})` });
    }
    const kind = mediaKindOf(name);
    if (!kind) throw new UnsupportedMediaTypeException({ code: 'file_type', message: `Chưa nhận loại file ${extname(name) || '(không đuôi)'}` });
    if (use === 'audio' && kind !== 'audio') throw new UnsupportedMediaTypeException({ code: 'not_audio', message: 'Chọn file audio (mp3, wav, m4a…)' });
    if (use === 'footage' && kind === 'audio') throw new UnsupportedMediaTypeException({ code: 'file_type', message: 'Footage là video hoặc ảnh' });
    const max = use === 'reference' ? REFERENCE_UPLOAD_MAX_BYTES : MEDIA_MAX_BYTES[kind];
    if (size > max) throw new PayloadTooLargeException({ code: 'file_too_large', message: `File lớn hơn ${Math.round(max / 1024 / 1024)} MB` });
    return { name, kind };
  }

  /** A link to put one file straight into the person's library: `{key, url, contentType, expiresAt}`. */
  async sign(ownerId: string, rawName: string, size: number, contentType: string | undefined, use?: MediaUse) {
    const { name } = this.check(rawName, size, use);
    const { key } = newMediaKey(ownerId, name);
    const type = contentType || 'application/octet-stream';
    const url = await this.engine.bucket.signedPutUrl(key, UPLOAD_LINK_TTL_SECONDS, { contentType: type });
    return { key, url, contentType: type, expiresAt: new Date(Date.now() + UPLOAD_LINK_TTL_SECONDS * 1000).toISOString() };
  }

  /** Whether `key` is an upload into the person's library (else a raw upload or older footage key). */
  isLibraryKey(ownerId: string, key: string | undefined): key is string {
    return !!key && !!mediaAt(ownerId, key);
  }

  /** The file the browser put at `key` as an item of the person's library. */
  take(ownerId: string, key: string, rawName: string): Promise<MediaItem> {
    return addMediaItem(this.engine.db, this.engine.bucket, { ownerId, key, name: safeFileName(rawName) });
  }

  /** A file sent through the API (multipart) put on the bucket as an item of the person's library. */
  async putLocal(ownerId: string, path: string, rawName: string, size: number, use?: MediaUse): Promise<MediaItem> {
    const { name } = this.check(rawName, size, use);
    const { key } = newMediaKey(ownerId, name);
    await this.engine.bucket.putFile(key, path);
    return addMediaItem(this.engine.db, this.engine.bucket, { ownerId, key, name });
  }

  /** The person's items into the project (`addMediaToProject`). */
  addToProject(p: { projectId: string; ownerId: string; mediaIds: string[]; use: MediaUse; videoIds?: string[]; workspaceDir?: string | null }): Promise<SourceRecord[]> {
    return addMediaToProject(this.engine.db, p);
  }
}
