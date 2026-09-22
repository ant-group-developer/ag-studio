/** Caption cues from word timings, and SRT/VTT writers (sub-project 5B Task 3, spec §4.1). Pure: no I/O, no
 * clock, no randomness. Source is `timeline.narration[].words` (`voice: tts`, one "line" per narration entry)
 * or `timeline.speech[].words` (`voice: original`, one "line" per source segment); `voice: none` yields no
 * cues. Words never merge across a line/segment boundary. */
import type { CaptionCue, Timeline, Word } from "@harness/contracts";
import { round3 } from "./time.js";

export const CAPTION = {
  max_cue_seconds: 6,
  min_cue_seconds: 0.8,
  silence_break_seconds: 0.5,
  punct_break_min_seconds: 1.2,
  cue_gap_seconds: 0.05,
} as const;

/** A word "ends" a sentence for the punctuation-break rule when its text ends in one of these marks. */
const SENTENCE_END = /[.,;:?!]$/;

/** Trailing `<number>[ ]<unit>` cluster (`27,5 %`, `3 triệu`) that `wrapLines` never splits across a line
 * break -- matched against the candidate first line once the next token is appended. */
const NUMBER_TAIL = /(\d[\d.,]*)$/;
const UNIT_TOKEN = /^(%|[A-Za-zÀ-ỹ]{1,6})$/;

function isValidTiming(w: Word): boolean {
  return Number.isFinite(w.start) && Number.isFinite(w.end) && w.end > w.start;
}

/**
 * Fills in `start`/`end` for words with no usable timing (`end <= start` or non-finite), by linear
 * interpolation between the nearest timed words in the same line -- at either end of the line, the line's own
 * `start`/`end` stands in for the missing neighbour. Pushes `word_interpolated:<key>:<i>` to `warnings` for
 * every word it touches, `key` being the caller's line identifier (`line_id` for narration, the speech-array
 * index for `original`).
 */
function interpolateLineWords(words: Word[], lineStart: number, lineEnd: number, key: string, warnings: string[]): Word[] {
  const out = words.map((w) => ({ ...w }));
  let i = 0;
  while (i < out.length) {
    if (isValidTiming(out[i]!)) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && !isValidTiming(out[j]!)) j++;

    const rangeStart = i === 0 ? lineStart : out[i - 1]!.end;
    const rangeEnd = j === out.length ? lineEnd : out[j]!.start;
    const count = j - i;
    const span = Math.max(0, rangeEnd - rangeStart);
    const step = span / count;
    for (let k = 0; k < count; k++) {
      const idx = i + k;
      out[idx] = { ...out[idx]!, start: round3(rangeStart + step * k), end: round3(rangeStart + step * (k + 1)) };
      warnings.push(`word_interpolated:${key}:${idx}`);
    }
    i = j;
  }
  return out;
}

/**
 * Groups one line's (already-timed) words into cue-sized runs, per spec §4.1 point 1: a cue closes right
 * after the word just added when adding the next word would push the joined text over
 * `max_chars_per_line * max_lines` characters, the cue is already longer than `CAPTION.max_cue_seconds`, the
 * word ends a sentence and the cue is already `>= CAPTION.punct_break_min_seconds`, the gap to the next word
 * is `>= CAPTION.silence_break_seconds`, or the line has run out of words.
 */
function groupCueWords(words: Word[], maxCharsPerLine: number, maxLines: number): Word[][] {
  const capacity = maxCharsPerLine * maxLines;
  const groups: Word[][] = [];
  let current: Word[] = [];
  let text = "";

  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    current.push(w);
    text = text.length === 0 ? w.word : `${text} ${w.word}`;
    const next = words[i + 1];
    const duration = w.end - current[0]!.start;

    let close = next === undefined;
    if (!close && next && `${text} ${next.word}`.length > capacity) close = true;
    if (!close && duration > CAPTION.max_cue_seconds) close = true;
    if (!close && SENTENCE_END.test(w.word) && duration >= CAPTION.punct_break_min_seconds) close = true;
    if (!close && next && next.start - w.end >= CAPTION.silence_break_seconds) close = true;

    if (close) {
      groups.push(current);
      current = [];
      text = "";
    }
  }
  return groups;
}

