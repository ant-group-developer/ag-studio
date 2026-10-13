/** Calling the Studio API: the bearer token, the `{success, data, error, requestId}` envelope, and its errors. */

export const STUDIO_API_URL =
  (import.meta.env.VITE_STUDIO_API_URL as string | undefined) ??
  "http://localhost:3100";

/** A non-2xx answer. `body` is normalised as `{ code, message, ...details }` from the envelope error
 *  (flat, so `body.currentRevision`, `body.missing`, `body.failed` etc. work as before), or the raw
 *  JSON body when the server answers without the envelope. */
export class StudioHttpError extends Error {
  constructor(readonly status: number, readonly body: Record<string, unknown> | null) {
    super(typeof body?.message === "string" ? body.message : `HTTP ${status}`);
    this.name = "StudioHttpError";
  }

  /** The machine code of the refusal (`file_conflict`, `read_only`…), when the server gave one. */
  get code(): string | undefined {
    return typeof this.body?.code === "string" ? this.body.code : undefined;
  }
}

/** True when `v` looks like `{ data, success, error, requestId, timestamp }`. */
function isEnvelope(v: unknown): v is { success: boolean; data: unknown; error: unknown; requestId: string; timestamp: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.success === "boolean" && "data" in r && "error" in r && typeof r.requestId === "string";
}

/** Flatten envelope error `{ code, message, details, fieldErrors }` into `{ code, message, ...details, fieldErrors? }`. */
function flattenEnvelopeError(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== "object" || Array.isArray(err)) return {};
  const e = err as Record<string, unknown>;
  const { code, message, details, fieldErrors } = e;
  return {
    ...(code !== undefined ? { code } : {}),
    ...(message !== undefined ? { message } : {}),
    ...(details && typeof details === "object" && !Array.isArray(details)
      ? (details as Record<string, unknown>)
      : details !== undefined
        ? { details }
        : {}),
    ...(fieldErrors !== undefined ? { fieldErrors } : {}),
  };
}

async function failure(res: Response): Promise<StudioHttpError> {
  let parsed: Record<string, unknown> | null = null;
  try { parsed = (await res.json()) as Record<string, unknown>; } catch { /* not JSON */ }
  const normalised = isEnvelope(parsed) && parsed.error ? flattenEnvelopeError(parsed.error) : parsed;
  return new StudioHttpError(res.status, normalised);
}

export async function request<T>(
  getAccessToken: () => Promise<string>,
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  const token = await getAccessToken();
  // FormData (file uploads) must keep the browser's own multipart Content-Type (with its boundary);
  // everything else goes as JSON.
  const isFormData = typeof FormData !== "undefined" && body instanceof FormData;
  const res = await fetch(`${STUDIO_API_URL}${path}`, {
    method,
    headers: {
      ...(isFormData ? {} : { "Content-Type": "application/json" }),
      Authorization: `Bearer ${token}`,
    },
    body: isFormData ? (body as FormData) : body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw await failure(res);
  if (res.status === 204) return undefined as T;
  const json = await res.json() as unknown;
  return (isEnvelope(json) ? json.data : json) as T;
}

/** Where to put one file on the bucket (a signed PUT link from Studio) and the `Content-Type` it was signed for. */
export interface UploadLink { key: string; url: string; contentType: string; expiresAt: string }

/** How far an upload is, from 0 to 1. */
export type OnProgress = (fraction: number) => void;

/** A file's type as Studio signs it (left out when the browser does not know it or names it oddly). */
export const uploadType = (file: File): { contentType?: string } =>
  (/^[\w.+-]+\/[\w.+-]+$/.test(file.type) && file.type.length <= 100 ? { contentType: file.type } : {});

/**
 * Puts a file straight on the bucket through a signed link (not through Studio's API), saying how far it is. A
 * bucket that cannot be reached is most often one whose CORS does not let this site PUT (`bucket_unreachable`).
 */
export function putToBucket(link: UploadLink, file: Blob, onProgress?: OnProgress): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", link.url);
    xhr.setRequestHeader("Content-Type", link.contentType);
    if (onProgress) xhr.upload.onprogress = (e) => { if (e.lengthComputable && e.total) onProgress(e.loaded / e.total); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress?.(1); resolve(); return; }
      reject(new StudioHttpError(xhr.status, { code: "bucket_refused", message: `Kho lưu trữ từ chối file (HTTP ${xhr.status}): tải lại` }));
    };
    xhr.onerror = () => reject(new StudioHttpError(0, {
      code: "bucket_unreachable",
      message: "Không tải được lên kho lưu trữ (R2): kiểm tra mạng, hoặc báo quản trị bật CORS cho phép PUT từ trang này",
    }));
    xhr.send(file);
  });
}

/** The bytes of an answer that is not JSON (an image, a PDF, a sound), as a Blob. */
export async function requestBlob(getAccessToken: () => Promise<string>, path: string): Promise<Blob> {
  const token = await getAccessToken();
  const res = await fetch(`${STUDIO_API_URL}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw await failure(res);
  return res.blob();
}

export function buildQuery(params: Record<string, string | number | boolean | undefined | null>): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null) q.set(k, String(v));
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}
