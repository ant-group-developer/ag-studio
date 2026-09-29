/**
 * Timeline v2 layout and editing operations (GĐ4).
 *
 * Pure and dependency-free on purpose: the web editor imports this file directly (its reducer is these
 * operations plus undo/redo), the API validates saved revisions with it, and the workflow's stages build and
 * render from it -- one definition of "where does beat 3 start" for all of them.
 *
 * Model: a beat lasts exactly as long as its clips; narration lines of a beat play back to back from the
 * beat's start; texts sit at an offset inside their beat. Re-ordering beats therefore moves pictures, voice
 * and text together, and a trim can only ever shorten or lengthen its own beat.
 */
import type { TimelineClip, TimelineLine, TimelineText, TimelineV2 } from "@harness/contracts";

/** Silence between two narration lines of the same beat (seconds). */
export const NARRATION_GAP = 0.25;
/** Picture kept after the last line of a beat before the next beat starts. */
export const BEAT_TAIL = 0.4;
/** Shortest clip the editor or the builder will make. */
export const MIN_CLIP_SECONDS = 0.5;
/** Vietnamese read-aloud rate used before TTS has measured a line (words per second). */
export const WORDS_PER_SECOND = 2.6;

const r3 = (n: number) => Math.round(n * 1000) / 1000;

export function segmentSeconds(t: Pick<TimelineV2, "segments">, segmentId: string): number | null {
  const s = t.segments[segmentId];
  return s ? r3((s.end_ms - s.start_ms) / 1000) : null;
}

export function estimateSpeechSeconds(text: string): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  return r3(Math.max(0.5, words / WORDS_PER_SECOND));
}

export interface LaidClip extends TimelineClip { start: number; end: number; duration: number }
export interface LaidLine extends TimelineLine { start: number; end: number; duration: number; estimated: boolean }
export interface LaidText extends TimelineText { start: number; end: number }
export interface LaidBeat { beat_id: string; title: string; index: number; start: number; end: number; duration: number; clips: LaidClip[]; lines: LaidLine[]; texts: LaidText[]; narration_seconds: number }
export interface TimelineLayout { beats: LaidBeat[]; clips: LaidClip[]; lines: LaidLine[]; texts: LaidText[]; duration: number }

export function layoutTimeline(t: TimelineV2): TimelineLayout {
  const beats: LaidBeat[] = [];
  let cursor = 0;
  t.beats.forEach((b, index) => {
    const start = r3(cursor);
    const clips: LaidClip[] = [];
    for (const c of t.clips) {
      if (c.beat_id !== b.beat_id) continue;
      const duration = r3(Math.max(0, c.src_out - c.src_in));
      clips.push({ ...c, start: r3(cursor), end: r3(cursor + duration), duration });
      cursor += duration;
    }
    const end = r3(cursor);
    const lines: LaidLine[] = [];
    let lineCursor = start;
    for (const l of t.narration) {
      if (l.beat_id !== b.beat_id) continue;
      const duration = l.audio ? r3(l.audio.duration) : estimateSpeechSeconds(l.text);
      lines.push({ ...l, start: r3(lineCursor), end: r3(lineCursor + duration), duration, estimated: !l.audio });
      lineCursor += duration + NARRATION_GAP;
    }
    const narration_seconds = lines.length ? r3(lines[lines.length - 1]!.end - start) : 0;
    const texts: LaidText[] = t.texts.filter((x) => x.beat_id === b.beat_id)
      .map((x) => ({ ...x, start: r3(start + x.offset), end: r3(start + x.offset + x.duration) }));
    beats.push({ beat_id: b.beat_id, title: b.title, index, start, end, duration: r3(end - start), clips, lines, texts, narration_seconds });
  });
  return {
    beats,
    clips: beats.flatMap((b) => b.clips),
    lines: beats.flatMap((b) => b.lines),
    texts: beats.flatMap((b) => b.texts),
    duration: r3(cursor),
  };
}

export type TimelineIssueCode =
  | "unknown_beat" | "duplicate_id" | "unknown_segment" | "empty_clip" | "clip_out_of_range" | "beat_empty"
  | "duplicate_segment" | "narration_overflow" | "narration_not_voiced" | "text_overflow" | "wrong_production" | "wrong_canvas";
export interface TimelineIssue { severity: "error" | "warning"; code: TimelineIssueCode; message: string; beat_id?: string; clip_id?: string; line_id?: string; text_id?: string }

/**
 * Everything wrong with a timeline, as data. `error` blocks the `edit` gate and the final render;
 * `warning` is shown in the editor only.
 */
