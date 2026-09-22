import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { newId, type BrandProfile, type Checker, type MediaConfig, type MediaProbe, type MediaProber, type MusicTrack, type Overlays, type StageRequest, type StageResult, type Timeline } from "@harness/contracts";
import { compositionCheckers } from "../../src/index.js";
import { buildComposition, type ComposeInput } from "../../src/media/compose.js";
import type { LoadedBrand } from "../../src/library/brands.js";

const sha = "sha256:" + "a".repeat(64);
const SRC_A = "src_01JAAAAAAAAAAAAAAAAAAAAAAA";

class FakeMediaProber implements MediaProber {
  async probe(): Promise<MediaProbe | null> {
    return null;
  }
}

function baseRequest(overrides: Partial<StageRequest> = {}): StageRequest {
  return {
    schema_version: "harness.stage-request/v1",
    run_id: newId("run"),
    stage_run_id: newId("stage_run"),
    attempt_id: newId("attempt"),
    project_id: "p",
    portfolio_id: "pf",
    stage_key: "media-compose",
    workflow: { id: "library-production", version: "1.3.0", digest: sha },
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

function checker(): Checker {
  return checkerById(compositionCheckers({ prober: new FakeMediaProber() }), "composition-valid");
}

function brandProfileFixture(overrides: Partial<BrandProfile> = {}): BrandProfile {
  return {
    schema_version: "harness.brand/v1",
    channel_id: "ch1",
    revision: 1,
    fonts: { regular: "brands/ch1/fonts/Inter-Regular.ttf", bold: "brands/ch1/fonts/Inter-Bold.ttf", origin: "own", origin_note: "in-house" },
    colors: { primary: "#112233", text: "#FFFFFF", text_outline: "#000000", box: "#000000B3" },
    safe_margin_px: 120,
    text: {
      title: { size_px: 120, position: "top_left", box: true, animation: "slide_up", seconds: 4 },
      callout: { size_px: 160, position: "center", box: false, animation: "pop", seconds: 3 },
      lower_third: { size_px: 72, position: "bottom_left", box: true, animation: "fade", seconds: 5 },
    },
    subtitles: { mode: "burn-in", size_px: 88, position: "bottom_center", max_chars_per_line: 42, max_lines: 2, highlight_color: "#F2C94C" },
    transition: { kind: "cut", seconds: 0.4 },
    source_fit: "scale_pad",
    music: { tracks: ["calm-01"], gain_db: -18, duck_db: -12, duck_attack_ms: 150, duck_release_ms: 600 },
    checksums: {},
    ...overrides,
  };
}

function trackFixture(overrides: Partial<MusicTrack> = {}): MusicTrack {
  return {
    schema_version: "harness.music-track/v1",
    track_id: "calm-01",
    display_name: "Calm",
    file: "music/calm-01/track.mp3",
    mood: ["calm"],
    duration_seconds: 120,
    loop_ok: true,
    origin: "own",
    origin_note: "in-house",
    checksum: `sha256:${"a".repeat(64)}`,
    active: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** Builds a real composition (via `buildComposition`) over a workspace where every path it references
 * (`source_path`, narration wav, music path, logo path, brand fonts_dir) exists on disk -- `composition-valid`
 * checks those paths as literally stored, so the fixture has to be a real temp tree, not just JSON. */
function realComposition(tmp: string) {
  const fontsDir = join(tmp, "fonts");
  mkdirSync(fontsDir, { recursive: true });
  const logoPath = join(tmp, "logo.png");
  writeFileSync(logoPath, "png");
  const sourcePath = join(tmp, "source.mp4");
  writeFileSync(sourcePath, "mp4");
  const voiceSetDir = join(tmp, "voice");
  mkdirSync(voiceSetDir, { recursive: true });
  writeFileSync(join(voiceSetDir, "L001.wav"), "wav");
  const musicDir = join(tmp, "music", "calm-01");
  mkdirSync(musicDir, { recursive: true });
  const musicPath = join(musicDir, "track.mp3");
  writeFileSync(musicPath, "mp3");

  const brand: LoadedBrand = {
    brand: brandProfileFixture({ logo: { path: "logo.png", corner: "right", opacity: 0.8, height_px: 140 } }),
    dir: tmp,
    fonts_dir: fontsDir,
    font_regular_path: join(fontsDir, "Regular.ttf"),
    font_bold_path: join(fontsDir, "Bold.ttf"),
    logo_path: logoPath,
  };

  const timeline: Timeline = {
    schema_version: "harness.timeline/v1",
    voice: "tts",
    language: "en",
    total_seconds: 10,
    video: [
      { order: 0, source_id: SRC_A, in: 0, out: 5, start: 0, end: 5 },
      { order: 1, source_id: SRC_A, in: 5, out: 10, start: 5, end: 10 },
    ],
    narration: [
      {
        line_id: "L001",
        wav: "L001.wav",
        start: 0,
        end: 10,
        words: [
          { word: "Xin", start: 0, end: 1 },
          { word: "chao", start: 2, end: 3 },
          { word: "ban", start: 4, end: 5 },
        ],
      },
    ],
    speech: [],
  };

  const overlays: Overlays = {
    schema_version: "harness.overlays/v1",
    items: [{ id: "OV01", kind: "title", text: "Tieu de", anchor: { line_id: "L001" } }],
    transitions: [],
  };

  const render: MediaConfig["render"] = { codec: "h264", encoder: "auto", fps: 30, cache_max_gb: 60 };

  const composeInput: ComposeInput = {
    timeline,
    overlays,
    narration: null,
    edl: { schema_version: "harness.edl/v1", entries: [{ source_id: SRC_A, in: 0, out: 10, order: 0, overlay: null, note: "" }] },
    brand,
    tracks: [trackFixture()],
    trackPath: () => musicPath,
    sources: new Map([[SRC_A, { path: sourcePath, duration_seconds: 20, has_audio: true, fps: 30 }]]),
    voiceSetDir,
    request_id: newId("content_request"),
    render,
  };

  const built = buildComposition(composeInput);
  return { ...built, timeline };
}

/** Writes `input/timeline.json`, `output/composition.json`, `output/overlay.ass`, `output/captions/captions.srt`
 * -- the four files/dirs `composition-valid` reads -- and returns the request/result pointing at them. */
function writeWorkspace(ws: string, built: ReturnType<typeof realComposition>): { request: StageRequest; result: StageResult } {
  mkdirSync(join(ws, "input"), { recursive: true });
  mkdirSync(join(ws, "output", "captions"), { recursive: true });
  writeFileSync(join(ws, "input", "timeline.json"), JSON.stringify(built.timeline));
  writeFileSync(join(ws, "output", "composition.json"), JSON.stringify(built.composition));
  writeFileSync(join(ws, "output", "overlay.ass"), built.ass);
  writeFileSync(join(ws, "output", "captions", "captions.srt"), built.srt);

  const request = baseRequest({ inputs: [{ artifact_id: newId("artifact"), checksum: sha, path: "input/timeline.json", type: "timeline", kind: "file" }] });
  const result = baseResult([
    { path: "output/composition.json", type: "composition", checksum: sha, size_bytes: 1, kind: "file" },
    { path: "output/overlay.ass", type: "overlay_ass", checksum: sha, size_bytes: 1, kind: "file" },
    { path: "output/captions", type: "captions", checksum: sha, size_bytes: 1, kind: "directory" },
  ]);
  return { request, result };
}

function tmpWorkspace(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("composition-valid", () => {
  it("skips when there is no composition output", async () => {
    const ws = tmpWorkspace("composition-valid-ws-");
    const request = baseRequest();
    const result = baseResult([]);
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome).toEqual({ verdict: "skip", evidence: { reason: "no matching output" } });
    rmSync(ws, { recursive: true, force: true });
  });

  it("passes a composition built end-to-end from a real timeline/brand/music fixture", async () => {
    const ws = tmpWorkspace("composition-valid-ws-");
    const built = realComposition(ws);
    const { request, result } = writeWorkspace(ws, built);
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("pass");
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails naming the order when a segment's start drifts from the timeline by more than 1ms", async () => {
    const ws = tmpWorkspace("composition-valid-ws-");
    const built = realComposition(ws);
    const mutated = { ...built.composition, segments: built.composition.segments.map((s, i) => (i === 1 ? { ...s, start: s.start + 0.01, end: s.end + 0.01 } : s)) };
    const { request, result } = writeWorkspace(ws, { ...built, composition: mutated });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.order).toBe(1);
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails when overlay.ass is missing a Dialogue line", async () => {
    const ws = tmpWorkspace("composition-valid-ws-");
    const built = realComposition(ws);
    const lines = built.ass.split("\n");
    const firstDialogueIdx = lines.findIndex((l) => l.startsWith("Dialogue:"));
    lines.splice(firstDialogueIdx, 1);
    const { request, result } = writeWorkspace(ws, { ...built, ass: lines.join("\n") });
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("overlay_ass dialogue count mismatch");
    rmSync(ws, { recursive: true, force: true });
  });

  it("fails when a narration wav file is missing from disk", async () => {
    const ws = tmpWorkspace("composition-valid-ws-");
    const built = realComposition(ws);
    const { request, result } = writeWorkspace(ws, built);
    rmSync(join(ws, "voice", "L001.wav"));
    const outcome = await checker().check({ request, result, workspaceDir: ws });
    expect(outcome.verdict).toBe("fail");
    expect(outcome.evidence.reason).toBe("narration wav missing");
    rmSync(ws, { recursive: true, force: true });
  });
});
