/**
 * Timeline layout and editing operations (GĐ2, timeline v4 in phase 5).
 *
 * Pure and dependency-free on purpose: the web editor imports this directly (its reducer is these ops plus
 * undo/redo), the API validates saved revisions with it, and the workflow stages build and render from it.
 *
 * Model: clips play back to back in array order, each for `[in, out)` of its asset (v3 and `whole` episodes: the
 * whole asset); texts sit at absolute times; sections start wherever a clip has a non-null `section_title`;
 * a narration line starts `lead_seconds` after the clip that anchors it. Every function takes a v3 or a v4
 * timeline and an edit returns the same version it was given, so a v3 episode stays v3 (ADR-0001 item 151).
 */
import {
  upgradeTimelineV3,
  type CaptionMode, type EpisodeAsset, type StudioMusic, type TimelineClipV4, type TimelineOp, type TimelineText,
  type StoredTimeline, type TimelineTransitionKind, type TimelineV4,
} from "@harness/contracts";

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const EPS = 1e-6;
/** How far a clip's `out` may pass the asset's recorded duration before it is an error (probe rounding). */
const RANGE_SLACK = 0.05;
/** Shortest clip a shot-cut episode may hold. */
export const MIN_CLIP_SECONDS = 0.5;

/** A timeline of either version (`StoredTimeline` of contracts). */
export type AnyTimeline = StoredTimeline;

export function isTimelineV4(t: AnyTimeline): t is TimelineV4 {
  return t.schema_version === "studio.timeline/v4";
}

function asV4(t: AnyTimeline): TimelineV4 {
  return isTimelineV4(t) ? t : upgradeTimelineV3(t);
}

export interface LaidClip extends TimelineClipV4 {
  /** Seconds from the timeline start when this clip begins. */
  start: number;
  end: number;
  /** Play length = `source_out - in`. */
  duration: number;
  /** `out`, or the asset's duration when `out` is null. */
  source_out: number;
}

export interface LaidText extends TimelineText {
  end: number;
}

export interface LaidLine {
  line_id: string;
  /** The clip the line starts on. */
  clip_id: string;
  start: number;
  end: number;
  /** No audio yet: the length is guessed from the text (14 characters a second in Vietnamese, 15 otherwise). */
  estimated: boolean;
}

export interface Section {
  title: string;
  start: number;
  clip_id: string;
}

export interface TimelineLayout {
  clips: LaidClip[];
  texts: LaidText[];
  /** Anchored narration lines, in play order. */
  lines: LaidLine[];
  sections: Section[];
  /** Total duration = sum of all clip durations. */
  duration: number;
  /** Duration of every asset the timeline knows (for tails and range checks). */
  assetSeconds: Record<string, number>;
}

/** Characters read per second, used to size a line that has no audio yet (same figures as the edit-plan check). */
export function narrationCps(language: string): number {
  return language.startsWith("vi") ? 14 : 15;
}

/**
 * Compute absolute positions for every clip, text and narration line. Unknown assets get duration 0 — a validator
 * flags them separately so this function always returns a complete layout even for invalid timelines.
 */
export function layoutTimeline(input: AnyTimeline): TimelineLayout {
  const t = asV4(input);
  let cursor = 0;
  const clips: LaidClip[] = [];
  const sections: Section[] = [];
  const assetSeconds = Object.fromEntries(Object.entries(t.assets).map(([id, a]) => [id, a.duration_s]));

  for (const clip of t.clips) {
    const assetDuration = assetSeconds[clip.asset_id] ?? 0;
    const sourceOut = r3(clip.out ?? assetDuration);
    const duration = r3(Math.max(0, sourceOut - clip.in));
    const start = r3(cursor);
    const end = r3(cursor + duration);
    clips.push({ ...clip, start, end, duration, source_out: sourceOut });
    if (clip.section_title) sections.push({ title: clip.section_title, start, clip_id: clip.clip_id });
    cursor = end;
  }

  const byLine = new Map(t.narration.lines.map((l) => [l.line_id, l]));
  const cps = narrationCps(t.language);
  const lines: LaidLine[] = [];
  const anchored = new Set<string>();
  for (const c of clips) {
    if (!c.line_id || anchored.has(c.line_id)) continue;
    const line = byLine.get(c.line_id);
    if (!line) continue;
    anchored.add(c.line_id);
    const start = r3(c.start + t.narration.lead_seconds);
    const length = line.audio ? line.audio.duration_s : line.text.length / cps;
    lines.push({ line_id: line.line_id, clip_id: c.clip_id, start, end: r3(start + length), estimated: !line.audio });
  }

  const duration = r3(cursor);
  const texts: LaidText[] = t.texts.map((x) => ({ ...x, end: r3(x.start + x.duration) }));
  return { clips, texts, lines, sections, duration, assetSeconds };
}