export function timelineIssues(t: TimelineV2): TimelineIssue[] {
  const issues: TimelineIssue[] = [];
  const beatIds = new Set<string>();
  for (const b of t.beats) {
    if (beatIds.has(b.beat_id)) issues.push({ severity: "error", code: "duplicate_id", message: `beat ${b.beat_id} xuất hiện hai lần`, beat_id: b.beat_id });
    beatIds.add(b.beat_id);
  }
  const seen = new Set<string>();
  const dupe = (kind: string, id: string, extra: Partial<TimelineIssue>) => {
    if (seen.has(`${kind}:${id}`)) issues.push({ severity: "error", code: "duplicate_id", message: `${kind} ${id} xuất hiện hai lần`, ...extra });
    seen.add(`${kind}:${id}`);
  };
  const usedSegments = new Map<string, string>();
  for (const c of t.clips) {
    dupe("clip", c.clip_id, { clip_id: c.clip_id });
    if (!beatIds.has(c.beat_id)) issues.push({ severity: "error", code: "unknown_beat", message: `clip ${c.clip_id} thuộc beat lạ ${c.beat_id}`, clip_id: c.clip_id });
    const segSeconds = segmentSeconds(t, c.segment_id);
    if (segSeconds === null) { issues.push({ severity: "error", code: "unknown_segment", message: `clip ${c.clip_id} dùng đoạn ${c.segment_id} không có trong timeline`, clip_id: c.clip_id, beat_id: c.beat_id }); continue; }
    if (c.src_out - c.src_in < MIN_CLIP_SECONDS - 1e-6) issues.push({ severity: "error", code: "empty_clip", message: `clip ${c.clip_id} ngắn hơn ${MIN_CLIP_SECONDS}s`, clip_id: c.clip_id, beat_id: c.beat_id });
    if (c.src_in < 0 || c.src_out > segSeconds + 1e-3) issues.push({ severity: "error", code: "clip_out_of_range", message: `clip ${c.clip_id} cắt ngoài đoạn nguồn (0–${segSeconds}s)`, clip_id: c.clip_id, beat_id: c.beat_id });
    const other = usedSegments.get(c.segment_id);
    if (other) issues.push({ severity: "error", code: "duplicate_segment", message: `đoạn ${c.segment_id} dùng ở cả ${other} và ${c.clip_id}`, clip_id: c.clip_id, beat_id: c.beat_id });
    else usedSegments.set(c.segment_id, c.clip_id);
  }
  for (const l of t.narration) {
    dupe("line", l.line_id, { line_id: l.line_id });
    if (!beatIds.has(l.beat_id)) issues.push({ severity: "error", code: "unknown_beat", message: `câu ${l.line_id} thuộc beat lạ ${l.beat_id}`, line_id: l.line_id });
    if (!l.audio) issues.push({ severity: "error", code: "narration_not_voiced", message: `câu ${l.line_id} chưa được đọc (TTS)`, line_id: l.line_id, beat_id: l.beat_id });
  }
  for (const x of t.texts) {
    dupe("text", x.text_id, { text_id: x.text_id });
    if (!beatIds.has(x.beat_id)) issues.push({ severity: "error", code: "unknown_beat", message: `chữ ${x.text_id} thuộc beat lạ ${x.beat_id}`, text_id: x.text_id });
  }
  const layout = layoutTimeline(t);
  for (const b of layout.beats) {
    if (!b.clips.length) issues.push({ severity: "error", code: "beat_empty", message: `beat ${b.beat_id} không có hình`, beat_id: b.beat_id });
    if (b.narration_seconds > b.duration + 0.05) {
      issues.push({ severity: "error", code: "narration_overflow", message: `beat ${b.beat_id}: lời dẫn dài ${b.narration_seconds}s nhưng hình chỉ có ${b.duration}s`, beat_id: b.beat_id });
    }
    for (const x of b.texts) {
      if (x.end > b.end + 0.05) issues.push({ severity: "warning", code: "text_overflow", message: `chữ ${x.text_id} kéo dài quá hết beat ${b.beat_id}`, text_id: x.text_id, beat_id: b.beat_id });
    }
  }
  return issues;
}

export class TimelineOpError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "TimelineOpError"; }
}

