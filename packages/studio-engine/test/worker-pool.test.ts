/**
 * The Studio worker: `STUDIO_CLAUDE_MAX_CONCURRENT` and the web setting over it, what kinds of project jobs a worker
 * takes with the tools it has, and a pool that stops when asked.
 */
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeCap, createStudioWorkerPool, DEFAULT_CLAUDE_MAX_CONCURRENT, parseClaudeMaxConcurrent, projectJobHandlers, setClaudeMaxConcurrent,
  type CutMediaDeps, type YtDlp,
} from "../src/index.js";
import { fakeFarm, fakeThumbnails, world } from "./helpers.js";

describe("parseClaudeMaxConcurrent", () => {
  it("defaults to 20 when unset or blank", () => {
    expect(DEFAULT_CLAUDE_MAX_CONCURRENT).toBe(20);
    expect(parseClaudeMaxConcurrent(undefined)).toBe(20);
    expect(parseClaudeMaxConcurrent("  ")).toBe(20);
  });

  it("accepts a whole number from 1 to 100", () => {
    expect(parseClaudeMaxConcurrent("1")).toBe(1);
    expect(parseClaudeMaxConcurrent(" 7 ")).toBe(7);
    expect(parseClaudeMaxConcurrent("100")).toBe(100);
  });

  it("refuses anything else instead of falling back silently", () => {
    for (const bad of ["0", "-1", "101", "2.5", "abc", "20x"]) {
      expect(() => parseClaudeMaxConcurrent(bad)).toThrow(/STUDIO_CLAUDE_MAX_CONCURRENT/);
    }
  });
});

describe("the worker pool", () => {
  let w: ReturnType<typeof world>;
  afterEach(() => w?.core.close());
  const base = () => ({ db: w.db, bucket: w.bucket, farm: fakeFarm(w.bucket) as never, owner: "w", dataRoot: join(w.dir, "data") });
  const media: CutMediaDeps = {
    ffmpeg: "ffmpeg", ffprobe: "ffprobe", voiceDir: "voice",
    resolveAssets: async () => ({ items: [], missing: [] }), download: async () => {},
  };
  const preps = { read: async () => ({ items: [] }), run: async () => ({ items: [] }) };

  it("caps Claude calls at the env value until someone saves one on the web", () => {
    w = world();
    expect(claudeCap({ db: w.db })).toBe(20);
    expect(claudeCap({ db: w.db, claudeMaxConcurrent: 3 })).toBe(3);
    setClaudeMaxConcurrent(w.db, 5, "auth0|admin", new Date().toISOString());
    expect(claudeCap({ db: w.db, claudeMaxConcurrent: 3 })).toBe(5);
  });

  it("takes only the kinds of jobs it has the tools for", () => {
    w = world();
    expect(Object.keys(projectJobHandlers(base()))).toEqual([]);
    expect(Object.keys(projectJobHandlers({ ...base(), youtubeApiKey: "k" }))).toEqual(["research"]);
    // inputs come prepared from ag-go: no ffmpeg needed
    expect(Object.keys(projectJobHandlers({ ...base(), preps }))).toEqual(["prepare_asset"]);
    expect(Object.keys(projectJobHandlers({ ...base(), media, thumbnails: fakeThumbnails() })).sort())
      .toEqual(["export_premiere", "fit", "render_final", "render_preview", "style_watch", "thumbnail"]); // uploaded reference videos need only ffmpeg
    const ytdlp = {} as YtDlp;
    expect(Object.keys(projectJobHandlers({ ...base(), media, preps, ytdlp })).sort())
      .toEqual(["export_premiere", "fit", "prepare_asset", "render_final", "render_preview", "research", "style_watch"]);
    // reference downloads turned off: uploaded reference videos are still watched (YouTube ones say why not)
    expect(Object.keys(projectJobHandlers({ ...base(), media, ytdlp, referenceDownloads: false }))).toContain("style_watch");
  });

  it("runs only the loops it was given and stops when asked", async () => {
    w = world();
    const idle = createStudioWorkerPool(base());
    expect([idle.agent, idle.jobs]).toEqual([null, null]);
    const pool = createStudioWorkerPool({ ...base(), jobs: { workspacesRoot: join(w.dir, "workspaces"), pollMs: 20 }, cleanup: { everyMs: 0 } });
    expect(pool.jobs).not.toBeNull();
    const ac = new AbortController();
    const running = pool.runForever(ac.signal);
    await new Promise((r) => setTimeout(r, 60));
    ac.abort();
    await expect(running).resolves.toBeUndefined();
  });

  it("sends the usage outbox to ag-go on its timer while it runs", async () => {
    w = world();
    w.db.run("INSERT INTO ag_go_usage_outbox (event_key, payload, created_at, next_at) VALUES ('src:s1:added', ?, '2026-10-13T00:00:00.000Z', '2026-10-13T00:00:00.000Z')", [JSON.stringify({
      eventKey: "src:s1:added", kind: "source_added", occurredAt: "2026-10-13T00:00:00.000Z", assetId: "00000000-0000-4000-8000-000000000001", agGoProjectId: null,
      studioProjectId: "p1", studioProjectName: "A", studioVideoId: null, studioVideoTitle: null, studioUserId: "auth0|u",
    })]);
    const sent: string[] = [];
    const pool = createStudioWorkerPool({ ...base(), usage: { sink: { send: async (events) => { sent.push(...events.map((e) => e.eventKey)); return { accepted: events.length, duplicates: 0 }; } }, everyMs: 20 } });
    const ac = new AbortController();
    const running = pool.runForever(ac.signal);
    await new Promise((r) => setTimeout(r, 120));
    ac.abort();
    await running;
    expect(sent).toEqual(["src:s1:added"]);
  });
});
