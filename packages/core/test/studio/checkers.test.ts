import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckerInput } from "@harness/contracts";
import {
  seriesPlanValidChecker, timelineSchemaValidChecker, timelineValidChecker, trendReportValidChecker,
  youtubeKitValidChecker, STUDIO_TYPES,
} from "../../src/verification/studio-checkers.js";

function workspace(inputs: Record<string, unknown>, outputs: Record<string, unknown>): CheckerInput {
  const ws = mkdtempSync(join(tmpdir(), "studio-check-"));
  mkdirSync(join(ws, "in"), { recursive: true });
  mkdirSync(join(ws, "output"), { recursive: true });
  const req = { inputs: [] as { path: string; type: string }[] };
  for (const [type, v] of Object.entries(inputs)) {
    writeFileSync(join(ws, "in", `${type}.json`), JSON.stringify(v));
    req.inputs.push({ path: `in/${type}.json`, type });
  }
  const res = { outputs: [] as { path: string; type: string }[] };
  for (const [type, v] of Object.entries(outputs)) {
    writeFileSync(join(ws, "output", `${type}.json`), JSON.stringify(v));
    res.outputs.push({ path: `output/${type}.json`, type });
  }
  return { request: req, result: res, workspaceDir: ws } as unknown as CheckerInput;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROD = "prod-1";

function brief() {
  return {
    schema_version: "studio.brief/v2", production_id: PROD, run_id: "run_X", owner_user_id: "auth0|owner",
    title: "Phở Hà Nội", description: "Một buổi sáng ăn phở",
    goal: "Chia sẻ ẩm thực", audience: "Người yêu ẩm thực", tone: "Thân thiện",
    notes: "", folder_ids: ["f1"], episode_target_seconds: 90, max_episodes: 3,
    aspect: "16:9", canvas: { width: 1920, height: 1080 }, fps: 25, language: "vi",
    music: null, youtube_channels: [], keywords: [],
  };
}

function catalogAsset(id: string) {
  return {
    asset_id: id, name: `Video ${id}`, title_vi: `Tiêu đề ${id}`, summary_vi: `Tóm tắt ${id}`,
    duration_s: 30, orientation: "landscape", genre: "documentary",
    topics: [], subjects: [], places: [], actions: [], keywords_vi: [],
    tags: [], mood: "neutral", setting: "outdoor", time_of_day: "day", people_count: "0",
    shot_variety: [], has_speech: false, quality: 4, usable: true, approved: false, project_names: [],
  };
}

function catalog() {
  return {
    schema_version: "studio.catalog/v2", production_id: PROD, folder_ids: ["f1"],
    total_available: 3, truncated: false,
    assets: [catalogAsset("a01"), catalogAsset("a02"), catalogAsset("a03")],
  };
}

function seriesPlan() {
  return {
    schema_version: "studio.series-plan/v1",
    series_title: "Phở Hà Nội",
    rationale: "Một tập đủ để kể câu chuyện",
    episodes: [{
      idx: 1, title: "Tập 1", hook: "Bát phở đầu ngày",
      logline: "Khám phá phở cổ truyền",
      target_seconds: 90,
      items: [
        { asset_id: "a01", reason: "mở đầu", section_title: "Giới thiệu" },
        { asset_id: "a02", reason: "nấu nướng", section_title: null },
        { asset_id: "a03", reason: "ăn", section_title: null },
      ],
      alternates: [],
      texts_suggested: [],
    }],
  };
}

function timeline(assetId = "a01") {
  return {
    schema_version: "studio.timeline/v3",
    production_id: PROD, episode_id: "ep-1",
    canvas: { width: 1920, height: 1080 }, fps: 25, language: "vi",
    clips: [{ clip_id: "C001", asset_id: assetId, section_title: "Mở đầu" }],
    texts: [],
    music: null,
    source_audio: { muted: false },
    assets: { [assetId]: { title: "Phở bò", summary_vi: "Phở bò buổi sáng", duration_s: 8, orientation: "landscape" } },
    alternates: [],
  };
}

function trendReport() {
  return {
    schema_version: "studio.trend-report/v1",
    skipped: false,
    summary: "Dữ liệu cho thấy video ngắn 3–5 phút với hook mạnh hoạt động tốt nhất.",
    working_angles: ["Trải nghiệm thực tế"],
    title_patterns: ["[Từ khoá] — [Con số]"],
    hook_patterns: ["Câu hỏi cá nhân hoá"],
    thumbnail_patterns: ["Cận cảnh khuôn mặt"],
    recommended_duration_s: 90,
    posting_schedule: "Thứ 3 và Thứ 6, 18:00–20:00",
    recommendations: ["Dùng nhạc nhẹ"],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("studio checkers through the Checker interface", () => {
  const inputs = {
    [STUDIO_TYPES.brief]: brief(),
    [STUDIO_TYPES.catalog]: catalog(),
  };

  it("series-plan-valid passes a good plan and fails with the problem list otherwise", async () => {
    const r = await seriesPlanValidChecker.check(workspace(inputs, { [STUDIO_TYPES.seriesPlan]: seriesPlan() }));
    expect(r.verdict).toBe("pass");

    const bad = seriesPlan();
    bad.episodes[0]!.items[0]!.asset_id = "nope";
    const r2 = await seriesPlanValidChecker.check(workspace(inputs, { [STUDIO_TYPES.seriesPlan]: bad }));
    expect(r2.verdict).toBe("fail");
    expect(JSON.stringify(r2.evidence)).toContain("unknown_asset");
  });

  it("series-plan-valid fails (not throws) when an input it needs is missing", async () => {
    const r = await seriesPlanValidChecker.check(
      workspace({ [STUDIO_TYPES.brief]: brief() }, { [STUDIO_TYPES.seriesPlan]: seriesPlan() }),
    );
    expect(r).toEqual({ verdict: "fail", evidence: { reason: `missing input ${STUDIO_TYPES.catalog}` } });
  });

  it("a gate waiting for a person (deferred result) is skipped, not failed", async () => {
    const input = workspace(inputs, {});
    (input.result as { outcome?: string }).outcome = "deferred";
    expect((await seriesPlanValidChecker.check(input)).verdict).toBe("skip");
  });

  it("timeline-schema-valid passes a good v3 timeline and fails a bad one", async () => {
    const r = await timelineSchemaValidChecker.check(workspace({}, { [STUDIO_TYPES.timeline]: timeline() }));
    expect(r.verdict).toBe("pass");

    const bad = { ...timeline(), clips: "not-an-array" };
    const r2 = await timelineSchemaValidChecker.check(workspace({}, { [STUDIO_TYPES.timeline]: bad }));
    expect(r2.verdict).toBe("fail");
  });

  it("timeline-valid blocks a timeline with an unknown asset", async () => {
    const r = await timelineValidChecker.check(workspace({}, { [STUDIO_TYPES.timeline]: timeline() }));
    expect(r.verdict).toBe("pass");

    // timeline referencing an asset not in `assets` map → unknown_asset error
    const bad = {
      ...timeline(),
      clips: [{ clip_id: "C001", asset_id: "missing-asset", section_title: null }],
      // assets does NOT include "missing-asset"
    };
    const r2 = await timelineValidChecker.check(workspace({}, { [STUDIO_TYPES.timeline]: bad }));
    expect(r2.verdict).toBe("fail");
    expect(JSON.stringify(r2.evidence)).toContain("unknown_asset");
  });

  it("trend-report-valid passes a good trend report", async () => {
    const r = await trendReportValidChecker.check(workspace({}, { [STUDIO_TYPES.trendReport]: trendReport() }));
    expect(r.verdict).toBe("pass");
  });
});