function mustClip(t: TimelineV2, clipId: string): { clip: TimelineClip; index: number } {
  const index = t.clips.findIndex((c) => c.clip_id === clipId);
  if (index < 0) throw new TimelineOpError("not_found", `không có clip ${clipId}`);
  return { clip: t.clips[index]!, index };
}
function mustBeat(t: TimelineV2, beatId: string): number {
  const i = t.beats.findIndex((b) => b.beat_id === beatId);
  if (i < 0) throw new TimelineOpError("not_found", `không có beat ${beatId}`);
  return i;
}
function nextId(prefix: string, ids: string[], width: number): string {
  const max = ids.reduce((m, id) => Math.max(m, Number(id.slice(prefix.length)) || 0), 0);
  return `${prefix}${String(max + 1).padStart(width, "0")}`;
}

export type SegmentInfo = TimelineV2["segments"][string];

/** Register a segment picked from the catalog so clips can refer to it. */
export function ensureSegment(t: TimelineV2, segmentId: string, info: SegmentInfo): TimelineV2 {
  if (t.segments[segmentId]) return t;
  return { ...t, segments: { ...t.segments, [segmentId]: info } };
}

/**
 * Swap the footage of one clip, keeping its length when the new segment is long enough (taken from the
 * middle of the segment, the least likely part to carry a cut). The old segment becomes an alternate of the
 * beat and the new one stops being one, so a swap is always one click away from being undone by hand too.
 */
export function replaceClipSegment(t: TimelineV2, clipId: string, segmentId: string): TimelineV2 {
  const { clip, index } = mustClip(t, clipId);
  const segSeconds = segmentSeconds(t, segmentId);
  if (segSeconds === null) throw new TimelineOpError("unknown_segment", `đoạn ${segmentId} chưa có trong timeline`);
  if (segmentId === clip.segment_id) return t;
  const want = clip.src_out - clip.src_in;
  const len = r3(Math.min(want, segSeconds));
  const src_in = r3((segSeconds - len) / 2);
  const clips = t.clips.slice();
  clips[index] = { ...clip, segment_id: segmentId, src_in, src_out: r3(src_in + len) };
  const alts = (t.alternates[clip.beat_id] ?? []).filter((a) => a.segment_id !== segmentId);
  if (!alts.some((a) => a.segment_id === clip.segment_id)) alts.unshift({ segment_id: clip.segment_id, reason: "đoạn cũ trước khi đổi" });
  return { ...t, clips, alternates: { ...t.alternates, [clip.beat_id]: alts } };
}

/** Trim inside the segment; values are clamped to the segment and to `MIN_CLIP_SECONDS`. */
export function trimClip(t: TimelineV2, clipId: string, srcIn: number, srcOut: number): TimelineV2 {
  const { clip, index } = mustClip(t, clipId);
  const segSeconds = segmentSeconds(t, clip.segment_id);
  if (segSeconds === null) throw new TimelineOpError("unknown_segment", `đoạn ${clip.segment_id} chưa có trong timeline`);
  let a = Math.max(0, Math.min(srcIn, segSeconds));
  let b = Math.max(0, Math.min(srcOut, segSeconds));
  if (b - a < MIN_CLIP_SECONDS) {
    if (a + MIN_CLIP_SECONDS <= segSeconds) b = a + MIN_CLIP_SECONDS; else { b = segSeconds; a = Math.max(0, b - MIN_CLIP_SECONDS); }
  }
  const clips = t.clips.slice();
  clips[index] = { ...clip, src_in: r3(a), src_out: r3(b) };
  return { ...t, clips };
}

/** Append a clip of `segmentId` (whole segment, capped at `maxSeconds`) at the end of a beat. */
export function addClip(t: TimelineV2, beatId: string, segmentId: string, maxSeconds = 6): TimelineV2 {
  mustBeat(t, beatId);
  const segSeconds = segmentSeconds(t, segmentId);
  if (segSeconds === null) throw new TimelineOpError("unknown_segment", `đoạn ${segmentId} chưa có trong timeline`);
  const len = r3(Math.max(Math.min(segSeconds, maxSeconds), Math.min(MIN_CLIP_SECONDS, segSeconds)));
  const src_in = r3((segSeconds - len) / 2);
  const clip: TimelineClip = { clip_id: nextId("C", t.clips.map((c) => c.clip_id), 3), beat_id: beatId, segment_id: segmentId, src_in, src_out: r3(src_in + len) };
  const lastOfBeat = t.clips.map((c) => c.beat_id).lastIndexOf(beatId);
  const clips = t.clips.slice();
  clips.splice(lastOfBeat < 0 ? clips.length : lastOfBeat + 1, 0, clip);
  const alts = (t.alternates[beatId] ?? []).filter((a) => a.segment_id !== segmentId);
  return { ...t, clips, alternates: { ...t.alternates, [beatId]: alts } };
}

