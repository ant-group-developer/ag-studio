/**
 * Deterministic validators for GĐ2 (series plan, YouTube kit, trend report).
 *
 * Each validator returns a `StudioValidation<T>` that is:
 * - used by the `StudioAgentExecutor` to feed problems back to Claude for the one repair round,
 * - returned by the API when a gate submit is refused (so the web shows exactly what to fix), and
 * - used by the checkers in `studio-checkers.ts`.
 *
 * Problems are Vietnamese sentences Claude and a person can act on.
 */
import {
  EPISODE_DURATION_TOLERANCE, SeriesPlanSchema, TrendReportSchema, YoutubeKitSchema, YOUTUBE_TAGS_MAX_CHARS,
  type CatalogAsset, type SeriesPlan, type StudioBrief, type StudioEpisode, type TrendReport, type YoutubeKit,
} from "@harness/contracts";
import type { ZodError } from "zod";
import { orientationFits } from "./catalog.js";

export interface StudioProblem { code: string; message: string }
export interface StudioValidation<T> {
  ok: boolean;
  value: T | null;
  problems: StudioProblem[];
  warnings: StudioProblem[];
}

function zodProblems(e: ZodError): StudioProblem[] {
  return e.issues.map((i) => ({ code: "schema", message: `${i.path.join(".") || "(root)"}: ${i.message}` }));
}

export function validateSeriesPlan(
  raw: unknown,
  ctx: { brief: StudioBrief; catalog: CatalogAsset[] },
): StudioValidation<SeriesPlan> {
  const parsed = SeriesPlanSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, problems: zodProblems(parsed.error), warnings: [] };

  const plan = parsed.data;
  const problems: StudioProblem[] = [];
  const warnings: StudioProblem[] = [];

  const assetById = new Map(ctx.catalog.map((a) => [a.asset_id, a]));

  if (!plan.episodes.every((ep, i) => ep.idx === i + 1)) {
    problems.push({ code: "bad_idx", message: "idx của mỗi tập phải là 1, 2, 3, ... theo thứ tự" });
  }

  if (plan.episodes.length > ctx.brief.max_episodes) {
    problems.push({ code: "too_many_episodes", message: `đề xuất ${plan.episodes.length} tập nhưng giới hạn là ${ctx.brief.max_episodes}` });
  }

  const assetEpisodes = new Map<string, number>();

  for (const ep of plan.episodes) {
    const itemAssets = new Set<string>();

    for (const item of ep.items) {
      const asset = assetById.get(item.asset_id);
      if (!asset) {
        problems.push({ code: "unknown_asset", message: `tập ${ep.idx}: video ${item.asset_id} không có trong catalog` });
        continue;
      }
      if (!asset.usable) {
        problems.push({ code: "not_usable", message: `tập ${ep.idx}: video ${item.asset_id} bị đánh dấu không dùng được` });
      }
      if (!orientationFits(asset.orientation, ctx.brief.aspect)) {
        problems.push({ code: "wrong_orientation", message: `tập ${ep.idx}: video ${item.asset_id} (${asset.orientation ?? "không rõ"}) không phù hợp tỉ lệ ${ctx.brief.aspect}` });
      }
      if (itemAssets.has(item.asset_id)) {
        problems.push({ code: "duplicate_in_episode", message: `tập ${ep.idx}: video ${item.asset_id} xuất hiện hai lần trong items` });
      }
      itemAssets.add(item.asset_id);
      const prev = assetEpisodes.get(item.asset_id);
      if (prev !== undefined) {
        warnings.push({ code: "cross_episode_reuse", message: `video ${item.asset_id} dùng ở cả tập ${prev} và tập ${ep.idx}` });
      } else {
        assetEpisodes.set(item.asset_id, ep.idx);
      }
    }

    const altAssets = new Set<string>();
    for (const alt of ep.alternates) {
      if (!assetById.has(alt.asset_id)) {
        problems.push({ code: "unknown_alternate", message: `tập ${ep.idx}: phương án thay thế ${alt.asset_id} không có trong catalog` });
      }
      if (itemAssets.has(alt.asset_id)) {
        problems.push({ code: "alternate_is_item", message: `tập ${ep.idx}: ${alt.asset_id} vừa là item vừa là alternate` });
      }
      if (altAssets.has(alt.asset_id)) {
        problems.push({ code: "duplicate_alternate", message: `tập ${ep.idx}: alternate ${alt.asset_id} bị trùng` });
      }
      altAssets.add(alt.asset_id);
    }

    for (const ts of ep.texts_suggested) {
      if (ts.at_item >= ep.items.length) {
        problems.push({ code: "bad_at_item", message: `tập ${ep.idx}: texts_suggested.at_item = ${ts.at_item} vượt quá số items (${ep.items.length}, chỉ số 0-based)` });
      }
    }

    const totalDuration = ep.items.reduce((s, item) => s + (assetById.get(item.asset_id)?.duration_s ?? 0), 0);
    const target = ep.target_seconds;
    const tolerance = target * EPISODE_DURATION_TOLERANCE;
    if (Math.abs(totalDuration - target) > tolerance + 1e-6) {
      const pct = Math.round(Math.abs(totalDuration - target) / target * 100);
      warnings.push({ code: "duration_off_target", message: `tập ${ep.idx}: tổng thời lượng ${totalDuration.toFixed(1)}s lệch ${pct}% so với mục tiêu ${target}s (±20%)` });
    }
  }

  return { ok: problems.length === 0, value: plan, problems, warnings };
}

export function validateYoutubeKit(
  raw: unknown,
  ctx: { episode: StudioEpisode },
): StudioValidation<YoutubeKit> {
  const parsed = YoutubeKitSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, problems: zodProblems(parsed.error), warnings: [] };

  const kit = parsed.data;
  const problems: StudioProblem[] = [];
  const warnings: StudioProblem[] = [];

  const episodeAssetIds = new Set(ctx.episode.items.map((i) => i.asset_id));

  for (const thumb of kit.thumbnails) {
    if (!episodeAssetIds.has(thumb.asset_id)) {
      problems.push({ code: "thumbnail_not_in_episode", message: `thumbnail dùng video ${thumb.asset_id} không có trong danh sách items của tập` });
    }
  }

  const tagsStr = kit.tags.join(",");
  if (tagsStr.length > YOUTUBE_TAGS_MAX_CHARS) {
    problems.push({ code: "tags_too_long", message: `tổng độ dài tags ${tagsStr.length} ký tự vượt quá giới hạn 500` });
  }

  const titles = new Set<string>();
  for (const title of kit.titles) {
    if (titles.has(title)) problems.push({ code: "duplicate_title", message: `tiêu đề "${title}" bị trùng` });
    titles.add(title);
  }

  return { ok: problems.length === 0, value: kit, problems, warnings };
}

export function validateTrendReport(raw: unknown): StudioValidation<TrendReport> {
  const parsed = TrendReportSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, problems: zodProblems(parsed.error), warnings: [] };
  return { ok: true, value: parsed.data, problems: [], warnings: [] };
}
