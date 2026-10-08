/**
 * What Whisper hears that nobody said (plan 2026-10-08 task 23). On footage with music, wind or a station's PA,
 * WhisperX writes sentences that are not in the sound — "Hãy đăng ký kênh…", "Thanks for watching" — with word scores
 * near zero. Passed on as they are, the survey reads them as someone talking and the edit plan quotes them. The
 * shot-cut episode (cut 1.1.0) drops them in its own stage, after the farm's transcription and before anything reads it.
 */
import type { TranscribeManifest } from "@ag-farm/protocol";

/** A segment whose words WhisperX aligned with a mean score under this was not heard: it is dropped. */
export const MIN_MEAN_WORD_SCORE = 0.25;

/**
 * Sentences Whisper makes up on sound without speech (YouTube outros it was trained on), compared without case, marks or
 * punctuation. Only a segment with no word scores is dropped for one (a scored one is judged by its scores).
 */
export const HALLUCINATED_PHRASES = [
  "dang ky kenh", "subscribe", "nhan chuong", "bam chuong", "like va share", "khong bo lo nhung video",
  "ghien mi go", "la la school", "cam on cac ban da theo doi", "cam on cac ban da xem",
  "thanks for watching", "thank you for watching", "amara org",
] as const;

export interface DroppedSegment {
  source_id: string;
  start: number;
  end: number;
  text: string;
  reason: "low_score" | "hallucinated_phrase";
  /** The mean of the segment's word scores; null when it had none. */
  mean_score: number | null;
}

/** `clean-report.json`: what the cleaning kept and dropped, for a person looking into a strange survey. */
export interface TranscriptCleanReport {
  schema_version: "studio.transcript-clean/v1";
  min_mean_score: number;
  kept: number;
  dropped: DroppedSegment[];
}

/** Lower case, no Vietnamese marks (đ as d), letters and digits only, single spaces. */
export function foldText(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase()
    .replace(/[^a-z0-9]+/g, " ").trim();
}

function meanScore(words: readonly { score?: number | undefined }[]): number | null {
  const scores = words.map((w) => w.score).filter((s): s is number => typeof s === "number");
  return scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
}

/**
 * The farm's transcription without the segments nobody said: a segment whose words scored under
 * `MIN_MEAN_WORD_SCORE` on average, or, with no scores, one that says a sentence of `HALLUCINATED_PHRASES`. Same schema
 * as the farm's, so every stage reads it as before; a source left with nothing keeps its entry, its segments empty.
 */
export function cleanTranscribeManifest(m: TranscribeManifest): { manifest: TranscribeManifest; report: TranscriptCleanReport } {
  const dropped: DroppedSegment[] = [];
  let kept = 0;
  const sources = m.sources.map((s) => ({
    ...s,
    segments: s.segments.filter((seg) => {
      const mean = meanScore(seg.words);
      const folded = foldText(seg.text);
      const reason: DroppedSegment["reason"] | null =
        mean !== null ? (mean < MIN_MEAN_WORD_SCORE ? "low_score" : null)
        : HALLUCINATED_PHRASES.some((p) => ` ${folded} `.includes(` ${p} `)) ? "hallucinated_phrase" : null;
      if (!reason) { kept += 1; return true; }
      dropped.push({ source_id: s.source_id, start: seg.start, end: seg.end, text: seg.text, reason, mean_score: mean });
      return false;
    }),
  }));
  return {
    manifest: { ...m, sources },
    report: { schema_version: "studio.transcript-clean/v1", min_mean_score: MIN_MEAN_WORD_SCORE, kept, dropped },
  };
}