export type TransitionDowngrade = "no_tail" | "next_too_short" | "too_short";

export interface ResolvedTransition {
  kind: TimelineTransitionKind;
  seconds: number;
  /** A dissolve plays a tail of the outgoing asset after `out` (ADR-0001 item 118). */
  tail_available: boolean;
  /** Why a requested transition became a cut; null when it plays as asked (or a cut was asked). */
  downgraded: TransitionDowngrade | null;
}

/**
 * What actually plays across each cut, same rules as the harness `assignTransitions`: a dissolve needs a tail on the
 * outgoing asset (`out + seconds <= duration`) and a next clip at least `2 × seconds` long; a dip to black needs both
 * clips at least `seconds` long; anything else becomes a cut. The last clip always cuts. Never moves a clip.
 */
export function resolveTransitions(layout: TimelineLayout): ResolvedTransition[] {
  return layout.clips.map((c, k) => {
    const { kind, seconds } = c.transition_out;
    const next = layout.clips[k + 1];
    if (!next || kind === "cut") return { kind: "cut", seconds, tail_available: false, downgraded: null };
    const cut = (downgraded: TransitionDowngrade): ResolvedTransition => ({ kind: "cut", seconds, tail_available: false, downgraded });
    if (kind === "dissolve") {
      const assetDuration = layout.assetSeconds[c.asset_id];
      if (assetDuration === undefined || c.source_out + seconds > assetDuration + EPS) return cut("no_tail");
      if (next.duration < 2 * seconds - EPS) return cut("next_too_short");
      return { kind, seconds, tail_available: true, downgraded: null };
    }
    if (c.duration < seconds - EPS || next.duration < seconds - EPS) return cut("too_short");
    return { kind, seconds, tail_available: false, downgraded: null };
  });
}

export interface TimelineIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  clip_id?: string;
  text_id?: string;
  line_id?: string;
}

/** Check for errors and warnings.  `targetSeconds` enables the duration-tolerance warning. */
export function timelineIssues(input: AnyTimeline, opts?: { targetSeconds?: number }): TimelineIssue[] {
  const t = asV4(input);
  const issues: TimelineIssue[] = [];
  const cutStyle = t.edit_style === "cut";

  if (!t.clips.length) {
    issues.push({ severity: "error", code: "no_clips", message: "Timeline cần ít nhất một clip" });
    return issues;
  }

  // Duplicate clip / text ids
  const clipIds = new Set<string>();
  const textIds = new Set<string>();
  for (const c of t.clips) {
    if (clipIds.has(c.clip_id)) issues.push({ severity: "error", code: "duplicate_id", message: `clip ${c.clip_id} xuất hiện hai lần`, clip_id: c.clip_id });
    clipIds.add(c.clip_id);
  }
  for (const x of t.texts) {
    if (textIds.has(x.text_id)) issues.push({ severity: "error", code: "duplicate_id", message: `chữ ${x.text_id} xuất hiện hai lần`, text_id: x.text_id });
    textIds.add(x.text_id);
  }

  // Unknown assets + same asset used twice (whole-video episodes only: shots may come from the same video)
  const usedAssets = new Map<string, string>(); // asset_id -> first clip_id
  for (const c of t.clips) {
    if (!t.assets[c.asset_id]) {
      issues.push({ severity: "error", code: "unknown_asset", message: `clip ${c.clip_id} dùng video ${c.asset_id} không có trong timeline`, clip_id: c.clip_id });
    } else if (!cutStyle) {
      const prev = usedAssets.get(c.asset_id);
      if (prev) issues.push({ severity: "error", code: "duplicate_asset", message: `video ${c.asset_id} dùng ở cả ${prev} và ${c.clip_id}`, clip_id: c.clip_id });
      else usedAssets.set(c.asset_id, c.clip_id);
    }
  }

  const layout = layoutTimeline(t);
  if (cutStyle) issues.push(...shotIssues(t, layout));

  // Texts that extend beyond the timeline end
  for (const x of layout.texts) {
    if (x.end > layout.duration + 0.05) {
      issues.push({ severity: "warning", code: "text_beyond_end", message: `chữ ${x.text_id} kéo dài đến ${x.end.toFixed(1)}s nhưng timeline chỉ có ${layout.duration.toFixed(1)}s`, text_id: x.text_id });
    }
  }

  // Duration warning (soft ±20%)
  const target = opts?.targetSeconds;
  if (target && target > 0) {
    const tolerance = target * 0.2;
    if (Math.abs(layout.duration - target) > tolerance + 1e-6) {
      const pct = Math.round(Math.abs(layout.duration - target) / target * 100);
      issues.push({ severity: "warning", code: "duration_off_target", message: `tổng thời lượng ${layout.duration.toFixed(1)}s lệch ${pct}% so với mục tiêu ${target}s (±20%)` });
    }
  }

  return issues;
}

