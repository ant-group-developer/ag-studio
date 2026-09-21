import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type Checker, type CheckerInput, type MediaProbe, type MediaProber, type StageRequest, type StageResult } from "@harness/contracts";
import { mediaCheckers } from "../../src/verification/media-checkers.js";

const sha = "sha256:" + "a".repeat(64);

class FakeMediaProber implements MediaProber {
  constructor(
    private readonly probes: Map<string, MediaProbe | null>,
    private readonly silences: Map<string, number | null> = new Map(),
  ) {}
  async probe(path: string): Promise<MediaProbe | null> {
    return this.probes.get(path) ?? null;
  }
  async silenceRatio(path: string): Promise<number | null> {
    return this.silences.has(path) ? (this.silences.get(path) as number | null) : null;
  }
}

function videoProbe(duration_seconds: number, hasAudio = true): MediaProbe {
  return {
    media: { width: 1920, height: 1080, fps: 30, has_audio: hasAudio },
    duration_seconds,
    mime_type: "video/mp4",
    container: "mov,mp4,m4a,3gp,3g2,mj2",
    video: { codec: "h264", width: 1920, height: 1080, fps: 30 },
    audio: hasAudio ? { codec: "aac", channels: 2, sample_rate: 48000 } : null,
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
    stage_key: "assemble",
    workflow: { id: "w", version: "1.0.0", digest: sha },
    profile_snapshot: { id: "cartoon", revision: 1 },
    inputs: [],
    workspace_uri: "",
    stage_config: {},
    options: {},
    source_items: [],
    resources: [],
    expected_outputs: [],
    policy: {},
    limits: { deadline_at: "2026-09-11T01:00:00.000Z", max_cost_usd: 5, max_attempts: 3 },
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
  return mkdtempSync(join(tmpdir(), "media-checkers-"));
}

describe("mediaCheckers", () => {
  // I2: ffprobe missing on this machine (composition passes `available: FfprobeMediaProber.isAvailable()`).
  // The four prober-backed checkers skip with one uniform reason instead of failing against a NullMediaProber
  // that answers null for every file. `edl-valid` is exempt — it only parses JSON and cross-checks
  // request.source_items, so it must keep giving a real verdict.
  describe("without a media prober (available: false)", () => {
    it("skips the four prober-backed checkers with reason \"no media prober available\", without touching the outputs", async () => {
      const ws = tmpWorkspace(); // deliberately empty: a skipping checker must not read any file
      const request = baseRequest({
        expected_outputs: [{ type: "full_episode", mime_type: "video/mp4", kind: "file" }],
        policy: { target_duration_seconds: [1, 10], max_silence_ratio: 0.5 },
        inputs: [{ artifact_id: newId("artifact"), checksum: sha, path: "input/edl.json", type: "edl", kind: "file" }],
      });
      const result = baseResult([
        { path: "output/full-episode.mp4", type: "full_episode", checksum: sha, size_bytes: 1, kind: "file" },
        { path: "output/cuts", type: "clip_set", checksum: sha, size_bytes: 0, kind: "directory" },
      ]);
      const checkers = mediaCheckers(new FakeMediaProber(new Map()), { available: false });
      expect(checkers.map((c) => c.id)).toEqual(["media-probe", "duration-range", "audio-integrity", "clip-set-complete", "tts-valid", "edl-valid"]);
      for (const c of checkers.filter((c) => c.id !== "edl-valid")) {
        const outcome = await c.check({ request, result, workspaceDir: ws });
        expect(outcome, c.id).toEqual({ verdict: "skip", evidence: { reason: "no media prober available" } });
      }
      rmSync(ws, { recursive: true, force: true });
    });

    it("leaves edl-valid working: it needs no prober, so it still passes and fails on its own merits", async () => {
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"), { recursive: true });
      const sourceId = newId("source_item");
      const request = baseRequest({
        source_items: [{ source_id: sourceId, uri: "file:///a.mp4", checksum: sha, mime_type: "video/mp4", duration_seconds: 10 }],
      });
      const result = baseResult([{ path: "output/edl.json", type: "edl", checksum: sha, size_bytes: 1, kind: "file" }]);
      const checker = checkerById(mediaCheckers(new FakeMediaProber(new Map()), { available: false }), "edl-valid");

      writeFileSync(join(ws, "output", "edl.json"), JSON.stringify({ schema_version: "harness.edl/v1", entries: [{ source_id: sourceId, in: 0, out: 2, order: 0, overlay: null, note: "" }] }));
      expect((await checker.check({ request, result, workspaceDir: ws })).verdict).toBe("pass");

      writeFileSync(join(ws, "output", "edl.json"), JSON.stringify({ schema_version: "harness.edl/v1", entries: [{ source_id: newId("source_item"), in: 0, out: 2, order: 0, overlay: null, note: "" }] }));
      const unknown = await checker.check({ request, result, workspaceDir: ws });
      expect(unknown.verdict).toBe("fail");
      expect(unknown.evidence.reason).toBe("unknown source_id");
      rmSync(ws, { recursive: true, force: true });
    });

    it("still fails a present prober that cannot probe a file (a broken output, not a missing tool)", async () => {
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"));
      writeFileSync(join(ws, "output", "full-episode.mp4"), "x");
      const request = baseRequest({ expected_outputs: [{ type: "full_episode", mime_type: "video/mp4", kind: "file" }] });
      const result = baseResult([{ path: "output/full-episode.mp4", type: "full_episode", checksum: sha, size_bytes: 1, kind: "file" }]);
      // available defaults to true, and an explicit `true` behaves the same way
      for (const opts of [undefined, { available: true }]) {
        const checker = checkerById(mediaCheckers(new FakeMediaProber(new Map()), opts), "media-probe");
        expect((await checker.check({ request, result, workspaceDir: ws })).verdict).toBe("fail");
      }
      rmSync(ws, { recursive: true, force: true });
    });
  });

  describe("media-probe", () => {
    it("passes when the prober finds a stream, fails when it returns null", async () => {
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"));
      writeFileSync(join(ws, "output", "full-episode.mp4"), "x");
      const path = join(ws, "output", "full-episode.mp4");
      const request = baseRequest({ expected_outputs: [{ type: "full_episode", mime_type: "video/mp4", kind: "file" }] });
      const result = baseResult([{ path: "output/full-episode.mp4", type: "full_episode", checksum: sha, size_bytes: 1, kind: "file" }]);
      const input: CheckerInput = { request, result, workspaceDir: ws };

      const good = checkerById(mediaCheckers(new FakeMediaProber(new Map([[path, videoProbe(10)]]))), "media-probe");
      expect((await good.check(input)).verdict).toBe("pass");

      const bad = checkerById(mediaCheckers(new FakeMediaProber(new Map([[path, null]]))), "media-probe");
      expect((await bad.check(input)).verdict).toBe("fail");
      rmSync(ws, { recursive: true, force: true });
    });

    it("skips when no output has a video/audio mime", async () => {
      const ws = tmpWorkspace();
      const request = baseRequest({ expected_outputs: [{ type: "thumbnail", mime_type: "image/png", kind: "file" }] });
      const result = baseResult([{ path: "output/thumb.png", type: "thumbnail", checksum: sha, size_bytes: 1, kind: "file" }]);
      const checker = checkerById(mediaCheckers(new FakeMediaProber(new Map())), "media-probe");
      expect((await checker.check({ request, result, workspaceDir: ws })).verdict).toBe("skip");
      rmSync(ws, { recursive: true, force: true });
    });
  });

  describe("duration-range", () => {
    it("fails outside the policy range, skips when no policy is set", async () => {
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"));
      writeFileSync(join(ws, "output", "full-episode.mp4"), "x");
      const path = join(ws, "output", "full-episode.mp4");
      const request = baseRequest({
        expected_outputs: [{ type: "full_episode", mime_type: "video/mp4", kind: "file" }],
        policy: { target_duration_seconds: [1, 10] },
      });
      const result = baseResult([{ path: "output/full-episode.mp4", type: "full_episode", checksum: sha, size_bytes: 1, kind: "file" }]);
      const prober = new FakeMediaProber(new Map([[path, videoProbe(20)]]));
      const checker = checkerById(mediaCheckers(prober), "duration-range");
      const outOfRange = await checker.check({ request, result, workspaceDir: ws });
      expect(outOfRange.verdict).toBe("fail");
      expect(outOfRange.evidence.reason).toBe("duration out of range");

      const noPolicyRequest = baseRequest({ expected_outputs: request.expected_outputs });
      expect((await checker.check({ request: noPolicyRequest, result, workspaceDir: ws })).verdict).toBe("skip");
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails with a distinct reason when the probed duration is unknown", async () => {
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"));
      writeFileSync(join(ws, "output", "full-episode.mp4"), "x");
      const path = join(ws, "output", "full-episode.mp4");
      const request = baseRequest({
        expected_outputs: [{ type: "full_episode", mime_type: "video/mp4", kind: "file" }],
        policy: { target_duration_seconds: [1, 10] },
      });
      const result = baseResult([{ path: "output/full-episode.mp4", type: "full_episode", checksum: sha, size_bytes: 1, kind: "file" }]);
      const unknownDurationProbe: MediaProbe = { ...videoProbe(0), duration_seconds: null };
      const checker = checkerById(mediaCheckers(new FakeMediaProber(new Map([[path, unknownDurationProbe]]))), "duration-range");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.reason).toBe("duration unknown");
      rmSync(ws, { recursive: true, force: true });
    });
  });

  describe("audio-integrity", () => {
    it("fails without an audio stream, fails over the silence threshold, passes under it", async () => {
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"));
      writeFileSync(join(ws, "output", "full-episode.mp4"), "x");
      const path = join(ws, "output", "full-episode.mp4");
      const request = baseRequest({
        expected_outputs: [{ type: "full_episode", mime_type: "video/mp4", kind: "file" }],
        policy: { max_silence_ratio: 0.5 },
      });
      const result = baseResult([{ path: "output/full-episode.mp4", type: "full_episode", checksum: sha, size_bytes: 1, kind: "file" }]);

      const noAudio = checkerById(mediaCheckers(new FakeMediaProber(new Map([[path, videoProbe(10, false)]]))), "audio-integrity");
      expect((await noAudio.check({ request, result, workspaceDir: ws })).verdict).toBe("fail");

      const tooSilent = checkerById(
        mediaCheckers(new FakeMediaProber(new Map([[path, videoProbe(10)]]), new Map([[path, 0.95]]))),
        "audio-integrity",
      );
      expect((await tooSilent.check({ request, result, workspaceDir: ws })).verdict).toBe("fail");

      const fine = checkerById(
        mediaCheckers(new FakeMediaProber(new Map([[path, videoProbe(10)]]), new Map([[path, 0.1]]))),
        "audio-integrity",
      );
      expect((await fine.check({ request, result, workspaceDir: ws })).verdict).toBe("pass");
      rmSync(ws, { recursive: true, force: true });
    });
  });

  describe("clip-set-complete", () => {
    function edlFixture(ws: string) {
      mkdirSync(join(ws, "input"), { recursive: true });
      mkdirSync(join(ws, "output", "cuts"), { recursive: true });
      const sourceId = newId("source_item");
      const edl = {
        schema_version: "harness.edl/v1",
        entries: [
          { source_id: sourceId, in: 0, out: 2, order: 0, overlay: null, note: "" },
          { source_id: sourceId, in: 0, out: 3, order: 1, overlay: null, note: "" },
        ],
      };
      writeFileSync(join(ws, "input", "edl.json"), JSON.stringify(edl));
      const request = baseRequest({
        inputs: [{ artifact_id: newId("artifact"), checksum: sha, path: "input/edl.json", type: "edl", kind: "file" }],
      });
      const result = baseResult([{ path: "output/cuts", type: "clip_set", checksum: sha, size_bytes: 0, kind: "directory" }]);
      return { request, result, sourceId };
    }

    it("passes within tolerance, fails outside it, fails when a file is missing", async () => {
      const ws = tmpWorkspace();
      const { request, result } = edlFixture(ws);
      const p000 = join(ws, "output", "cuts", "000.mp4");
      const p001 = join(ws, "output", "cuts", "001.mp4");
      writeFileSync(p000, "x");
      writeFileSync(p001, "x");

      const okProber = new FakeMediaProber(new Map([[p000, videoProbe(2.0)], [p001, videoProbe(3.4)]]));
      const okChecker = checkerById(mediaCheckers(okProber), "clip-set-complete");
      expect((await okChecker.check({ request, result, workspaceDir: ws })).verdict).toBe("pass");

      const badProber = new FakeMediaProber(new Map([[p000, videoProbe(2.0)], [p001, videoProbe(3.6)]]));
      const badChecker = checkerById(mediaCheckers(badProber), "clip-set-complete");
      expect((await badChecker.check({ request, result, workspaceDir: ws })).verdict).toBe("fail");

      rmSync(p001);
      const missingChecker = checkerById(mediaCheckers(okProber), "clip-set-complete");
      const missing = await missingChecker.check({ request, result, workspaceDir: ws });
      expect(missing.verdict).toBe("fail");
      expect(missing.evidence.reason).toBe("missing");
      rmSync(ws, { recursive: true, force: true });
    });

    it("fails with a distinct reason when a clip's probed duration is unknown", async () => {
      const ws = tmpWorkspace();
      const { request, result } = edlFixture(ws);
      const p000 = join(ws, "output", "cuts", "000.mp4");
      const p001 = join(ws, "output", "cuts", "001.mp4");
      writeFileSync(p000, "x");
      writeFileSync(p001, "x");
      const unknownDurationProbe: MediaProbe = { ...videoProbe(0), duration_seconds: null };
      const prober = new FakeMediaProber(new Map([[p000, unknownDurationProbe], [p001, videoProbe(3.4)]]));
      const checker = checkerById(mediaCheckers(prober), "clip-set-complete");
      const outcome = await checker.check({ request, result, workspaceDir: ws });
      expect(outcome.verdict).toBe("fail");
      expect(outcome.evidence.reason).toBe("duration unknown");
      rmSync(ws, { recursive: true, force: true });
    });
  });

  describe("edl-valid", () => {
    it("passes a valid edl, fails an unknown source_id, fails in >= out", async () => {
      const ws = tmpWorkspace();
      mkdirSync(join(ws, "output"), { recursive: true });
      const sourceId = newId("source_item");
      const goodEdl = { schema_version: "harness.edl/v1", entries: [{ source_id: sourceId, in: 0, out: 2, order: 0, overlay: null, note: "" }] };
      writeFileSync(join(ws, "output", "edl.json"), JSON.stringify(goodEdl));
      const request = baseRequest({
        source_items: [{ source_id: sourceId, uri: "file:///a.mp4", checksum: sha, mime_type: "video/mp4", duration_seconds: 10 }],
      });
      const result = baseResult([{ path: "output/edl.json", type: "edl", checksum: sha, size_bytes: 1, kind: "file" }]);
      const checker = checkerById(mediaCheckers(new FakeMediaProber(new Map())), "edl-valid");
      expect((await checker.check({ request, result, workspaceDir: ws })).verdict).toBe("pass");

      const unknownEdl = { schema_version: "harness.edl/v1", entries: [{ source_id: newId("source_item"), in: 0, out: 2, order: 0, overlay: null, note: "" }] };
      writeFileSync(join(ws, "output", "edl.json"), JSON.stringify(unknownEdl));
      expect((await checker.check({ request, result, workspaceDir: ws })).verdict).toBe("fail");

      const badEdl = { schema_version: "harness.edl/v1", entries: [{ source_id: sourceId, in: 2, out: 1, order: 0, overlay: null, note: "" }] };
      writeFileSync(join(ws, "output", "edl.json"), JSON.stringify(badEdl));
      expect((await checker.check({ request, result, workspaceDir: ws })).verdict).toBe("fail");
      rmSync(ws, { recursive: true, force: true });
    });
  });
});
