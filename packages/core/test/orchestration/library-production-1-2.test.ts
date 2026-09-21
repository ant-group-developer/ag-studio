import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HARNESS_ROOT, loadProfile, loadWorkflow } from "../../src/index.js";

// Sub-project 5A Task 8: `library-production@1.2.0` wires the four built-in media stages
// (media-index/media-transcribe/media-tts/media-fit-edl) into the studio pipeline (spec §4.3). This mirrors
// `studio-workflows-1-1.test.ts`'s own `describe("library-production@1.1.0", ...)` block.

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

describe("library-production@1.1.0 and @1.0.0 are byte-identical to before task 8", () => {
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
});

describe("library-production@1.2.0", () => {
  const wf = loadWorkflow(HARNESS_ROOT, "library-production@1.2.0");
  const profile = loadProfile(HARNESS_ROOT, "studio");

  it("has the fifteen stages of spec §4.3 order, none of them a gate", () => {
    expect(wf.definition.stages.map((s) => s.key)).toEqual([
      "intake",
      "media-index",
      "media-transcribe",
      "watch-source",
      "survey-source",
      "plan-edit",
      "media-tts",
      "media-fit-edl",
      "cut",
      "assemble",
      "watch-episode",
      "thumbnail-candidates",
      "library-export",
      "library-review",
      "library-apply-review",
    ]);
    for (const s of wf.definition.stages) expect(s.executor.type, s.key).not.toBe("gate");
  });

  it("media-index runs after intake and produces shots + proxy_set", () => {
    const s = wf.definition.stages.find((st) => st.key === "media-index")!;
    expect(s.executor).toEqual({ type: "script", script: "media-index" });
    expect(s.depends_on).toEqual(["intake"]);
    expect(s.requires_resources).toEqual(["cpu"]);
    expect(s.outputs.map((o) => o.type).sort()).toEqual(["proxy_set", "shots"]);
  });

  it("media-transcribe runs after media-index on gpu with a retry policy, produces transcript", () => {
    const s = wf.definition.stages.find((st) => st.key === "media-transcribe")!;
    expect(s.executor).toEqual({ type: "script", script: "media-transcribe" });
    expect(s.depends_on).toEqual(["media-index"]);
    expect(s.requires_resources).toEqual(["gpu"]);
    expect(s.retry).toEqual({ max_attempts: 2, backoff_seconds: [60], retry_on: ["transient", "abandoned"] });
    expect(s.outputs.map((o) => o.type)).toEqual(["transcript"]);
  });

  it("watch-source depends on media-index and media-transcribe", () => {
    const s = wf.definition.stages.find((st) => st.key === "watch-source")!;
    expect(s.depends_on.sort()).toEqual(["media-index", "media-transcribe"]);
  });

  it("survey-source depends on media-index/media-transcribe/watch-source/intake and requires survey-valid", () => {
    const s = wf.definition.stages.find((st) => st.key === "survey-source")!;
    expect(s.executor).toMatchObject({ type: "agent", skill: "source-survey" });
    expect(s.depends_on.sort()).toEqual(["intake", "media-index", "media-transcribe", "watch-source"]);
    expect(s.required_checks).toContain("survey-valid");
  });

  it("plan-edit depends on media-index/media-transcribe/survey-source/watch-source/intake and outputs narration as json", () => {
    const s = wf.definition.stages.find((st) => st.key === "plan-edit")!;
    expect(s.executor).toMatchObject({ type: "agent", skill: "edit-plan" });
    expect(s.depends_on.sort()).toEqual(["intake", "media-index", "media-transcribe", "survey-source", "watch-source"]);
    const narration = s.outputs.find((o) => o.type === "narration")!;
    expect(narration).toEqual({ type: "narration", mime_type: "application/json", kind: "file", name: "narration.json" });
  });

  it("media-tts has no when clause, depends on plan-edit and intake, needs gpu", () => {
    const s = wf.definition.stages.find((st) => st.key === "media-tts")!;
    expect(s.executor).toEqual({ type: "script", script: "media-tts" });
    expect(s.when).toBeUndefined();
    expect(s.depends_on.sort()).toEqual(["intake", "plan-edit"]);
    expect(s.requires_resources).toEqual(["gpu"]);
    expect(s.required_checks).toEqual(["schema-valid", "output-exists", "checksum-match", "tts-valid"]);
    expect(s.outputs.map((o) => o.type).sort()).toEqual(["narration_timing", "voice_set"]);
  });

  it("media-fit-edl depends on plan-edit/media-tts/survey-source/media-index/media-transcribe/intake, never gated by when", () => {
    const s = wf.definition.stages.find((st) => st.key === "media-fit-edl")!;
    expect(s.executor).toEqual({ type: "script", script: "media-fit-edl" });
    expect(s.when).toBeUndefined();
    expect(s.depends_on.sort()).toEqual(["intake", "media-index", "media-transcribe", "plan-edit", "survey-source", "media-tts"].sort());
    expect(s.required_checks).toEqual(["schema-valid", "output-exists", "checksum-match", "edl-valid"]);
    expect(s.outputs.map((o) => o.type).sort()).toEqual(["edl", "fit_report", "timeline"]);
  });

  it("cut depends only on media-fit-edl", () => {
    const s = wf.definition.stages.find((st) => st.key === "cut")!;
    expect(s.depends_on).toEqual(["media-fit-edl"]);
  });

  // `media-index` joined this set in the task-10 fix round: `audio-integrity` needs its `shots` output
  // (`has_audio` per source) to tell a deliberately silent `voice: none` episode from one that lost its audio.
  it("assemble depends on cut/intake/media-tts/media-fit-edl/media-index, no depends_on_optional", () => {
    const s = wf.definition.stages.find((st) => st.key === "assemble")!;
    expect(s.depends_on.sort()).toEqual(["cut", "intake", "media-fit-edl", "media-index", "media-tts"]);
    expect(s.depends_on_optional).toEqual([]);
    expect(s.required_checks).toContain("brief-duration");
  });

  it("library-review depends on media-fit-edl in addition to the 1.1.0 set", () => {
    const s = wf.definition.stages.find((st) => st.key === "library-review")!;
    expect(s.executor).toMatchObject({ type: "agent", skill: "library-review" });
    expect(s.depends_on.sort()).toEqual(["intake", "library-export", "media-fit-edl", "plan-edit", "watch-episode"]);
  });

  it("library-export carries no dangling depends_on_optional on the retired tts stage key", () => {
    const s = wf.definition.stages.find((st) => st.key === "library-export")!;
    expect(s.depends_on_optional).toEqual([]);
  });

  it("profile studio points at library-production@1.2.0, revision 3, with the deadline override", () => {
    expect(profile.workflow_release).toBe("library-production@1.2.0");
    expect(profile.revision).toBe(3);
    expect(profile.overrides).toEqual({ default_deadline_seconds: 14400 });
    expect(profile.limits.max_cost_usd_per_variant).toBe(8);
  });
});
