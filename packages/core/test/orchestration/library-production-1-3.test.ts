import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_ROOT, loadProfile, loadWorkflow } from "../../src/index.js";

// Sub-project 5B Task 8: `library-production@1.3.0` replaces `cut`/`assemble` with the two built-in
// composition stages (`media-compose`, `media-render`) and gives `plan-edit` an optional `overlays` output
// (spec §6.1). Mirrors `library-production-1-2.test.ts`'s own structure.

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("library-production@1.2.0, @1.1.0 and @1.0.0 are byte-identical to before sub-project 5B", () => {
  // Recorded at the 5B Task 8 commit: these three releases must never move again. A failure here means a
  // released workflow was edited in place instead of a new version being cut.
  it("1.2.0 checksum is unchanged", () => {
    expect(sha256(join(HARNESS_ROOT, "workflows", "library-production@1.2.0", "workflow.yaml"))).toBe(
      "f51c49c15a0df1882e6f1ae4d8432963874691b70c2fb4b2f0f91701de6c58bf",
    );
  });
  it("1.1.0 checksum is unchanged", () => {
    expect(sha256(join(HARNESS_ROOT, "workflows", "library-production@1.1.0", "workflow.yaml"))).toBe(
      "203b19d296d1778eee71a89843194c5adc434d6e7f925ae16daf2392dbe97499",
    );
  });
  it("1.0.0 (unversioned legacy dir) checksum is unchanged", () => {
    expect(sha256(join(HARNESS_ROOT, "workflows", "library-production", "workflow.yaml"))).toBe(
      "37ce04fedcf6016b8af683368968c6079c744dc21380f73866b673cf4d14ae17",
    );
  });
  it("1.2.0 still has cut and assemble, and no composition stages", () => {
    const wf = loadWorkflow(HARNESS_ROOT, "library-production@1.2.0");
    const keys = wf.definition.stages.map((s) => s.key);
    expect(keys).toContain("cut");
    expect(keys).toContain("assemble");
    expect(keys).not.toContain("media-compose");
    expect(keys).not.toContain("media-render");
  });
});

describe("library-production@1.3.0", () => {
  const wf = loadWorkflow(HARNESS_ROOT, "library-production@1.3.0");
  const profile = loadProfile(HARNESS_ROOT, "studio");
  const stage = (key: string) => wf.definition.stages.find((s) => s.key === key)!;

  it("has the fifteen stages of spec §6.1 in order, none of them a gate, and no cut/assemble", () => {
    expect(wf.definition.stages.map((s) => s.key)).toEqual([
      "intake",
      "media-index",
      "media-transcribe",
      "watch-source",
      "survey-source",
      "plan-edit",
      "media-tts",
      "media-fit-edl",
      "media-compose",
      "media-render",
      "watch-episode",
      "thumbnail-candidates",
      "library-export",
      "library-review",
      "library-apply-review",
    ]);
    for (const s of wf.definition.stages) expect(s.executor.type, s.key).not.toBe("gate");
  });

  it("plan-edit declares overlays as an OPTIONAL output and requires overlays-valid", () => {
    const s = stage("plan-edit");
    const overlays = s.outputs.find((o) => o.type === "overlays")!;
    expect(overlays).toEqual({ type: "overlays", mime_type: "application/json", kind: "file", name: "overlays.json", optional: true });
    // every other output of this stage stays mandatory
    for (const o of s.outputs.filter((x) => x.type !== "overlays")) expect(o.optional, o.type).toBeUndefined();
    expect(s.required_checks).toContain("overlays-valid");
    expect(s.required_checks).toContain("edl-valid");
    expect(s.executor).toMatchObject({ type: "agent", skill: "edit-plan" });
    expect((s.executor as { brief: string }).brief).toContain("overlays.json");
  });

  it("media-compose is a cpu script stage after fit-edl/plan-edit/intake/media-index/media-tts", () => {
    const s = stage("media-compose");
    expect(s.executor).toEqual({ type: "script", script: "media-compose" });
    expect(s.depends_on.sort()).toEqual(["intake", "media-fit-edl", "media-index", "media-tts", "plan-edit"]);
    expect(s.requires_resources).toEqual(["cpu"]);
    expect(s.required_checks).toEqual(["schema-valid", "output-exists", "checksum-match", "composition-valid"]);
    expect(s.outputs.map((o) => o.type).sort()).toEqual(["captions", "composition", "overlay_ass"]);
    expect(s.outputs.find((o) => o.type === "captions")!.kind).toBe("directory");
  });

  it("media-render takes the gpu slot, retries on transient, and requires render-valid + clip-set-complete", () => {
    const s = stage("media-render");
    expect(s.executor).toEqual({ type: "script", script: "media-render" });
    expect(s.depends_on.sort()).toEqual(["intake", "media-compose", "media-fit-edl", "media-index", "media-tts"]);
    expect(s.requires_resources).toEqual(["gpu"]);
    expect(s.retry).toEqual({ max_attempts: 2, backoff_seconds: [60], retry_on: ["transient", "abandoned"] });
    expect(s.required_checks).toEqual([
      "schema-valid", "output-exists", "checksum-match", "media-probe", "duration-range",
      "audio-integrity", "brief-duration", "clip-set-complete", "render-valid",
    ]);
    expect(s.outputs.map((o) => o.type).sort()).toEqual(["clip_set", "episode_video", "render_report"]);
    expect(s.outputs.find((o) => o.type === "clip_set")!.kind).toBe("directory");
  });

  it("watch-episode and thumbnail-candidates hang off media-render", () => {
    expect(stage("watch-episode").depends_on).toEqual(["media-render"]);
    expect(stage("thumbnail-candidates").depends_on).toEqual(["media-render"]);
  });

  // `media-compose` is in `library-export`'s own depends_on, not merely transitive: stage inputs come from
  // DIRECTLY declared dependencies only (`acceptedInputsFor`), and the `captions` directory this stage
  // exports into the kho item is `media-compose`'s output, not `media-render`'s.
  it("library-export depends on media-render and media-compose (for the captions directory)", () => {
    const s = stage("library-export");
    expect(s.depends_on.sort()).toEqual(["intake", "media-compose", "media-render", "plan-edit", "thumbnail-candidates"]);
    expect(s.depends_on).not.toContain("assemble");
    expect(s.depends_on_optional).toEqual([]);
  });

  it("library-review reads the composition and the render report", () => {
    const s = stage("library-review");
    expect(s.executor).toMatchObject({ type: "agent", skill: "library-review" });
    expect(s.depends_on.sort()).toEqual(["intake", "library-export", "media-compose", "media-fit-edl", "media-render", "plan-edit", "watch-episode"]);
    const brief = (s.executor as { brief: string }).brief;
    expect(brief).toContain("composition.json");
    expect(brief).toContain("render-report.json");
  });

  it("profile studio points at library-production@1.3.0, revision 4, subtitles option carries the three real modes", () => {
    expect(profile.workflow_release).toBe("library-production@1.3.0");
    expect(profile.revision).toBe(4);
    expect(profile.options_schema.subtitles).toEqual(["burn-in", "karaoke", "none", "true", "false"]);
    // "true" == "the brand decides" -- see the profile's own comment for why this moved off "false".
    expect(profile.options_defaults.subtitles).toBe("true");
    expect(profile.overrides).toEqual({ default_deadline_seconds: 14400 });
  });
});
