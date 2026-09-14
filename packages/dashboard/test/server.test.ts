import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { hubHtmlPath, startDashboard, type DashboardServerHandle } from "../src/index.js";

describe("startDashboard", () => {
  let dataRoot: string;
  let handle: DashboardServerHandle;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), "dashboard-srv-"));
  });

  afterEach(async () => {
    // the "close() stops the server" test below already closes its own handle
    try { await handle?.close(); } catch { /* already closed */ }
  });

  it("binds 127.0.0.1 on an ephemeral port and reports it back", async () => {
    handle = await startDashboard({ dataRoot, port: 0 });
    expect(handle.port).toBeGreaterThan(0);
    expect(handle.url).toBe(`http://127.0.0.1:${handle.port}`);
  });

  it("/api/snapshot is 404 before a snapshot exists, then 200 with no-store after one is written", async () => {
    handle = await startDashboard({ dataRoot, port: 0 });

    const before = await fetch(`${handle.url}/api/snapshot`);
    expect(before.status).toBe(404);
    expect((await before.json()).error).toBe("no snapshot");

    mkdirSync(join(dataRoot, "dashboard"), { recursive: true });
    writeFileSync(join(dataRoot, "dashboard", "snapshot.json"), JSON.stringify({ schema_version: "harness.dashboard-snapshot/v1" }));

    const after = await fetch(`${handle.url}/api/snapshot`);
    expect(after.status).toBe(200);
    expect(after.headers.get("cache-control")).toBe("no-store");
    expect((await after.json()).schema_version).toBe("harness.dashboard-snapshot/v1");
  });

  it("/ and /hub serve hub.html as text/html", async () => {
    handle = await startDashboard({ dataRoot, port: 0 });
    for (const path of ["/", "/hub"]) {
      const r = await fetch(`${handle.url}${path}`);
      expect(r.status).toBe(200);
      expect(r.headers.get("content-type")).toContain("text/html");
      expect(await r.text()).toContain("<title>");
    }
  });

  it("/thumbnails/a.png serves the file with an image content-type; a missing one is 404", async () => {
    handle = await startDashboard({ dataRoot, port: 0 });
    mkdirSync(join(dataRoot, "dashboard", "thumbnails"), { recursive: true });
    writeFileSync(join(dataRoot, "dashboard", "thumbnails", "a.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const ok = await fetch(`${handle.url}/thumbnails/a.png`);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toContain("image/png");

    const missing = await fetch(`${handle.url}/thumbnails/missing.png`);
    expect(missing.status).toBe(404);
  });

  it("/thumbnails/../snapshot.json cannot escape the thumbnails dir (basename applied) -- 404", async () => {
    handle = await startDashboard({ dataRoot, port: 0 });
    mkdirSync(join(dataRoot, "dashboard"), { recursive: true });
    writeFileSync(join(dataRoot, "dashboard", "snapshot.json"), "{}");

    const r = await fetch(`${handle.url}/thumbnails/../snapshot.json`);
    expect(r.status).toBe(404);
  });

  it("an unknown route is 404", async () => {
    handle = await startDashboard({ dataRoot, port: 0 });
    const r = await fetch(`${handle.url}/x`);
    expect(r.status).toBe(404);
  });

  it("a write method is rejected -- POST /api/snapshot is 405 with Allow: GET", async () => {
    handle = await startDashboard({ dataRoot, port: 0 });
    const r = await fetch(`${handle.url}/api/snapshot`, { method: "POST" });
    expect(r.status).toBe(405);
    expect(r.headers.get("allow")).toBe("GET");
  });

  it("close() stops the server", async () => {
    handle = await startDashboard({ dataRoot, port: 0 });
    const url = handle.url;
    await handle.close();
    await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toBeTruthy();
  });
});

describe("hubHtmlPath", () => {
  it("resolves to packages/dashboard/public/hub.html regardless of src/ vs dist/", () => {
    expect(hubHtmlPath().replace(/\\/g, "/")).toMatch(/packages\/dashboard\/public\/hub\.html$/);
  });
});
