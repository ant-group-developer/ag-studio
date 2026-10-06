import { describe, expect, it } from "vitest";
import {
  chatReplySchema, claudeJsonSchemaFor, IntakeDraftSchema, intakeMissing, StudioRndSchema, TimelineOpSchema, TimelineChatProposalSchema,
  STUDIO_CHAT_SKILLS, STUDIO_CHAT_SKILL_STEP, TEAM_SKILL_STEPS, type IntakeDraft,
} from "../src/index.js";

const draft = (over: Partial<IntakeDraft> = {}): IntakeDraft => ({
  schema_version: "studio.intake-draft/v1",
  title: "Series Kyoto", folder_ids: ["f1"], channels: [{ url: "@meitime", role: "reference" }], keywords: [],
  aspect: "16:9", language: "vi",
  hints: { description: "", goal: "", audience: "", tone: "", notes: "", episode_target_seconds: 900, max_episodes: null },
  questions: [],
  ...over,
});

function walk(node: unknown, visit: (n: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return; }
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  for (const v of Object.values(node)) walk(v, visit);
}

describe("chat reply", () => {
  it("wraps a reply, an action and an optional proposal of the stage's own schema", () => {
    const S = chatReplySchema(StudioRndSchema);
    expect(S.safeParse({ reply: "Bạn muốn gộp tập nào?", action: "answer", proposal: null }).success).toBe(true);
    expect(S.safeParse({ reply: "x", action: "approve", proposal: null }).success).toBe(false);
    expect(S.safeParse({ reply: "", action: "answer", proposal: null }).success).toBe(false);
    expect(S.safeParse({ reply: "x", action: "revise", proposal: { not: "an rnd" } }).success).toBe(false);
  });

  it("gives Claude a closed schema with no record and no numeric or length limits", () => {
    for (const s of [chatReplySchema(StudioRndSchema), chatReplySchema(TimelineChatProposalSchema), chatReplySchema(IntakeDraftSchema)]) {
      const js = claudeJsonSchemaFor(s);
      walk(js, (n) => {
        for (const k of ["minimum", "maximum", "minLength", "maxLength", "pattern", "minItems", "maxItems"]) expect(n).not.toHaveProperty(k);
        if (n.type === "object") {
          expect(n.additionalProperties).toBe(false);
          expect(n.properties).toBeDefined();
        }
      });
      expect((js as { required: string[] }).required).toEqual(["reply", "action", "proposal"]);
    }
  });
});

describe("timeline ops", () => {
  it("parses each op and refuses unknown ones", () => {
    const ok = [
      { op: "addClip", asset_id: "a1", index: 0 },
      { op: "removeClip", clip_id: "C001" },
      { op: "moveClip", from: 2, to: 0 },
      { op: "replaceClipAsset", clip_id: "C001", asset_id: "a2" },
      { op: "setSectionTitle", clip_id: "C001", title: null },
      { op: "addText", kind: "lower_third", text: "Sagano bamboo grove", start: 72, duration: 6, position: "bottom_left" },
      { op: "updateText", text_id: "T001", kind: null, text: null, start: 10, duration: null, position: null },
      { op: "removeText", text_id: "T001" },
      { op: "setMusic", music: { track: "library:music/calm.mp3", gain_db: -22, ducking: true } },
      { op: "setMusic", music: null },
      { op: "setSourceMuted", muted: true },
    ];
    for (const o of ok) expect(TimelineOpSchema.safeParse(o).success, o.op).toBe(true);
    expect(TimelineOpSchema.safeParse({ op: "trim", clip_id: "C001" }).success).toBe(false);
    expect(TimelineOpSchema.safeParse({ op: "removeClip", clip_id: "x1" }).success).toBe(false);
    expect(TimelineOpSchema.safeParse({ op: "moveClip", from: -1, to: 0 }).success).toBe(false);
    expect(TimelineChatProposalSchema.safeParse({ ops: [] }).success).toBe(false);
  });
});

describe("intake draft", () => {
  it("lists what is still missing before the series can start", () => {
    expect(intakeMissing(draft())).toEqual([]);
    expect(intakeMissing(draft({ title: null, folder_ids: [], aspect: null }))).toEqual(["title", "folder_ids", "aspect"]);
    expect(intakeMissing(draft({ channels: [], keywords: [] }))).toEqual(["research"]);
    expect(intakeMissing(draft({ channels: [], keywords: ["kyoto vlog"] }))).toEqual([]);
  });

  it("asks at most five questions, each about a field it knows", () => {
    expect(IntakeDraftSchema.safeParse(draft({ questions: [{ field: "aspect", question: "Ngang hay dọc?", options: ["Ngang 16:9", "Dọc 9:16"] }] })).success).toBe(true);
    expect(IntakeDraftSchema.safeParse(draft({ questions: [{ field: "colour", question: "?", options: [] }] as never })).success).toBe(false);
  });

  it("chat skills have a team-skill step of their own", () => {
    expect(STUDIO_CHAT_SKILLS).toEqual(["studio-intake", "studio-timeline"]);
    for (const s of STUDIO_CHAT_SKILLS) expect(TEAM_SKILL_STEPS).toContain(STUDIO_CHAT_SKILL_STEP[s]);
  });
});