/** The checks only a shot-cut timeline needs: ranges, narration anchors, transitions. */
function shotIssues(t: TimelineV4, layout: TimelineLayout): TimelineIssue[] {
  const issues: TimelineIssue[] = [];
  for (const c of layout.clips) {
    const assetDuration = layout.assetSeconds[c.asset_id];
    if (assetDuration === undefined) continue;
    if (c.in >= c.source_out - EPS || c.source_out > assetDuration + RANGE_SLACK) {
      issues.push({ severity: "error", code: "bad_range", message: `clip ${c.clip_id} lấy ${c.in}–${c.source_out}s của video dài ${assetDuration}s`, clip_id: c.clip_id });
    } else if (c.duration < MIN_CLIP_SECONDS - EPS) {
      issues.push({ severity: "error", code: "clip_too_short", message: `clip ${c.clip_id} chỉ dài ${c.duration.toFixed(2)}s (tối thiểu ${MIN_CLIP_SECONDS}s)`, clip_id: c.clip_id });
    }
  }

  // Same asset, overlapping ranges: the viewer sees the same picture twice
  for (let i = 0; i < layout.clips.length; i++) {
    for (let j = i + 1; j < layout.clips.length; j++) {
      const a = layout.clips[i]!;
      const b = layout.clips[j]!;
      if (a.asset_id === b.asset_id && a.in < b.source_out - EPS && b.in < a.source_out - EPS) {
        issues.push({ severity: "warning", code: "overlapping_range", message: `clip ${a.clip_id} và ${b.clip_id} dùng chung một đoạn của video ${a.asset_id}`, clip_id: b.clip_id });
      }
    }
  }

  // Narration anchors
  const lines = new Map(t.narration.lines.map((l) => [l.line_id, l]));
  const anchors = new Map<string, string>();
  for (const c of t.clips) {
    if (!c.line_id) continue;
    if (!lines.has(c.line_id)) {
      issues.push({ severity: "error", code: "unknown_line", message: `clip ${c.clip_id} neo lời dẫn ${c.line_id} không có`, clip_id: c.clip_id, line_id: c.line_id });
    } else if (anchors.has(c.line_id)) {
      issues.push({ severity: "error", code: "duplicate_line", message: `lời dẫn ${c.line_id} neo ở cả ${anchors.get(c.line_id)} và ${c.clip_id}`, clip_id: c.clip_id, line_id: c.line_id });
    } else {
      anchors.set(c.line_id, c.clip_id);
    }
  }
  for (const l of t.narration.lines) {
    if (t.narration.voice === "tts" && !l.audio) {
      issues.push({ severity: "error", code: "line_without_audio", message: `lời dẫn ${l.line_id} chưa được đọc`, line_id: l.line_id });
    }
    if (!anchors.has(l.line_id)) {
      issues.push({ severity: "warning", code: "unanchored_line", message: `lời dẫn ${l.line_id} không neo vào clip nào nên sẽ không được đọc`, line_id: l.line_id });
    }
  }
  layout.lines.forEach((l, k) => {
    const next = layout.lines[k + 1];
    const limit = next ? next.start : layout.duration;
    if (l.end > limit + 0.05) {
      const where = next ? `lời ${next.line_id} bắt đầu ở ${next.start.toFixed(1)}s` : `tập hết ở ${layout.duration.toFixed(1)}s`;
      issues.push({ severity: "warning", code: "narration_overrun", message: `lời dẫn ${l.line_id} đọc tới ${l.end.toFixed(1)}s nhưng ${where}`, line_id: l.line_id });
    }
  });

  // Transitions that will play as cuts
  resolveTransitions(layout).forEach((r, k) => {
    if (r.downgraded) {
      const c = layout.clips[k]!;
      issues.push({ severity: "warning", code: "transition_no_tail", message: `chuyển cảnh sau clip ${c.clip_id} sẽ thành cắt thẳng (${r.downgraded})`, clip_id: c.clip_id });
    }
  });
  return issues;
}

