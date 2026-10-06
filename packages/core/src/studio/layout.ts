/**
 * Timeline v3 layout and editing operations (GĐ2).
 *
 * Pure and dependency-free on purpose: the web editor imports this directly (its reducer is these ops plus
 * undo/redo), the API validates saved revisions with it, and the workflow stages build and render from it.
 *
 * Model: clips play back to back in array order, each for its WHOLE asset (no trimming); texts sit at
 * absolute times; sections start wherever a clip has a non-null `section_title`.
 */
import type { EpisodeAsset, StudioMusic, TimelineClip, TimelineOp, TimelineText, TimelineV3 } from "@harness/contracts";

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export interface LaidClip extends TimelineClip {
  /** Seconds from the timeline start when this clip begins. */
  start: number;
  end: number;
  /** Actual play length = `assets[asset_id].duration_s`; whole-asset, no trimming. */
  duration: number;
}

export interface LaidText extends TimelineText {
  end: number;
}

export interface Section {
  title: string;
  start: number;
  clip_id: string;
}

export interface TimelineLayout {
  clips: LaidClip[];
  texts: LaidText[];
  sections: Section[];
  /** Total duration = sum of all clip durations. */
  duration: number;
}

/**
 * Compute absolute positions for every clip and text.  Unknown assets get duration 0 — a validator flags them
 * separately so this function always returns a complete layout even for invalid timelines.
 */
export function layoutTimeline(t: TimelineV3): TimelineLayout {
  let cursor = 0;
  const clips: LaidClip[] = [];
  const sections: Section[] = [];

  for (const clip of t.clips) {
    const duration = r3(t.assets[clip.asset_id]?.duration_s ?? 0);
    const start = r3(cursor);
    const end = r3(cursor + duration);
    clips.push({ ...clip, start, end, duration });
    if (clip.section_title) sections.push({ title: clip.section_title, start, clip_id: clip.clip_id });
    cursor = end;
  }

  const duration = r3(cursor);
  const texts: LaidText[] = t.texts.map((x) => ({ ...x, end: r3(x.start + x.duration) }));
  return { clips, texts, sections, duration };
}

export interface TimelineIssue {
  severity: "error" | "warning";
  code: string;
  message: string;
  clip_id?: string;
  text_id?: string;
}

/** Check for errors and warnings.  `targetSeconds` enables the duration-tolerance warning. */
export function timelineIssues(t: TimelineV3, opts?: { targetSeconds?: number }): TimelineIssue[] {
  const issues: TimelineIssue[] = [];

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

  // Unknown assets + same asset used twice
  const usedAssets = new Map<string, string>(); // asset_id -> first clip_id
  for (const c of t.clips) {
    if (!t.assets[c.asset_id]) {
      issues.push({ severity: "error", code: "unknown_asset", message: `clip ${c.clip_id} dùng video ${c.asset_id} không có trong timeline`, clip_id: c.clip_id });
    } else {
      const prev = usedAssets.get(c.asset_id);
      if (prev) issues.push({ severity: "error", code: "duplicate_asset", message: `video ${c.asset_id} dùng ở cả ${prev} và ${c.clip_id}`, clip_id: c.clip_id });
      else usedAssets.set(c.asset_id, c.clip_id);
    }
  }

  // Texts that extend beyond the timeline end
  const layout = layoutTimeline(t);
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

// ---------------------------------------------------------------------------
// Pure edit operations
// ---------------------------------------------------------------------------

export class TimelineOpError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "TimelineOpError"; }
}

function nextClipId(t: TimelineV3): string {
  const max = t.clips.reduce((m, c) => Math.max(m, Number(c.clip_id.slice(1)) || 0), 0);
  return `C${String(max + 1).padStart(3, "0")}`;
}
function nextTextId(t: TimelineV3): string {
  const max = t.texts.reduce((m, x) => Math.max(m, Number(x.text_id.slice(1)) || 0), 0);
  return `T${String(max + 1).padStart(3, "0")}`;
}

/** Ensure the asset is registered in `t.assets`; add it if absent. */
export function ensureAsset(t: TimelineV3, assetId: string, info: EpisodeAsset): TimelineV3 {
  if (t.assets[assetId]) return t;
  return { ...t, assets: { ...t.assets, [assetId]: info } };
}

/** Insert a clip at `index` (0 = first, clips.length = last).  Asset must already be registered. */
export function addClip(t: TimelineV3, assetId: string, index: number): TimelineV3 {
  if (!t.assets[assetId]) throw new TimelineOpError("unknown_asset", `video ${assetId} chưa đăng ký trong timeline`);
  const clip: TimelineClip = { clip_id: nextClipId(t), asset_id: assetId, section_title: null };
  const clips = t.clips.slice();
  clips.splice(Math.max(0, Math.min(index, clips.length)), 0, clip);
  return { ...t, clips };
}

