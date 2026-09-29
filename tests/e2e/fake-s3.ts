/**
 * Minimal in-process S3-compatible fake server for E2E tests.
 *
 * Supports the operations the AG Studio E2E test needs:
 *   - CreateBucket  (PUT /<bucket>)
 *   - PutObject     (PUT /<bucket>/<key>)
 *   - GetObject     (GET /<bucket>/<key>)
 *   - CreateMultipartUpload  (POST /<bucket>/<key>?uploads)
 *   - UploadPart             (PUT  /<bucket>/<key>?partNumber=N&uploadId=X)
 *   - CompleteMultipartUpload (POST /<bucket>/<key>?uploadId=X)
 *   - AbortMultipartUpload   (DELETE /<bucket>/<key>?uploadId=X)
 *
 * Presigned URLs from @aws-sdk/s3-request-presigner are accepted for GET and PUT;
 * the X-Amz-* query parameters are silently ignored (no signature validation).
 *
 * Storage: disk-backed under `dataDir`.
 */

import http from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";

export class FakeS3Server {
  private readonly server: http.Server;
  /** uploadId → partNumber → data */
  private readonly mpUploads = new Map<string, Map<number, Buffer>>();

  constructor(
    readonly port: number,
    private readonly dataDir: string,
  ) {
    mkdirSync(dataDir, { recursive: true });
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        process.stderr.write(`[fake-s3] unhandled: ${String(err)}\n`);
        if (!res.headersSent) {
          res.writeHead(500);
          res.end(String(err));
        }
      });
    });
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "127.0.0.1", () => {
        process.stderr.write(`[fake-s3] listening on port ${this.port}\n`);
        resolve();
      });
    });
  }

  stop(): Promise<void> {
    return new Promise((resolve, reject) =>
      this.server.close((err) => (err ? reject(err) : resolve())),
    );
  }

  /** Absolute disk path for object storage. */
  private objPath(bucket: string, key: string): string {
    return join(this.dataDir, bucket, key);
  }

  private putObject(bucket: string, key: string, data: Buffer): void {
    const p = this.objPath(bucket, key);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, data);
  }

  private getObject(bucket: string, key: string): Buffer | null {
    const p = this.objPath(bucket, key);
    return existsSync(p) ? readFileSync(p) : null;
  }

  private headObject(bucket: string, key: string): { size: number } | null {
    const p = this.objPath(bucket, key);
    if (!existsSync(p)) return null;
    return { size: statSync(p).size };
  }

  private async readBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
    return Buffer.concat(chunks);
  }

  private parsePath(urlPath: string): { bucket: string; key: string } {
    // Path is like /bucket/some/key/path — strip the leading /
    const withoutLeading = urlPath.startsWith("/") ? urlPath.slice(1) : urlPath;
    const slashIdx = withoutLeading.indexOf("/");
    if (slashIdx === -1) {
      return { bucket: withoutLeading, key: "" };
    }
    return {
      bucket: withoutLeading.slice(0, slashIdx),
      key: withoutLeading.slice(slashIdx + 1),
    };
  }

  private xmlError(code: string, message: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`;
  }

  private async handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const rawUrl = req.url ?? "/";
    const url = new URL(rawUrl, `http://127.0.0.1:${this.port}`);
    const { bucket, key } = this.parsePath(url.pathname);
    const method = (req.method ?? "GET").toUpperCase();

    // Health / readiness probe (used in waitForHttp)
    if (url.pathname === "/health" || url.pathname === "/s3/health") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("ok");
      return;
    }

    // -----------------------------------------------------------------
    // CreateBucket: PUT /<bucket>  (no key segment)
    // -----------------------------------------------------------------
    if (method === "PUT" && !key) {
      mkdirSync(join(this.dataDir, bucket), { recursive: true });
      res.writeHead(200, { "Location": `/${bucket}`, "Content-Length": "0" });
      res.end();
      return;
    }

    // -----------------------------------------------------------------
    // CreateMultipartUpload: POST /<bucket>/<key>?uploads
    // -----------------------------------------------------------------
    if (method === "POST" && url.searchParams.has("uploads")) {
      const uploadId = randomUUID();
      this.mpUploads.set(uploadId, new Map());
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<InitiateMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        `<Bucket>${bucket}</Bucket><Key>${key}</Key><UploadId>${uploadId}</UploadId>` +
        `</InitiateMultipartUploadResult>`;
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(xml);
      return;
    }

    // -----------------------------------------------------------------
    // UploadPart: PUT /<bucket>/<key>?partNumber=N&uploadId=X
    // -----------------------------------------------------------------
    if (method === "PUT" && url.searchParams.has("partNumber")) {
      const uploadId = url.searchParams.get("uploadId") ?? "";
      const partNumber = parseInt(url.searchParams.get("partNumber") ?? "1", 10);
      const body = await this.readBody(req);
      const parts = this.mpUploads.get(uploadId);
      if (!parts) {
        res.writeHead(404, { "Content-Type": "application/xml" });
        res.end(this.xmlError("NoSuchUpload", `Upload ${uploadId} not found`));
        return;
      }
      parts.set(partNumber, body);
      const etag = `"${createHash("md5").update(body).digest("hex")}"`;
      res.writeHead(200, { "ETag": etag, "Content-Length": "0" });
      res.end();
      return;
    }

    // -----------------------------------------------------------------
    // CompleteMultipartUpload: POST /<bucket>/<key>?uploadId=X
    // -----------------------------------------------------------------
    if (method === "POST" && url.searchParams.has("uploadId")) {
      const uploadId = url.searchParams.get("uploadId") ?? "";
      const parts = this.mpUploads.get(uploadId);
      if (!parts) {
        res.writeHead(404, { "Content-Type": "application/xml" });
        res.end(this.xmlError("NoSuchUpload", `Upload ${uploadId} not found`));
        return;
      }
      const sorted = [...parts.entries()].sort(([a], [b]) => a - b);
      const combined = Buffer.concat(sorted.map(([, buf]) => buf));
      this.putObject(bucket, key, combined);
      this.mpUploads.delete(uploadId);
      const etag = `"${createHash("md5").update(combined).digest("hex")}"`;
      const xml =
        `<?xml version="1.0" encoding="UTF-8"?>` +
        `<CompleteMultipartUploadResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
        `<Bucket>${bucket}</Bucket><Key>${key}</Key><ETag>${etag}</ETag>` +
        `</CompleteMultipartUploadResult>`;
      res.writeHead(200, { "Content-Type": "application/xml" });
      res.end(xml);
      return;
    }

    // -----------------------------------------------------------------
    // AbortMultipartUpload: DELETE /<bucket>/<key>?uploadId=X
    // -----------------------------------------------------------------
    if (method === "DELETE" && url.searchParams.has("uploadId")) {
      const uploadId = url.searchParams.get("uploadId") ?? "";
      this.mpUploads.delete(uploadId);
      res.writeHead(204, { "Content-Length": "0" });
      res.end();
      return;
    }

    // -----------------------------------------------------------------
    // PutObject: PUT /<bucket>/<key>
    // (also handles presigned PUT — X-Amz-* query params are ignored)
    // -----------------------------------------------------------------
    if (method === "PUT") {
      if (!key) {
        // Should have been caught by CreateBucket above, but guard here too
        res.writeHead(400);
        res.end(this.xmlError("InvalidBucketName", "Key is empty"));
        return;
      }
      const body = await this.readBody(req);
      this.putObject(bucket, key, body);
      const etag = `"${createHash("md5").update(body).digest("hex")}"`;
      res.writeHead(200, { "ETag": etag, "Content-Length": "0" });
      res.end();
      return;
    }

    // -----------------------------------------------------------------
    // HeadObject: HEAD /<bucket>/<key>
    // -----------------------------------------------------------------
    if (method === "HEAD") {
      if (!key) {
        // HeadBucket
        if (existsSync(join(this.dataDir, bucket))) {
          res.writeHead(200, { "Content-Length": "0" });
        } else {
          res.writeHead(404, { "Content-Length": "0" });
        }
        res.end();
        return;
      }
      const meta = this.headObject(bucket, key);
      if (!meta) {
        res.writeHead(404, { "Content-Length": "0" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "Content-Length": String(meta.size),
        "ETag": `"${createHash("md5").digest("hex")}"`,
      });
      res.end();
      return;
    }

    // -----------------------------------------------------------------
    // GetObject: GET /<bucket>/<key>
    // (also handles presigned GET — X-Amz-* query params are ignored)
    // -----------------------------------------------------------------
    if (method === "GET") {
      if (!key) {
        // ListBuckets or similar – not used in our test
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(
          `<?xml version="1.0"?><ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Owner><ID>owner</ID></Owner><Buckets></Buckets></ListAllMyBucketsResult>`,
        );
        return;
      }
      const data = this.getObject(bucket, key);
      const rangeHdr = req.headers["range"];
      process.stderr.write(`[fake-s3] GET /${bucket}/${key} range=${rangeHdr ?? "none"} → ${data ? data.length + "B" : "404"}\n`);
      if (!data) {
        res.writeHead(404, { "Content-Type": "application/xml" });
        res.end(this.xmlError("NoSuchKey", key));
        return;
      }
      const etag = `"${createHash("md5").update(data).digest("hex")}"`;
      // Handle Range requests (e.g. Range: bytes=0-) — return 206 Partial Content
      if (rangeHdr) {
        const m = rangeHdr.match(/bytes=(\d+)-(\d*)/);
        const start = m ? parseInt(m[1], 10) : 0;
        const end = (m && m[2] !== "") ? parseInt(m[2], 10) : data.length - 1;
        const slice = data.slice(start, end + 1);
        res.writeHead(206, {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(slice.length),
          "Content-Range": `bytes ${start}-${end}/${data.length}`,
          "Accept-Ranges": "bytes",
          "ETag": etag,
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Length": String(data.length),
        "Accept-Ranges": "bytes",
        "ETag": etag,
      });
      res.end(data);
      return;
    }

    // -----------------------------------------------------------------
    // Fallthrough
    // -----------------------------------------------------------------
    res.writeHead(405, { "Content-Type": "application/xml" });
    res.end(this.xmlError("MethodNotAllowed", method));
  }
}
