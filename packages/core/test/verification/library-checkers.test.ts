import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  newId,
  type Checker,
  type CheckerInput,
  type ContentItem,
  type LibraryBrief,
  type MediaProbe,
  type MediaProber,
  type Run,
  type StageRequest,
  type StageResult,
} from "@harness/contracts";
import { exportItem, LibraryFs, libraryCheckers } from "../../src/index.js";
import { openTempStore } from "../helpers.js";

const sha = "sha256:" + "a".repeat(64);

class FakeMediaProber implements MediaProber {
  constructor(private readonly probes: Map<string, MediaProbe | null>) {}
  async probe(path: string): Promise<MediaProbe | null> {
    return this.probes.get(path) ?? null;
  }
}

function videoProbe(duration_seconds: number | null): MediaProbe {
  return {
    media: null,
    duration_seconds,
    mime_type: "video/mp4",
    container: null,
    video: null,
    audio: null,
  };
}

function baseRequest(overrides: Partial<StageRequest> = {}): StageRequest {
  return {
    schema_version: "harness.stage-request/v1",
    run_id: newId("run"),
    stage_run_id: newId("stage_run"),
    attempt_id: newId("attempt"),
    project_id: "p",
    portfolio_id: "pf",
    stage_key: "library-export",
    workflow: { id: "library-production", version: "1.0.0", digest: sha },
    profile_snapshot: { id: "studio", revision: 1 },
    inputs: [],
    workspace_uri: "",
    stage_config: {},
    options: {},
    source_items: [],
    resources: [],
    expected_outputs: [],
    policy: {},
    limits: { deadline_at: "2026-09-14T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 },
    capabilities: [],
    fencing_token: 1,
    ...overrides,
  };
}

function baseResult(outputs: StageResult["outputs"]): StageResult {
  return {
    schema_version: "harness.stage-result/v1",
    attempt_id: newId("attempt"),
    outcome: "succeeded",
    outputs,
    checks: [],
    usage: { wall_seconds: 1, cost_usd: 0 },
    external_operations: [],
    errors: [],
  };
}

function checkerById(checkers: Checker[], id: string): Checker {
  const c = checkers.find((c) => c.id === id);
  if (!c) throw new Error(`no checker ${id}`);
  return c;
}

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "library-checkers-ws-"));
}