export function removeClip(t: TimelineV3, clipId: string): TimelineV3 {
  const i = t.clips.findIndex((c) => c.clip_id === clipId);
  if (i < 0) throw new TimelineOpError("not_found", `không có clip ${clipId}`);
  return { ...t, clips: t.clips.filter((c) => c.clip_id !== clipId) };
}

/** Move the clip at position `from` to `to` (indices in the current array). */
export function moveClip(t: TimelineV3, from: number, to: number): TimelineV3 {
  if (from < 0 || from >= t.clips.length || to < 0 || to >= t.clips.length) {
    throw new TimelineOpError("out_of_range", `vị trí clip không hợp lệ (${from} → ${to})`);
  }
  if (from === to) return t;
  const clips = t.clips.slice();
  const [c] = clips.splice(from, 1);
  clips.splice(to, 0, c!);
  return { ...t, clips };
}

/**
 * Swap the asset of `clipId`.  The old asset is added to `t.alternates` (undo is one click away); the new
 * asset is removed from alternates if it was there.
 */
export function replaceClipAsset(t: TimelineV3, clipId: string, newAssetId: string): TimelineV3 {
  const i = t.clips.findIndex((c) => c.clip_id === clipId);
  if (i < 0) throw new TimelineOpError("not_found", `không có clip ${clipId}`);
  const clip = t.clips[i]!;
  if (clip.asset_id === newAssetId) return t;
  if (!t.assets[newAssetId]) throw new TimelineOpError("unknown_asset", `video ${newAssetId} chưa đăng ký trong timeline`);
  const clips = t.clips.slice();
  clips[i] = { ...clip, asset_id: newAssetId };
  const alts = t.alternates.filter((a) => a.asset_id !== newAssetId);
  if (!alts.some((a) => a.asset_id === clip.asset_id)) {
    alts.push({ asset_id: clip.asset_id, reason: "video cũ trước khi đổi" });
  }
  return { ...t, clips, alternates: alts };
}

export function setSectionTitle(t: TimelineV3, clipId: string, title: string | null): TimelineV3 {
  const i = t.clips.findIndex((c) => c.clip_id === clipId);
  if (i < 0) throw new TimelineOpError("not_found", `không có clip ${clipId}`);
  const clips = t.clips.slice();
  clips[i] = { ...clips[i]!, section_title: title };
  return { ...t, clips };
}

export function addText(t: TimelineV3, text: Omit<TimelineText, "text_id">): TimelineV3 {
  const item: TimelineText = { ...text, text_id: nextTextId(t) };
  return { ...t, texts: [...t.texts, item] };
}

export function updateText(t: TimelineV3, textId: string, patch: Partial<Omit<TimelineText, "text_id">>): TimelineV3 {
  const i = t.texts.findIndex((x) => x.text_id === textId);
  if (i < 0) throw new TimelineOpError("not_found", `không có chữ ${textId}`);
  const texts = t.texts.slice();
  texts[i] = { ...texts[i]!, ...(patch as Partial<TimelineText>) };
  return { ...t, texts };
}

export function removeText(t: TimelineV3, textId: string): TimelineV3 {
  return { ...t, texts: t.texts.filter((x) => x.text_id !== textId) };
}

export function setMusic(t: TimelineV3, music: StudioMusic | null): TimelineV3 {
  return { ...t, music };
}

export function setSourceMuted(t: TimelineV3, muted: boolean): TimelineV3 {
  return { ...t, source_audio: { muted } };
}

// ---------------------------------------------------------------------------
// Edits proposed in chat (`TimelineOp`, contracts/studio-chat.ts)
// ---------------------------------------------------------------------------

function applyOne(t: TimelineV3, op: TimelineOp, allowed: Record<string, EpisodeAsset>): TimelineV3 {
  const withAsset = (x: TimelineV3, id: string) => {
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
  }
}

/**
 * Runs chat edits in order on `t` (never changed). A video not yet in the timeline may be added only from `allowed`
 * (the episode's candidate videos). A failing edit throws `TimelineOpError` naming its position.
 */
export function applyTimelineOps(t: TimelineV3, ops: readonly TimelineOp[], allowed: Record<string, EpisodeAsset>): TimelineV3 {
  return ops.reduce((acc, op, i) => {
    try { return applyOne(acc, op, allowed); }
    catch (e) {
      if (e instanceof TimelineOpError) throw new TimelineOpError(e.code, `thao tác ${i + 1} (${op.op}): ${e.message}`);
      throw e;
    }
  }, t);
}
