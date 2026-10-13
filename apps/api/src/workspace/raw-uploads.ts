import { BadRequestException, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isRawUploadKey, rawUploadKey, type StudioBucket } from '@ag-studio/engine';

/**
 * Uploads that go from the browser straight to the bucket (R2), not through nginx and the API: Studio checks the name
 * and size and signs a PUT link (`signRawUpload`), the browser puts the file, then the upload route is called again
 * with the key instead of a multipart file (`takeRawUpload`) and goes on as with a file multer wrote.
 */

/** A file as multer leaves it on disk (and as `takeRawUpload` brings one down). */
export interface UploadedTmp { path: string; originalname: string; size: number }

/** How long a browser has to put the file. */
export const UPLOAD_LINK_TTL_SECONDS = 3600;

/** The upload routes' JSON body once the browser has put the file: the key it was given and the file's own name. */
export const RawUploadFields = {
  uploadKey: z.string().min(1).max(200).optional(),
  name: z.string().min(1).max(255).optional(),
};

/** What a browser asks a link for. */
export const SignUploadFields = {
  name: z.string().min(1).max(255),
  size: z.number().int().min(1),
  contentType: z.string().max(100).regex(/^[\w.+-]+\/[\w.+-]+$/).optional(),
};

/** A PUT link for one file of `scope` (a project id, or `library`). */
export async function signRawUpload(bucket: StudioBucket, scope: string, contentType: string | undefined): Promise<{ key: string; url: string; contentType: string; expiresAt: string }> {
  const key = rawUploadKey(scope);
  const type = contentType || 'application/octet-stream';
  const url = await bucket.signedPutUrl(key, UPLOAD_LINK_TTL_SECONDS, { contentType: type });
  return { key, url, contentType: type, expiresAt: new Date(Date.now() + UPLOAD_LINK_TTL_SECONDS * 1000).toISOString() };
}

/**
 * The file a browser put at `key` (only a raw upload of `scope`), brought down into a temp file under `name`. Larger
 * than `maxBytes` (by its size on the bucket, whatever the browser said) is a 413 and the object is dropped.
 */
export async function takeRawUpload(bucket: StudioBucket, scope: string, key: string, name: string, maxBytes: (name: string) => number): Promise<UploadedTmp> {
  if (!isRawUploadKey(key, scope)) throw new BadRequestException({ code: 'upload_key', message: 'Mã tải lên không hợp lệ' });
  const head = await bucket.exists(key);
  if (!head) throw new NotFoundException({ code: 'upload_missing', message: 'Không thấy file đã tải lên: tải lại' });
  const max = maxBytes(name);
  if (head.size > max) {
    await dropRawUpload(bucket, scope, key);
    throw new PayloadTooLargeException({ code: 'file_too_large', message: `File lớn hơn ${max / 1024 / 1024} MB` });
  }
  const path = join(tmpdir(), `studio-upload-${randomUUID()}`);
  try {
    const size = await bucket.getFile(key, path);
    return { path, originalname: name, size };
  } catch (e) {
    rmSync(path, { force: true });
    throw e;
  }
}

/** Removes a raw upload of `scope` Studio has taken (or refused); any other key is left alone. The sweep removes the rest. */
export async function dropRawUpload(bucket: StudioBucket, scope: string, key: string | undefined): Promise<void> {
  if (!key || !isRawUploadKey(key, scope)) return;
  try { await bucket.deleteMany([key]); } catch { /* the sweep (`sweepRawUploads`) takes it later */ }
}
