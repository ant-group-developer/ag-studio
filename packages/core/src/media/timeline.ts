/** The programme timeline: one clock carrying the fitted video entries, the narration lines and (for
 * `voice: original`) the source speech clipped into each cut (spec sub-project 5A §4.2). This is the
 * contract sub-project 5B builds subtitles, ducking and text overlays on. Pure: no I/O, no clock, no
 * randomness. */
import { TimelineSchema, type Edl, type NarrationTiming, type Timeline, type Transcript, type Word } from "@harness/contracts";
import { FIT } from "./fit-edl.js";

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** Copies a word onto the programme clock. `score` is spread conditionally: the schema has it optional and
 * the repo compiles with `exactOptionalPropertyTypes`, so an explicit `undefined` would not type-check. */
function shiftWord(w: Word, by: number): Word {
  return { word: w.word, start: round3(w.start + by), end: round3(w.end + by), ...(w.score !== undefined ? { score: w.score } : {}) };
}

/**
 * Lays `edl` out end to end and places `timing`'s lines against it.
 *
 * Video entries follow their `order`, each starting where the previous one ended. Narration lines are
 * grouped by the ORIGINAL `edl_order` they were written for and resolved through `orderMap` (as returned by
 * `fitEdl`): the group's first line starts `FIT.lead` after the start of the first entry that order
 * produced, and the rest of the group follows on immediately. A group whose entry was dropped -- an empty
 * `orderMap` list -- or whose `edl_order` no longer exists is skipped rather than guessed at.
 */
export function buildTimeline(p: {
  edl: Edl;
  timing: NarrationTiming;
  transcript: Transcript | null;
  voice: Timeline["voice"];
  language: string;
  orderMap: Map<number, number[]>;
}): Timeline {
  const video: Timeline["video"] = [];
  const byOrder = new Map<number, Timeline["video"][number]>();
  let clock = 0;
  for (const e of [...p.edl.entries].sort((a, b) => a.order - b.order)) {
    const item = {
      order: e.order,
      source_id: e.source_id,
      in: round3(e.in),
      out: round3(e.out),
      start: round3(clock),
      end: round3(clock + (e.out - e.in)),
    };
    video.push(item);
    byOrder.set(e.order, item);
    clock += e.out - e.in;
  }

  const groups = new Map<number, NarrationTiming["lines"]>();
  for (const line of p.timing.lines) {
    const group = groups.get(line.edl_order);
    if (group) group.push(line);
    else groups.set(line.edl_order, [line]);
  }

  const narration: Timeline["narration"] = [];
  for (const order of [...groups.keys()].sort((a, b) => a - b)) {
    const anchor = byOrder.get(p.orderMap.get(order)?.[0] ?? -1);
    if (!anchor) continue;
    let at = anchor.start + FIT.lead;
    for (const line of groups.get(order) ?? []) {
      const start = round3(at);
      narration.push({
        line_id: line.line_id,
        wav: line.wav,
        start,
        end: round3(at + line.duration_seconds),
        words: line.words.map((w) => shiftWord(w, start)),
      });
      at += line.duration_seconds;
    }
  }

  const speech: Timeline["speech"] = [];
  if (p.voice === "original" && p.transcript) {
    for (const v of video) {
      const source = p.transcript.sources.find((s) => s.source_id === v.source_id);
      if (!source) continue;
      const shift = v.start - v.in;
      for (const seg of source.segments) {
        const from = Math.max(seg.start, v.in);
        const to = Math.min(seg.end, v.out);
        if (to - from <= 0) continue;
        const kept = seg.words.filter((w) => w.start >= from && w.end <= to);
        const whole = seg.start >= v.in && seg.end <= v.out;
        speech.push({
          source_id: v.source_id,
          start: round3(from + shift),
          end: round3(to + shift),
          text: whole || seg.words.length === 0 ? seg.text : kept.map((w) => w.word).join(" "),
          words: kept.map((w) => shiftWord(w, shift)),
        });
      }
    }
  }

  return TimelineSchema.parse({
    schema_version: "harness.timeline/v1",
    voice: p.voice,
    language: p.language,
    total_seconds: round3(video.at(-1)?.end ?? 0),
    video,
    narration,
    speech,
  });
}
