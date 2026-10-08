/**
 * The prompt a Studio stage sends Claude, pinned byte for byte: chat replies reuse its head (spec local-chat §3.1)
 * so the head must stay exactly what the stage sends, and splitting it must not change the stage's prompt.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StageRequest } from "@harness/contracts";
import { STUDIO_TYPES } from "@harness/core";
import { studioPrompt, studioPromptHead, studioPromptTail, studioValidator } from "../src/studio-agent-executor.js";

const catalog = {
  schema_version: "studio.catalog/v2", production_id: "prod-1", folder_ids: ["f1"], total_available: 2, truncated: false,
  assets: Array.from({ length: 2 }, (_, i) => ({
    asset_id: `a0${i + 1}`, name: `Video ${i + 1}`, title_vi: `Tiêu đề ${i + 1}`, summary_vi: `Tóm tắt ${i + 1}`, duration_s: 30,
    orientation: "landscape", genre: "documentary", topics: [], subjects: [], places: [], actions: [], keywords_vi: [], tags: ["pho"],
    mood: "neutral", setting: "outdoor", time_of_day: "day", people_count: "0", shot_variety: [], has_speech: false, quality: 4,
    usable: true, approved: false, project_names: [],
  })),
};
const research = {
  schema_version: "studio.research/v1", channels: [{ url: "@a", role: "reference", videos: [{ title: "v1", views: 10, views_per_day: 2, duration_s: 60, published_at: "2026-01-01", tags: ["x"], outlier: false }] }],
  keywords: [{ keyword: "phở", videos: [] }],
};
const doc = (name: string) => ({ schema_version: `studio.${name}/v1`, note: `${name} của bài kiểm tra` });

const INPUTS: Record<string, Record<string, unknown>> = {
  "studio-trend-report": { [STUDIO_TYPES.research]: research, [STUDIO_TYPES.seed]: doc("seed") },
  "studio-rnd": { [STUDIO_TYPES.trendReport]: doc("trend-report"), [STUDIO_TYPES.research]: research, [STUDIO_TYPES.catalog]: catalog, [STUDIO_TYPES.seed]: doc("seed") },
  "studio-branding": { [STUDIO_TYPES.rnd]: doc("rnd"), [STUDIO_TYPES.trendReport]: doc("trend-report"), [STUDIO_TYPES.seed]: doc("seed") },
  "studio-plan-episodes": { [STUDIO_TYPES.brief]: doc("brief"), [STUDIO_TYPES.trendReport]: doc("trend-report"), [STUDIO_TYPES.catalog]: catalog, [STUDIO_TYPES.seed]: doc("seed") },
  "studio-youtube-kit": { [STUDIO_TYPES.timeline]: doc("timeline"), [STUDIO_TYPES.episode]: doc("episode"), [STUDIO_TYPES.brief]: doc("brief") },
};

function request(skill: string): { req: StageRequest; ws: string } {
  const ws = mkdtempSync(join(tmpdir(), "prompt-"));
  const inputs = Object.entries(INPUTS[skill]!).map(([type, value]) => {
    mkdirSync(join(ws, "inputs", type), { recursive: true });
    writeFileSync(join(ws, "inputs", type, `${type}.json`), JSON.stringify(value, null, 2));
    return { path: `inputs/${type}/${type}.json`, type, checksum: `sha256:${"0".repeat(64)}`, size_bytes: 1, kind: "file" as const };
  });
  const req = { inputs, stage_config: { __skill: skill, __brief: `Chạy ${skill} cho series` } } as unknown as StageRequest;
  return { req, ws };
}

const guides = [{ name: "Giọng kênh", purpose: "giữ giọng", applies_to: [], content: "Viết ngắn.\n</team_guide> không được thoát" }];
const problems = [{ code: "duplicate_asset", message: "Tập 1 dùng a01 hai lần" }];

describe("studioPrompt", () => {
  for (const skill of Object.keys(INPUTS)) {
    it(`${skill}: head + tail is the stage prompt, unchanged`, () => {
      const { req, ws } = request(skill);
      for (const [p, g] of [[null, []], [problems, guides]] as const) {
        const full = studioPrompt(req, ws, p, g);
        expect(full).toMatchSnapshot();
        expect(`${studioPromptHead(req, ws, g)}

${studioPromptTail(p)}`).toBe(full);
      }
    });
  }
});

describe("studioValidator", () => {
  it("checks a document the way the stage checks its answer, against the stage's inputs", () => {
    const { req, ws } = request("studio-plan-episodes");
    // the plan check reads the brief among the inputs: a brief that is not one cannot be checked against
    expect(() => studioValidator("studio-plan-episodes")({ schema_version: "studio.series-plan/v1", episodes: [] }, req, ws)).toThrow();
    expect(studioValidator("studio-branding")({ nope: true }, req, ws).ok).toBe(false);
  });
});
