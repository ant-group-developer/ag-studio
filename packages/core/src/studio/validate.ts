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
  EPISODE_DURATION_TOLERANCE, SeriesPlanSchema, StudioBrandingSchema, StudioRndSchema, TrendReportSchema, YoutubeKitSchema,
  YOUTUBE_TAGS_MAX_CHARS,
  type CatalogAsset, type SeriesPlan, type StudioBranding, type StudioBrief, type StudioEpisode, type StudioRnd, type StudioSeed,
  type TrendReport, type YoutubeKit,
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

/**
 * Warning codes that mean "the AI did not follow what a person decided" (a hint the person typed, the approved
 * branding). The agent executor turns them into problems so Claude fixes them in its repair round; at a gate, or
 * when a person edits by hand, they stay warnings: a person may decide differently.
 */
export const FOLLOW_UP_WARNING_PREFIXES = ["hint_", "branding_"] as const;
export function isFollowUpWarning(p: StudioProblem): boolean {
  return FOLLOW_UP_WARNING_PREFIXES.some((prefix) => p.code.startsWith(prefix));
}

/** Words of a text as YouTube viewers read them (no punctuation), for counting. */
function wordCount(text: string): number {
  return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean).length;
}

/** `banned` words (case-insensitive, whole words) that appear in `text`. */
function bannedIn(text: string, banned: readonly string[]): string[] {
  const lower = ` ${text.toLocaleLowerCase("vi")} `;
  return banned.filter((w) => w.trim() && new RegExp(`[^\\p{L}\\p{N}]${escapeRegExp(w.trim().toLocaleLowerCase("vi"))}[^\\p{L}\\p{N}]`, "u").test(lower));
}
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * R&D (`studio-rnd`, the `approve-rnd` gate, a person's later edit). Problems: own channels must be assessed when
 * the person named some; content pillars have distinct names. Warnings `hint_*`: the episode length or count the
 * person typed is not the direction's.
 */
export function validateRnd(raw: unknown, ctx: { seed: Pick<StudioSeed, "channels" | "hints"> }): StudioValidation<StudioRnd> {
  const parsed = StudioRndSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, problems: zodProblems(parsed.error), warnings: [] };
  const rnd = parsed.data;
  const problems: StudioProblem[] = [];
  const warnings: StudioProblem[] = [];
  const hasOwn = ctx.seed.channels.some((c) => c.role === "own");
  if (hasOwn && !rnd.own_channels) {
    problems.push({ code: "own_channels_missing", message: "người dùng có nhập kênh của mình: own_channels phải đánh giá kênh đó (không được null)" });
  }
  if (!hasOwn && rnd.own_channels) {
    warnings.push({ code: "own_channels_unexpected", message: "không có kênh của mình trong đầu vào nhưng own_channels vẫn có nội dung" });
  }
  const pillars = new Set<string>();
  for (const p of rnd.direction.content_pillars) {
    const key = p.name.trim().toLocaleLowerCase("vi");
    if (pillars.has(key)) problems.push({ code: "duplicate_pillar", message: `trụ cột nội dung "${p.name}" bị trùng` });
    pillars.add(key);
  }
  const { episode_target_seconds: target, max_episodes: max } = ctx.seed.hints;
  if (target !== null && rnd.direction.episode_target_seconds !== target) {
    warnings.push({ code: "hint_episode_target", message: `người dùng đã đặt thời lượng mỗi tập ${target}s; direction.episode_target_seconds phải là ${target}` });
  }
  if (max !== null && rnd.direction.max_episodes !== max) {
    warnings.push({ code: "hint_max_episodes", message: `người dùng đã đặt số tập tối đa ${max}; direction.max_episodes phải là ${max}` });
  }
  return { ok: problems.length === 0, value: rnd, problems, warnings };
}

/** Branding (`studio-branding`, the `approve-branding` gate, a person's later edit): schema, plus consistency warnings. */
export function validateBranding(raw: unknown): StudioValidation<StudioBranding> {
  const parsed = StudioBrandingSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, problems: zodProblems(parsed.error), warnings: [] };
  const b = parsed.data;
  const problems: StudioProblem[] = [];
  const warnings: StudioProblem[] = [];
  for (const ex of b.titles.examples) {
    if (ex.length > b.titles.max_chars) warnings.push({ code: "example_too_long", message: `ví dụ tiêu đề "${ex}" dài ${ex.length} ký tự, quá ${b.titles.max_chars}` });
    for (const w of bannedIn(ex, b.voice.banned_words)) warnings.push({ code: "example_banned_word", message: `ví dụ tiêu đề "${ex}" dùng từ cấm "${w}"` });
  }
  if (b.thumbnail.palette.text.toLowerCase() === b.thumbnail.palette.outline.toLowerCase()) {
    problems.push({ code: "palette_no_contrast", message: "màu chữ thumbnail trùng màu viền: chữ sẽ không đọc được" });
  }
  return { ok: problems.length === 0, value: b, problems, warnings };
}

export function validateYoutubeKit(
  raw: unknown,
  ctx: { episode: StudioEpisode; branding?: StudioBranding | null },
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

  const b = ctx.branding;
  if (b) {
    for (const title of kit.titles) {
      if (title.length > b.titles.max_chars) warnings.push({ code: "branding_title_too_long", message: `tiêu đề "${title}" dài ${title.length} ký tự, branding cho tối đa ${b.titles.max_chars}` });
      for (const w of bannedIn(title, b.voice.banned_words)) warnings.push({ code: "branding_banned_word", message: `tiêu đề "${title}" dùng từ cấm của branding "${w}"` });
    }
    for (const w of bannedIn(kit.description, b.voice.banned_words)) warnings.push({ code: "branding_banned_word", message: `mô tả dùng từ cấm của branding "${w}"` });
    for (const thumb of kit.thumbnails) {
      const n = wordCount(thumb.text);
      if (n > b.thumbnail.max_words) warnings.push({ code: "branding_thumbnail_words", message: `chữ thumbnail "${thumb.text}" có ${n} chữ, branding cho tối đa ${b.thumbnail.max_words}` });
      if (b.thumbnail.text_case === "upper" && thumb.text !== thumb.text.toLocaleUpperCase("vi")) {
        warnings.push({ code: "branding_thumbnail_case", message: `chữ thumbnail "${thumb.text}" phải viết HOA theo branding` });
      }
    }
    const have = new Set(kit.hashtags.map((h) => h.toLocaleLowerCase("vi")));
    for (const h of b.description.hashtags) {
      if (!have.has(h.toLocaleLowerCase("vi"))) warnings.push({ code: "branding_hashtag_missing", message: `thiếu hashtag của series ${h}` });
    }
  }

  return { ok: problems.length === 0, value: kit, problems, warnings };
}

export function validateTrendReport(raw: unknown): StudioValidation<TrendReport> {
  const parsed = TrendReportSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, value: null, problems: zodProblems(parsed.error), warnings: [] };
  return { ok: true, value: parsed.data, problems: [], warnings: [] };
}
