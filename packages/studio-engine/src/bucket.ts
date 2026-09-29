/**
 * The Studio bucket (plan 3.1: only Studio holds its R2 keys). Keys are full object keys, e.g.
 * `productions/<id>/audio/<sha>.wav`. `MemoryBucket` backs unit tests; `S3Bucket` is R2/MinIO/the E2E fake S3.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { StudioStorage } from "@harness/executors";

export interface StudioBucket {
  put(key: string, body: Buffer, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<{ size: number } | null>;
  /** Short-lived GET URL for a browser (preview renders, exports). */
  signedGetUrl(key: string, ttlSeconds: number): Promise<string>;
}

export const productionKey = (productionId: string, rel: string) => `productions/${productionId}/${rel}`;

export class S3Bucket implements StudioBucket {
  private readonly s3: S3Client;
  constructor(private readonly opts: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region?: string }) {
    this.s3 = new S3Client({
      endpoint: opts.endpoint, region: opts.region ?? "auto", forcePathStyle: true,
      credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
    });
  }
  async put(key: string, body: Buffer, contentType?: string): Promise<void> {
    await this.s3.send(new PutObjectCommand({ Bucket: this.opts.bucket, Key: key, Body: body, ...(contentType ? { ContentType: contentType } : {}) }));
  }
  async get(key: string): Promise<Buffer> {
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
    if (!r.Body) throw new Error(`no body for ${key}`);
    return Buffer.from(await r.Body.transformToByteArray());
  }
  async exists(key: string): Promise<{ size: number } | null> {
    try {
      const r = await this.s3.send(new HeadObjectCommand({ Bucket: this.opts.bucket, Key: key }));
      return { size: Number(r.ContentLength ?? 0) };
    } catch (e) {
      const status = (e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (e as { name?: string }).name === "NotFound") return null;
      throw e;
    }
  }
  signedGetUrl(key: string, ttlSeconds: number): Promise<string> {
    return getSignedUrl(this.s3, new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }), { expiresIn: ttlSeconds });
  }
}

export class MemoryBucket implements StudioBucket {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, body: Buffer): Promise<void> { this.objects.set(key, Buffer.from(body)); }
  async get(key: string): Promise<Buffer> {
    const b = this.objects.get(key);
    if (!b) throw new Error(`no object ${key}`);
    return b;
  }
  async exists(key: string): Promise<{ size: number } | null> {
    const b = this.objects.get(key);
    return b ? { size: b.length } : null;
  }
  async signedGetUrl(key: string): Promise<string> { return `memory://${key}`; }
}

/** The farm executor's view of the bucket. */
export function farmStorage(bucket: StudioBucket): StudioStorage {
  return {
    async upload(localPath, objectKey) {
      await bucket.put(objectKey, readFileSync(localPath));
      return `stage:${objectKey}`;
    },
    async download(url, localPath) {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, Buffer.from(await res.arrayBuffer()));
    },
    async downloadOutput(outputPrefix, relPath, localPath) {
      const body = await bucket.get(`${outputPrefix}${relPath}`);
      mkdirSync(dirname(localPath), { recursive: true });
      writeFileSync(localPath, body);
    },
  };
}
