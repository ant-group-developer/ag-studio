/**
 * Uploads go straight to the bucket: Studio checks the file and signs a PUT link, the browser puts the file there
 * (saying how far it is), then Studio takes it by its key. A bucket the page cannot reach says so.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { batchProgress } from "../modules/common/upload-progress";
import { putToBucket, StudioHttpError, uploadType } from "./http";
import { createStudioClient } from "./studio-client";
import { createWorkspaceClient } from "./workspace-client";

const mockFetch = vi.fn();
global.fetch = mockFetch;
const json = (body: unknown) => ({ ok: true, status: 200, json: () => Promise.resolve(body) });
const LINK = { key: "uploads/p1/k", url: "https://r2.test/uploads/p1/k?sig", contentType: "audio/mpeg", expiresAt: "2026-10-13T01:00:00Z" };

/** A stand-in XMLHttpRequest: records the PUT, reports progress, then answers `status` (0: the network failed). */
let status = 200;
const puts: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
class FakeXhr {
  upload: { onprogress: ((e: { lengthComputable: boolean; loaded: number; total: number }) => void) | null } = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  status = 0;
  private req = { method: "", url: "", headers: {} as Record<string, string>, body: null as unknown };
  open(method: string, url: string) { this.req.method = method; this.req.url = url; }
  setRequestHeader(k: string, v: string) { this.req.headers[k] = v; }
  send(body: unknown) {
    this.req.body = body;
    puts.push(this.req);
    this.upload.onprogress?.({ lengthComputable: true, loaded: 1, total: 2 });
    queueMicrotask(() => { if (status === 0) this.onerror?.(); else { this.status = status; this.onload?.(); } });
  }
}
vi.stubGlobal("XMLHttpRequest", FakeXhr);

beforeEach(() => {
  mockFetch.mockReset();
  puts.length = 0;
  status = 200;
});

describe("uploads straight to the bucket", () => {
  it("a source: signed by Studio, put on the bucket with its type, then taken by its key", async () => {
    const client = createWorkspaceClient(async () => "t");
    mockFetch.mockResolvedValueOnce(json(LINK)).mockResolvedValueOnce(json({ source: { ref: "context/audio/nhạc.mp3" }, file: {} }));
    const file = new File(["ab"], "nhạc.mp3", { type: "audio/mpeg" });
    const seen: number[] = [];
    const r = await client.uploadSource("p1", file, "v1", { onProgress: (x) => seen.push(x) });
    expect(r.source.ref).toBe("context/audio/nhạc.mp3");
    const [sign, finish] = mockFetch.mock.calls.map(([url, init]) => [url, JSON.parse((init as RequestInit).body as string)]);
    expect(sign).toEqual([expect.stringMatching(/\/api\/projects\/p1\/uploads$/), { purpose: "source", name: "nhạc.mp3", size: 2, contentType: "audio/mpeg" }]);
    expect(puts).toEqual([{ method: "PUT", url: LINK.url, headers: { "Content-Type": "audio/mpeg" }, body: file }]);
    expect(finish).toEqual([expect.stringMatching(/\/api\/projects\/p1\/sources\/upload$/), { uploadKey: "uploads/p1/k", name: "nhạc.mp3", videoId: "v1" }]);
    expect(seen).toEqual([0.5, 1]);
  });

  it("a reference video and a Files tab file say what they are for", async () => {
    const client = createWorkspaceClient(async () => "t");
    mockFetch.mockResolvedValue(json(LINK));
    await client.uploadSource("p1", new File(["v"], "mẫu.mp4", { type: "video/mp4" }), undefined, { reference: true });
    await client.uploadFile("p1", new File(["x"], "a.md"), "context/notes");
    const bodies = mockFetch.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
    expect(bodies[0]).toMatchObject({ purpose: "reference" });
    expect(bodies[1]).toEqual({ uploadKey: "uploads/p1/k", name: "mẫu.mp4", reference: true });
    expect(bodies[2]).toEqual({ purpose: "file", name: "a.md", size: 1 });
    expect(bodies[3]).toEqual({ uploadKey: "uploads/p1/k", name: "a.md", dir: "context/notes" });
  });

  it("a library track: the admin's link, then the form with the key", async () => {
    const client = createStudioClient(async () => "t");
    mockFetch.mockResolvedValueOnce(json(LINK)).mockResolvedValueOnce(json({ trackId: "x" }));
    const file = new File(["ab"], "chợ.mp3", { type: "audio/mpeg" });
    await client.addMusic({ file, displayName: "Chợ", moods: ["upbeat"], origin: "own", originNote: "nhóm", loopOk: true });
    const [sign, add] = mockFetch.mock.calls.map(([url, init]) => [url, JSON.parse((init as RequestInit).body as string)]);
    expect(sign).toEqual([expect.stringMatching(/\/api\/studio\/music\/uploads$/), { name: "chợ.mp3", size: 2, contentType: "audio/mpeg" }]);
    expect(add![1]).toEqual({ displayName: "Chợ", moods: ["upbeat"], origin: "own", originNote: "nhóm", loopOk: true, uploadKey: "uploads/p1/k", name: "chợ.mp3" });
  });

  it("a bucket the page cannot reach (CORS) or that refuses says so, and Studio is not asked to take it", async () => {
    status = 0;
    const e = await putToBucket(LINK, new Blob(["x"])).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(StudioHttpError);
    expect((e as StudioHttpError).code).toBe("bucket_unreachable");
    expect((e as StudioHttpError).message).toContain("CORS");
    status = 403;
    expect(((await putToBucket(LINK, new Blob(["x"])).catch((x: unknown) => x)) as StudioHttpError).code).toBe("bucket_refused");

    const client = createWorkspaceClient(async () => "t");
    mockFetch.mockResolvedValue(json(LINK));
    await expect(client.uploadSource("p1", new File(["x"], "a.md"))).rejects.toBeInstanceOf(StudioHttpError);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("sends a type only when the browser knows a plain one", () => {
    expect(uploadType(new File(["x"], "a.mp3", { type: "audio/mpeg" }))).toEqual({ contentType: "audio/mpeg" });
    expect(uploadType(new File(["x"], "a.xyz"))).toEqual({});
    expect(uploadType(new File(["x"], "a.txt", { type: "text/plain;charset=utf-8" }))).toEqual({});
  });

  it("a batch's progress is counted by bytes", () => {
    const seen: number[] = [];
    const [a, b] = batchProgress([new File(["x"], "a"), new File(["xyz"], "b")], (x) => seen.push(x));
    a!(1);
    b!(0.5);
    b!(1);
    expect(seen).toEqual([0.25, 0.625, 1]);
  });
});