// ---------------------------------------------------------------------------
// Pure edit operations
// ---------------------------------------------------------------------------

export class TimelineOpError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "TimelineOpError"; }
}

type ClipOf<T extends AnyTimeline> = T["clips"][number];

function nextClipId(t: AnyTimeline): string {
  const max = t.clips.reduce((m, c) => Math.max(m, Number(c.clip_id.slice(1)) || 0), 0);
  return `C${String(max + 1).padStart(3, "0")}`;
}
function nextTextId(t: AnyTimeline): string {
  const max = t.texts.reduce((m, x) => Math.max(m, Number(x.text_id.slice(1)) || 0), 0);
  return `T${String(max + 1).padStart(3, "0")}`;
}
function clipIndex(t: AnyTimeline, clipId: string): number {
  const i = t.clips.findIndex((c) => c.clip_id === clipId);
  if (i < 0) throw new TimelineOpError("not_found", `không có clip ${clipId}`);
  return i;
}
function requireV4(t: AnyTimeline, what: string): TimelineV4 {
  if (!isTimelineV4(t)) throw new TimelineOpError("needs_v4", `${what} chỉ có ở tập cắt theo shot (timeline v4)`);
  return t;
}

/** Ensure the asset is registered in `t.assets`; add it if absent. */
export function ensureAsset<T extends AnyTimeline>(t: T, assetId: string, info: EpisodeAsset): T {
  if (t.assets[assetId]) return t;
  return { ...t, assets: { ...t.assets, [assetId]: info } };
}

/** Insert a clip at `index` (0 = first, clips.length = last).  Asset must already be registered. */
export function addClip<T extends AnyTimeline>(t: T, assetId: string, index: number): T {
  if (!t.assets[assetId]) throw new TimelineOpError("unknown_asset", `video ${assetId} chưa đăng ký trong timeline`);
  const base = { clip_id: nextClipId(t), asset_id: assetId, section_title: null };
  const clip = isTimelineV4(t)
    ? { ...base, in: 0, out: null, shot_id: null, line_id: null, transition_out: { kind: "cut" as const, seconds: 0 } }
    : base;
  const clips = t.clips.slice() as ClipOf<T>[];
  clips.splice(Math.max(0, Math.min(index, clips.length)), 0, clip as ClipOf<T>);
  return { ...t, clips };
}

/** Removes a clip; on v4 its narration line moves to the next clip when that clip anchors none. */
export function removeClip<T extends AnyTimeline>(t: T, clipId: string): T {
  const i = clipIndex(t, clipId);
  const clips = t.clips.filter((c) => c.clip_id !== clipId) as ClipOf<T>[];
  if (isTimelineV4(t)) {
    const lineId = t.clips[i]!.line_id;
    const next = clips[i] as TimelineClipV4 | undefined;
    if (lineId && next && next.line_id === null) clips[i] = { ...next, line_id: lineId } as ClipOf<T>;
  }
  return { ...t, clips };
}

/** Move the clip at position `from` to `to` (indices in the current array). */
export function moveClip<T extends AnyTimeline>(t: T, from: number, to: number): T {
  if (from < 0 || from >= t.clips.length || to < 0 || to >= t.clips.length) {
    throw new TimelineOpError("out_of_range", `vị trí clip không hợp lệ (${from} → ${to})`);
  }
  if (from === to) return t;
  const clips = t.clips.slice() as ClipOf<T>[];
  const [c] = clips.splice(from, 1);
  clips.splice(to, 0, c!);
  return { ...t, clips };
}