describe("libraryCheckers", () => {
  // sub-project 5A task 3: survey-valid registers inside this same factory, so the exact-count assertion
  // below grew a third id (was ["brief-duration", "library-export-valid"] before this task).
  it("returns brief-duration, library-export-valid, and survey-valid, in that order", () => {
    const checkers = libraryCheckers(new FakeMediaProber(new Map()));
    expect(checkers.map((c) => c.id)).toEqual(["brief-duration", "library-export-valid", "survey-valid"]);
    expect(checkers.every((c) => c.version === "1.0.0")).toBe(true);
  });

  describe("brief-duration", () => {
    function fixture(ws: string, brief: Partial<LibraryBrief> & { topic: string; style_id: string; style_revision: number }) {
      mkdirSync(join(ws, "input"), { recursive: true });
      mkdirSync(join(ws, "output"), { recursive: true });
      writeFileSync(join(ws, "input", "brief.json"), JSON.stringify(brief));
      writeFileSync(join(ws, "output", "full-episode.mp4"), "x");
      const request = baseRequest({
        expected_outputs: [{ type: "episode_video", mime_type: "video/mp4", kind: "file" }],
        inputs: [{ artifact_id: newId("artifact"), checksum: sha, path: "input/brief.json", type: "brief", kind: "file" }],
      });
      const result = baseResult([{ path: "output/full-episode.mp4", type: "episode_video", checksum: sha, size_bytes: 1, kind: "file" }]);
      return { request, result, episodePath: join(ws, "output", "full-episode.mp4") };
    }

    it("passes when the probed duration is within the brief's target range", async () => {
      const ws = tmpWorkspace();
      const { request, result, episodePath } = fixture(ws, { topic: "t", style_id: newId("edit_style"), style_revision: 1, target_duration_seconds: [5, 20] });
      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map([[episodePath, videoProbe(12)]]))), "brief-duration");
      const outcome = await checker.check({ request, result, workspaceDir: ws } satisfies CheckerInput);
      expect(outcome).toEqual({ verdict: "pass", evidence: { checked: ["output/full-episode.mp4"] } });
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails with duration out of range when the probed duration falls outside the brief's window", async () => {
      const ws = tmpWorkspace();
      const { request, result, episodePath } = fixture(ws, { topic: "t", style_id: newId("edit_style"), style_revision: 1, target_duration_seconds: [5, 20] });
      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map([[episodePath, videoProbe(30)]]))), "brief-duration");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.reason).toBe("duration out of range");
      expect(outcome.evidence.duration).toBe(30);
      expect(outcome.evidence.range).toEqual([5, 20]);
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails with duration unknown when the prober cannot probe the episode", async () => {
      const ws = tmpWorkspace();
      const { request, result, episodePath } = fixture(ws, { topic: "t", style_id: newId("edit_style"), style_revision: 1, target_duration_seconds: [5, 20] });
      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map([[episodePath, videoProbe(null)]]))), "brief-duration");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.reason).toBe("duration unknown");
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails with a JSON reason when brief.json is not valid JSON", async () => {
      const ws = tmpWorkspace();
      const { request, result } = fixture(ws, { topic: "t", style_id: newId("edit_style"), style_revision: 1, target_duration_seconds: [5, 20] });
      writeFileSync(join(ws, "input", "brief.json"), "{ not valid json");
      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map())), "brief-duration");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.reason).toContain("JSON");
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails with a schema reason when brief.json does not match the brief schema", async () => {
      const ws = tmpWorkspace();
      const { request, result } = fixture(ws, { topic: "t", style_id: newId("edit_style"), style_revision: 1, target_duration_seconds: [5, 20] });
      // style_id must match the edit_style id pattern; this one does not, so schema validation fails
      writeFileSync(join(ws, "input", "brief.json"), JSON.stringify({ topic: "t", style_id: "not-a-valid-style-id", style_revision: 1, target_duration_seconds: [5, 20] }));
      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map())), "brief-duration");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.reason).toContain("schema");
      rmSync(ws, { recursive: true, force: true });
    });

    it("tolerates an extra style_snapshot field on brief.json (passthrough) and still passes", async () => {
      const ws = tmpWorkspace();
      const { request, result, episodePath } = fixture(ws, { topic: "t", style_id: newId("edit_style"), style_revision: 1, target_duration_seconds: [5, 20] });
      const briefWithSnapshot = {
        topic: "t", style_id: newId("edit_style"), style_revision: 1, target_duration_seconds: [5, 20],
        style_snapshot: { name: "fast-cut", params: { cut_rhythm: "fast" } },
      };
      writeFileSync(join(ws, "input", "brief.json"), JSON.stringify(briefWithSnapshot));
      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map([[episodePath, videoProbe(12)]]))), "brief-duration");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("pass");
      rmSync(ws, { recursive: true, force: true });
    });

    it("skips when there is no episode_video output", async () => {
      const ws = tmpWorkspace();
      const request = baseRequest();
      const result = baseResult([{ path: "output/thumb.png", type: "thumbnail", checksum: sha, size_bytes: 1, kind: "file" }]);
      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map())), "brief-duration");
      expect(await checker.check({ request, result, workspaceDir: ws })).toEqual({ verdict: "skip", evidence: { reason: "no matching output" } });
      rmSync(ws, { recursive: true, force: true });
    });

    it("skips when there is no brief input", async () => {
      const ws = tmpWorkspace();
      const request = baseRequest({ expected_outputs: [{ type: "episode_video", mime_type: "video/mp4", kind: "file" }] });
      const result = baseResult([{ path: "output/full-episode.mp4", type: "episode_video", checksum: sha, size_bytes: 1, kind: "file" }]);
      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map())), "brief-duration");
      expect(await checker.check({ request, result, workspaceDir: ws })).toEqual({ verdict: "skip", evidence: { reason: "no brief input" } });
      rmSync(ws, { recursive: true, force: true });
    });

    it("skips when the brief declares no target_duration_seconds", async () => {
      const ws = tmpWorkspace();
      const { request, result } = fixture(ws, { topic: "t", style_id: newId("edit_style"), style_revision: 1 });
      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map())), "brief-duration");
      expect(await checker.check({ request, result, workspaceDir: ws })).toEqual({ verdict: "skip", evidence: { reason: "no target_duration_seconds" } });
      rmSync(ws, { recursive: true, force: true });
    });

    it("skips with 'no media prober available' when available:false, even with a valid target duration", async () => {
      const ws = tmpWorkspace();
      const { request, result } = fixture(ws, { topic: "t", style_id: newId("edit_style"), style_revision: 1, target_duration_seconds: [5, 20] });
      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map()), { available: false }), "brief-duration");
      expect(await checker.check({ request, result, workspaceDir: ws })).toEqual({ verdict: "skip", evidence: { reason: "no media prober available" } });
      rmSync(ws, { recursive: true, force: true });
    });

    // Final-review Critical 1: with a `fit_report` input (library-production@1.2.0 only), an out-of-range
    // duration is an EDITORIAL verdict, not a machine fault -- `library-review` already rejects on
    // `within_target === false`, which reopens the request and lets the SP4 replan loop run. Failing the
    // stage here instead would fail the whole run and strand the request at `claimed`.
    describe("with a fit_report input (workflow 1.2.0)", () => {
      /** `fixture` plus a `fit_report` input whose body is `fitReport` (already stringified by the caller). */
      function withFitReport(ws: string, body: string) {
        const f = fixture(ws, { topic: "t", style_id: newId("edit_style"), style_revision: 1, target_duration_seconds: [5, 20] });
        writeFileSync(join(ws, "input", "fit-report.json"), body);
        const request = baseRequest({
          expected_outputs: f.request.expected_outputs,
          inputs: [
            ...f.request.inputs,
            { artifact_id: newId("artifact"), checksum: sha, path: "input/fit-report.json", type: "fit_report", kind: "file" },
          ],
        });
        return { ...f, request };
      }

      const fitReportBody = (within_target: boolean): string =>
        JSON.stringify({
          schema_version: "harness.fit-report/v1", voice: "tts", entries: [], shortfalls: [], reused_seconds: 0,
          warnings: [], total_seconds: 30, target_duration_seconds: [5, 20], within_target,
        });

      it("still passes as before when the probed duration is within the brief's range", async () => {
        const ws = tmpWorkspace();
        const { request, result, episodePath } = withFitReport(ws, fitReportBody(true));
        const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map([[episodePath, videoProbe(12)]]))), "brief-duration");
        expect(await checker.check({ request, result, workspaceDir: ws })).toEqual({ verdict: "pass", evidence: { checked: ["output/full-episode.mp4"] } });
        rmSync(ws, { recursive: true, force: true });
      });

      it("passes an out-of-range duration and defers the verdict to library-review", async () => {
        const ws = tmpWorkspace();
        const { request, result, episodePath } = withFitReport(ws, fitReportBody(false));
        const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map([[episodePath, videoProbe(30)]]))), "brief-duration");
        const outcome = await checker.check({ request, result, workspaceDir: ws });
        expect(outcome).toEqual({
          verdict: "pass",
          evidence: { reason: "deferred to library-review", within_target: false, duration_seconds: 30, target: [5, 20] },
        });
        rmSync(ws, { recursive: true, force: true });
      });

      it("still fails an out-of-range duration when the fit report does not parse", async () => {
        const ws = tmpWorkspace();
        const { request, result, episodePath } = withFitReport(ws, "{ not a fit report");
        const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map([[episodePath, videoProbe(30)]]))), "brief-duration");
        const outcome = await checker.check({ request, result, workspaceDir: ws });
        expect(outcome.verdict).toBe("fail");
        expect(outcome.evidence.reason).toBe("duration out of range");
        rmSync(ws, { recursive: true, force: true });
      });

      it("still fails an out-of-range duration when the fit report is valid JSON of the wrong shape", async () => {
        const ws = tmpWorkspace();
        const { request, result, episodePath } = withFitReport(ws, JSON.stringify({ schema_version: "harness.fit-report/v1" }));
        const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map([[episodePath, videoProbe(30)]]))), "brief-duration");
        const outcome = await checker.check({ request, result, workspaceDir: ws });
        expect(outcome.verdict).toBe("fail");
        expect(outcome.evidence.reason).toBe("duration out of range");
        rmSync(ws, { recursive: true, force: true });
      });

      it("still fails duration unknown with a fit report present", async () => {
        const ws = tmpWorkspace();
        const { request, result, episodePath } = withFitReport(ws, fitReportBody(false));
        const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map([[episodePath, videoProbe(null)]]))), "brief-duration");
        const outcome = await checker.check({ request, result, workspaceDir: ws });
        expect(outcome.verdict).toBe("fail");
        expect(outcome.evidence.reason).toBe("duration unknown");
        rmSync(ws, { recursive: true, force: true });
      });
    });
  });

  describe("library-export-valid", () => {
    async function fixture() {
      const koRoot = mkdtempSync(join(tmpdir(), "library-checkers-kho-"));
      const srcRoot = mkdtempSync(join(tmpdir(), "library-checkers-src-"));
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"), { recursive: true });

      const episodePath = join(srcRoot, "episode.mp4");
      writeFileSync(episodePath, "episode-bytes");
      const thumbPath = join(srcRoot, "thumb.png");
      writeFileSync(thumbPath, "thumb-bytes");
      const editPlanPath = join(srcRoot, "plan.json");
      writeFileSync(editPlanPath, JSON.stringify({ ok: true }));

      const fs = new LibraryFs({ root: koRoot, role: "studio" });
      const { store, clock } = openTempStore();
      const prober = new FakeMediaProber(new Map());
      const run: Run = {
        schema_version: "harness.run/v1", run_id: newId("run"), project_id: "project-studio", portfolio_id: "portfolio-a",
        workflow_release: { id: "library-production", version: "1.0.0", digest: sha }, profile_snapshot: { id: "studio", revision: 1 },
        options: {}, state: "RUNNING", effective_config_snapshot: {}, effective_config_digest: sha, total_cost_usd: 0,
        created_at: "2026-09-14T00:00:00.000Z", updated_at: "2026-09-14T00:00:00.000Z",
      };
      const content: ContentItem = {
        schema_version: "harness.content-item/v1", content_id: newId("content_item"), source_ids: [],
        revision: 1, title: "ruins", created_at: "2026-09-14T00:00:00.000Z",
      };
      const brief: LibraryBrief = { topic: "ruins", style_id: newId("edit_style"), style_revision: 1, voice: "none", language: "vi" };

      const { receipt } = await exportItem({ store, fs, clock, prober }, {
        run, content, brief, episodePath, thumbnailPaths: [thumbPath], editPlanPath,
      });

      writeFileSync(join(ws, "output", "export-receipt.json"), JSON.stringify(receipt));
      const request = baseRequest();
      const result = baseResult([{ path: "output/export-receipt.json", type: "export_receipt", checksum: sha, size_bytes: 1, kind: "file" }]);
      return { ws, koRoot, srcRoot, request, result, receipt };
    }

    it("passes when every receipt file matches the kho and the manifest checksum is correct", async () => {
      const { ws, koRoot, srcRoot, request, result, receipt } = await fixture();
      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map())), "library-export-valid");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome).toEqual({ verdict: "pass", evidence: { checked: [receipt.item_dir] } });
      rmSync(ws, { recursive: true, force: true });
      rmSync(koRoot, { recursive: true, force: true });
      rmSync(srcRoot, { recursive: true, force: true });
    });

    it("fails with the file's path when a kho file is altered after export (checksum mismatch)", async () => {
      const { ws, koRoot, srcRoot, request, result, receipt } = await fixture();
      const alteredPath = join(receipt.item_dir, "episode.mp4");
      writeFileSync(alteredPath, "tampered-bytes");

      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map())), "library-export-valid");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.path).toBe(alteredPath);
      expect(outcome.evidence.reason).toBe("checksum mismatch");

      rmSync(ws, { recursive: true, force: true });
      rmSync(koRoot, { recursive: true, force: true });
      rmSync(srcRoot, { recursive: true, force: true });
    });

    it("fails when a receipt file is missing from the kho", async () => {
      const { ws, koRoot, srcRoot, request, result, receipt } = await fixture();
      const missingPath = join(receipt.item_dir, "thumbnail-01.png");
      rmSync(missingPath);

      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map())), "library-export-valid");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.path).toBe(missingPath);
      expect(outcome.evidence.reason).toBe("missing file");

      rmSync(ws, { recursive: true, force: true });
      rmSync(koRoot, { recursive: true, force: true });
      rmSync(srcRoot, { recursive: true, force: true });
    });

    it("fails when manifest.json no longer digests to manifest_checksum", async () => {
      const { ws, koRoot, srcRoot, request, result, receipt } = await fixture();
      const manifestPath = join(receipt.item_dir, "manifest.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.summary = "tampered summary";
      writeFileSync(manifestPath, JSON.stringify(manifest));

      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map())), "library-export-valid");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.path).toBe(manifestPath);
      expect(outcome.evidence.reason).toBe("manifest checksum mismatch");

      rmSync(ws, { recursive: true, force: true });
      rmSync(koRoot, { recursive: true, force: true });
      rmSync(srcRoot, { recursive: true, force: true });
    });

    it("skips when there is no export_receipt output", async () => {
      const ws = tmpWorkspace();
      const request = baseRequest();
      const result = baseResult([{ path: "output/thumb.png", type: "thumbnail", checksum: sha, size_bytes: 1, kind: "file" }]);
      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map())), "library-export-valid");
      expect(await checker.check({ request, result, workspaceDir: ws })).toEqual({ verdict: "skip", evidence: { reason: "no matching output" } });
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails with a structured 'invalid receipt' reason instead of throwing when the receipt JSON is malformed", async () => {
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"), { recursive: true });
      const receiptPath = join(ws, "output", "export-receipt.json");
      writeFileSync(receiptPath, JSON.stringify({}));
      const request = baseRequest();
      const result = baseResult([{ path: "output/export-receipt.json", type: "export_receipt", checksum: sha, size_bytes: 1, kind: "file" }]);
      const checker = checkerById(libraryCheckers(new FakeMediaProber(new Map())), "library-export-valid");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.path).toBe(receiptPath);
      expect(outcome.evidence.reason).toMatch(/^invalid receipt: /);
      rmSync(ws, { recursive: true, force: true });
    });
  });
});