export function removeClip(t: TimelineV2, clipId: string): TimelineV2 {
  const { clip } = mustClip(t, clipId);
  if (t.clips.filter((c) => c.beat_id === clip.beat_id).length <= 1) throw new TimelineOpError("last_clip", `beat ${clip.beat_id} phải còn ít nhất một clip`);
  return { ...t, clips: t.clips.filter((c) => c.clip_id !== clipId) };
}

/** Move the clip one step earlier/later inside its beat. */
export function moveClip(t: TimelineV2, clipId: string, delta: -1 | 1): TimelineV2 {
  const { clip, index } = mustClip(t, clipId);
  const sameBeat = t.clips.map((c, i) => ({ c, i })).filter((x) => x.c.beat_id === clip.beat_id);
  const pos = sameBeat.findIndex((x) => x.i === index);
  const other = sameBeat[pos + delta];
  if (!other) return t;
  const clips = t.clips.slice();
  clips[index] = other.c;
  clips[other.i] = clip;
  return { ...t, clips };
}

/** Re-order beats: pictures, lines and texts of the beat move with it. */
export function moveBeat(t: TimelineV2, from: number, to: number): TimelineV2 {
  if (from < 0 || from >= t.beats.length || to < 0 || to >= t.beats.length) throw new TimelineOpError("out_of_range", `vị trí beat không hợp lệ (${from} → ${to})`);
  if (from === to) return t;
  const beats = t.beats.slice();
  const [b] = beats.splice(from, 1);
  beats.splice(to, 0, b!);
  return { ...t, beats };
}

/** New text for a line: its audio is dropped, so only this one line needs TTS again. */
export function setLineText(t: TimelineV2, lineId: string, text: string): TimelineV2 {
  const trimmed = text.trim();
  if (!trimmed) throw new TimelineOpError("empty_text", "câu lời dẫn không được để trống");
  const i = t.narration.findIndex((l) => l.line_id === lineId);
  if (i < 0) throw new TimelineOpError("not_found", `không có câu ${lineId}`);
  if (t.narration[i]!.text === trimmed) return t;
  const narration = t.narration.slice();
  narration[i] = { ...narration[i]!, text: trimmed, audio: null };
  return { ...t, narration };
}

/**
 * Attach freshly synthesized audio. `forText` is the text that was sent to TTS: if the line was edited again
 * meanwhile, the audio belongs to an old sentence and is refused instead of silently mismatching.
 */
export function setLineAudio(t: TimelineV2, lineId: string, forText: string, audio: { key: string; duration: number }): TimelineV2 {
  const i = t.narration.findIndex((l) => l.line_id === lineId);
  if (i < 0) throw new TimelineOpError("not_found", `không có câu ${lineId}`);
  if (t.narration[i]!.text !== forText.trim()) throw new TimelineOpError("stale_audio", `câu ${lineId} đã đổi chữ sau khi gửi TTS`);
  const narration = t.narration.slice();
  narration[i] = { ...narration[i]!, audio: { key: audio.key, duration: r3(audio.duration) } };
  return { ...t, narration };
}

export function addText(t: TimelineV2, text: Omit<TimelineText, "text_id">): TimelineV2 {
  mustBeat(t, text.beat_id);
  const item: TimelineText = { ...text, text_id: nextId("T", t.texts.map((x) => x.text_id), 3) };
  return { ...t, texts: [...t.texts, item] };
}
export function updateText(t: TimelineV2, textId: string, patch: Partial<Omit<TimelineText, "text_id">>): TimelineV2 {
  const i = t.texts.findIndex((x) => x.text_id === textId);
  if (i < 0) throw new TimelineOpError("not_found", `không có chữ ${textId}`);
  if (patch.beat_id) mustBeat(t, patch.beat_id);
  const texts = t.texts.slice();
  texts[i] = { ...texts[i]!, ...(patch as Partial<TimelineText>) };
  return { ...t, texts };
}
export function removeText(t: TimelineV2, textId: string): TimelineV2 {
  return { ...t, texts: t.texts.filter((x) => x.text_id !== textId) };
}

export function setMusic(t: TimelineV2, music: TimelineV2["music"]): TimelineV2 {
  return { ...t, music };
}
export function setSourceAudioMuted(t: TimelineV2, muted: boolean): TimelineV2 {
  return { ...t, source_audio: { muted } };
}
export function setCaptions(t: TimelineV2, enabled: boolean): TimelineV2 {
  return { ...t, captions: { enabled } };
}