/**
 * Swap the asset of `clipId`.  The old asset is added to `t.alternates` (undo is one click away); the new
 * asset is removed from alternates if it was there. On a shot-cut timeline the clip keeps its length from the start
 * of the new asset (or plays all of it when it is shorter) and is no longer tied to a shot.
 */
export function replaceClipAsset<T extends AnyTimeline>(t: T, clipId: string, newAssetId: string): T {
  const i = clipIndex(t, clipId);
  const clip = t.clips[i]!;
  if (clip.asset_id === newAssetId) return t;
  const info = t.assets[newAssetId];
  if (!info) throw new TimelineOpError("unknown_asset", `video ${newAssetId} chưa đăng ký trong timeline`);
  const clips = t.clips.slice() as ClipOf<T>[];
  if (isTimelineV4(t) && t.edit_style === "cut") {
    const old = layoutTimeline(t).clips[i]!;
    const out = old.duration < info.duration_s - EPS ? old.duration : null;
    clips[i] = { ...(clip as TimelineClipV4), asset_id: newAssetId, in: 0, out, shot_id: null } as ClipOf<T>;
  } else {
    clips[i] = { ...clip, asset_id: newAssetId } as ClipOf<T>;
  }
  const alts = t.alternates.filter((a) => a.asset_id !== newAssetId);
  if (!alts.some((a) => a.asset_id === clip.asset_id)) {
    alts.push({ asset_id: clip.asset_id, reason: "video cũ trước khi đổi" });
  }
  return { ...t, clips, alternates: alts };
}

export function setSectionTitle<T extends AnyTimeline>(t: T, clipId: string, title: string | null): T {
  const i = clipIndex(t, clipId);
  const clips = t.clips.slice() as ClipOf<T>[];
  clips[i] = { ...clips[i]!, section_title: title };
  return { ...t, clips };
}

/** Plays `[in, out)` of the clip's asset (`out: null` = to its end). Timeline v4 only. */
export function trimClip(t: TimelineV4, clipId: string, inS: number, out: number | null): TimelineV4 {
  const v4 = requireV4(t, "Cắt đầu/cuối clip");
  const i = clipIndex(v4, clipId);
  const clip = v4.clips[i]!;
  const assetDuration = v4.assets[clip.asset_id]?.duration_s ?? 0;
  const until = out ?? assetDuration;
  if (inS < 0 || until <= inS + EPS || until > assetDuration + RANGE_SLACK) {
    throw new TimelineOpError("bad_range", `clip ${clipId}: ${inS}–${until}s nằm ngoài video dài ${assetDuration}s`);
  }
  const clips = v4.clips.slice();
  clips[i] = { ...clip, in: r3(inS), out: out === null ? null : r3(out) };
  return { ...v4, clips };
}

/** What plays from this clip into the next. Timeline v4 only. */
export function setTransition(t: TimelineV4, clipId: string, kind: TimelineTransitionKind, seconds: number): TimelineV4 {
  const v4 = requireV4(t, "Chuyển cảnh");
  const i = clipIndex(v4, clipId);
  if (seconds < 0 || seconds > 1) throw new TimelineOpError("bad_seconds", `chuyển cảnh dài ${seconds}s (0–1s)`);
  const clips = v4.clips.slice();
  clips[i] = { ...clips[i]!, transition_out: { kind, seconds: kind === "cut" ? 0 : seconds } };
  return { ...v4, clips };
}

/** One clip's own sound off (`muted`) or as the timeline's again (the key removed). Timeline v4 only. */
export function setClipMuted(t: TimelineV4, clipId: string, muted: boolean): TimelineV4 {
  const v4 = requireV4(t, "Tắt tiếng clip");
  const i = clipIndex(v4, clipId);
  const { muted: _was, ...clip } = v4.clips[i]!;
  const clips = v4.clips.slice();
  clips[i] = muted ? { ...clip, muted: true } : clip;
  return { ...v4, clips };
}

/** Burnt-in subtitles from the narration. Timeline v4 only. */
export function setCaptions(t: TimelineV4, mode: CaptionMode): TimelineV4 {
  return { ...requireV4(t, "Phụ đề"), captions: { mode } };
}