export function buildCaptionCues(p: { timeline: Timeline; max_chars_per_line: number; max_lines: number }): { cues: CaptionCue[]; warnings: string[] } {
  const { timeline, max_chars_per_line, max_lines } = p;
  const warnings: string[] = [];
  if (timeline.voice === "none") return { cues: [], warnings };

  const lines: { key: string; start: number; end: number; words: Word[] }[] =
    timeline.voice === "tts"
      ? timeline.narration.map((n) => ({ key: n.line_id, start: n.start, end: n.end, words: n.words }))
      : timeline.speech.map((s, i) => ({ key: String(i), start: s.start, end: s.end, words: s.words }));

  const groups: Word[][] = [];
  for (const line of lines) {
    if (line.words.length === 0) continue;
    const resolved = interpolateLineWords(line.words, line.start, line.end, line.key, warnings);
    groups.push(...groupCueWords(resolved, max_chars_per_line, max_lines));
  }

  const cues: CaptionCue[] = [];
  for (let i = 0; i < groups.length; i++) {
    const words = groups[i]!;
    const start = round3(words[0]!.start);
    let end = round3(words[words.length - 1]!.end);
    if (end - start < CAPTION.min_cue_seconds) {
      const next = groups[i + 1];
      const cap = next ? next[0]!.start - CAPTION.cue_gap_seconds : Infinity;
      end = round3(Math.max(start, Math.min(start + CAPTION.min_cue_seconds, cap)));
    }
    const text = words.map((w) => w.word).join(" ");
    cues.push({
      index: i + 1,
      start,
      end,
      lines: wrapLines(text, max_chars_per_line, max_lines),
      raise_px: 0,
      words: words.map((w) => ({ word: w.word, start: round3(w.start), end: round3(w.end), ...(w.score !== undefined ? { score: w.score } : {}) })),
    });
  }
  return { cues, warnings };
}

/** Index of the whitespace nearest the middle of `s`, or -1 when there is none. */
function nearestSpaceToMiddle(s: string): number {
  const target = s.length / 2;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== " ") continue;
    const d = Math.abs(i - target);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Retreats `cut` (a space index in `s`) to before a trailing `<number>[ ]<unit>` cluster the naive cut would
 * otherwise split -- `27,5 %` never becomes `27,5` / `% ...`. No-op when the candidate first line does not end
 * in a bare number, or the first token of the candidate second line is not unit-shaped. */
function avoidNumberUnitSplit(s: string, cut: number): number {
  const head = s.slice(0, cut);
  const tail = s.slice(cut).trimStart();
  const m = NUMBER_TAIL.exec(head);
  if (!m) return cut;
  const firstWord = tail.split(" ", 1)[0] ?? "";
  if (!UNIT_TOKEN.test(firstWord)) return cut;
  const adjusted = cut - m[1]!.length;
  return adjusted > 0 ? adjusted : cut;
}

/**
 * Wraps `text` into at most `maxLines` lines of (best-effort) `<= maxChars` each, cutting at the whitespace
 * nearest the middle of the remaining text and never splitting a `<number> <unit>` pair. The cue builder
 * already caps a cue's total characters at `maxChars * maxLines`, so running out of cuts before the text fits
 * is a safety net, not the normal path: whatever is left becomes the last line, even if it overflows.
 */
export function wrapLines(text: string, maxChars: number, maxLines: number): string[] {
  if (maxLines <= 1 || text.length <= maxChars) return [text];

  const lines: string[] = [];
  let remaining = text;
  while (lines.length < maxLines - 1 && remaining.length > maxChars) {
    let cut = nearestSpaceToMiddle(remaining);
    if (cut <= 0) break;
    cut = avoidNumberUnitSplit(remaining, cut);
    if (cut <= 0) break;
    lines.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  lines.push(remaining);
  return lines;
}

function formatClock(totalSeconds: number, sep: "," | "."): string {
  const totalMs = Math.max(0, Math.round(totalSeconds * 1000));
  const hours = Math.floor(totalMs / 3_600_000);
  const minutes = Math.floor((totalMs % 3_600_000) / 60_000);
  const secs = Math.floor((totalMs % 60_000) / 1000);
  const millis = totalMs % 1000;
  const pad = (n: number, len = 2) => String(n).padStart(len, "0");
  return `${pad(hours)}:${pad(minutes)}:${pad(secs)}${sep}${pad(millis, 3)}`;
}

function writeCueBlocks(cues: CaptionCue[], sep: "," | "."): string {
  return cues.map((c) => `${c.index}\n${formatClock(c.start, sep)} --> ${formatClock(c.end, sep)}\n${c.lines.join("\n")}\n\n`).join("");
}

/** `""` for an empty cue list -- an empty `captions.srt` is a valid file, but there is nothing to write. */
export function toSrt(cues: CaptionCue[]): string {
  return cues.length === 0 ? "" : writeCueBlocks(cues, ",");
}

/** Always starts with the `WEBVTT` header, even for an empty cue list (a valid, empty WebVTT file). */
export function toVtt(cues: CaptionCue[]): string {
  return `WEBVTT\n\n${writeCueBlocks(cues, ".")}`;
}