export function addText<T extends AnyTimeline>(t: T, text: Omit<TimelineText, "text_id">): T {
  const item: TimelineText = { ...text, text_id: nextTextId(t) };
  return { ...t, texts: [...t.texts, item] };
}

export function updateText<T extends AnyTimeline>(t: T, textId: string, patch: Partial<Omit<TimelineText, "text_id">>): T {
  const i = t.texts.findIndex((x) => x.text_id === textId);
  if (i < 0) throw new TimelineOpError("not_found", `không có chữ ${textId}`);
  const texts = t.texts.slice();
  texts[i] = { ...texts[i]!, ...(patch as Partial<TimelineText>) };
  return { ...t, texts };
}

export function removeText<T extends AnyTimeline>(t: T, textId: string): T {
  return { ...t, texts: t.texts.filter((x) => x.text_id !== textId) };
}

export function setMusic<T extends AnyTimeline>(t: T, music: StudioMusic | null): T {
  return { ...t, music };
}

export function setSourceMuted<T extends AnyTimeline>(t: T, muted: boolean): T {
  return { ...t, source_audio: { muted } };
}

// ---------------------------------------------------------------------------
// Edits proposed in chat (`TimelineOp`, contracts/studio-chat.ts)
// ---------------------------------------------------------------------------

function applyOne<T extends AnyTimeline>(t: T, op: TimelineOp, allowed: Record<string, EpisodeAsset>): T {
  const withAsset = (x: T, id: string): T => {
    if (x.assets[id]) return x;
    const info = allowed[id];
    if (!info) throw new TimelineOpError("unknown_asset", `video ${id} không nằm trong danh sách video tập này được dùng`);
    return ensureAsset(x, id, info);
  };
  switch (op.op) {
    case "addClip": return addClip(withAsset(t, op.asset_id), op.asset_id, op.index);
    case "removeClip": return removeClip(t, op.clip_id);
    case "moveClip": return moveClip(t, op.from, op.to);
    case "replaceClipAsset": return replaceClipAsset(withAsset(t, op.asset_id), op.clip_id, op.asset_id);
    case "setSectionTitle": return setSectionTitle(t, op.clip_id, op.title);
    case "addText": return addText(t, { kind: op.kind, text: op.text, start: op.start, duration: op.duration, position: op.position });
    case "updateText": {
      const patch: Partial<Omit<TimelineText, "text_id">> = {};
      if (op.kind !== null) patch.kind = op.kind;
      if (op.text !== null) patch.text = op.text;
      if (op.start !== null) patch.start = op.start;
      if (op.duration !== null) patch.duration = op.duration;
      if (op.position !== null) patch.position = op.position;
      return updateText(t, op.text_id, patch);
    }
    case "removeText":
      if (!t.texts.some((x) => x.text_id === op.text_id)) throw new TimelineOpError("not_found", `không có chữ ${op.text_id}`);
      return removeText(t, op.text_id);
    case "setMusic": return setMusic(t, op.music);
    case "setSourceMuted": return setSourceMuted(t, op.muted);
    case "trimClip": return trimClip(requireV4(t, "Cắt đầu/cuối clip"), op.clip_id, op.in, op.out) as T;
    case "setTransition": return setTransition(requireV4(t, "Chuyển cảnh"), op.clip_id, op.kind, op.seconds) as T;
    case "setCaptions": return setCaptions(requireV4(t, "Phụ đề"), op.mode) as T;
    case "setClipMuted": return setClipMuted(requireV4(t, "Tắt tiếng clip"), op.clip_id, op.muted) as T;
  }
}

/**
 * Runs chat edits in order on `t` (never changed). A video not yet in the timeline may be added only from `allowed`
 * (the episode's candidate videos). A failing edit throws `TimelineOpError` naming its position.
 */
export function applyTimelineOps<T extends AnyTimeline>(t: T, ops: readonly TimelineOp[], allowed: Record<string, EpisodeAsset>): T {
  return ops.reduce((acc, op, i) => {
    try { return applyOne(acc, op, allowed); }
    catch (e) {
      if (e instanceof TimelineOpError) throw new TimelineOpError(e.code, `thao tác ${i + 1} (${op.op}): ${e.message}`);
      throw e;
    }
  }, t);
}
