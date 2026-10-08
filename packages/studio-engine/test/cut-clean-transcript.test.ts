import { describe, expect, it } from "vitest";
import { TRANSCRIBE_MANIFEST_SCHEMA, TranscribeManifestSchema, type TranscribeManifest } from "@ag-farm/protocol";
import { STUDIO_TYPES } from "@harness/core";
import { cleanTranscribeManifest, cutStages, foldText, MIN_MEAN_WORD_SCORE, type TranscriptCleanReport } from "../src/index.js";
import { fakeFootage, world } from "./helpers.js";
import { runStage, stageWorkspace } from "./stage-harness.js";

const words = (text: string, score?: number) =>
  text.split(" ").map((word, i) => ({ word, start: i * 0.4, end: i * 0.4 + 0.3, ...(score === undefined ? {} : { score }) }));

/** The Ninh Bình train: a guide talking, the PA in English, and what Whisper made up over the engine noise. */
function manifest(): TranscribeManifest {
  return TranscribeManifestSchema.parse({
    schema: TRANSCRIBE_MANIFEST_SCHEMA, production_id: "p1", engine: { name: "whisperx", version: "3.1" },
    sources: [
      {
        source_id: "src-a", language: "vi", alignment: "word",
        segments: [
          { start: 0, end: 3, text: "Đây là ga Ninh Bình", words: words("Đây là ga Ninh Bình", 0.82) },
          { start: 10, end: 13, text: "Hãy đăng ký kênh để không bỏ lỡ những video hấp dẫn", words: words("Hãy đăng ký kênh để không bỏ lỡ", 0.01) },
          { start: 20, end: 22, text: "Mời bạn đăng ký kênh của tôi", words: words("Mời bạn đăng ký kênh của tôi", 0.9) },
        ],
      },
      {
        source_id: "src-b", language: "en", alignment: "segment",
        segments: [
          { start: 0, end: 4, text: "The next station is Ninh Binh.", words: [] },
          { start: 30, end: 32, text: "Thanks for watching!", words: [] },
          { start: 40, end: 42, text: "HÃY ĐĂNG KÝ KÊNH!!", words: [] },
          { start: 50, end: 52, text: "Our subscribers asked about the bridge", words: [] },
        ],
      },
    ],
  });
}

describe("cleanTranscribeManifest", () => {
  it("drops what scored under the bar and, with no scores, Whisper's made-up outros; keeps the rest as it was", () => {
    const { manifest: out, report } = cleanTranscribeManifest(manifest());
    expect(out.sources.map((s) => s.segments.map((x) => x.start))).toEqual([[0, 20], [0, 50]]);
    // a person who says it clearly is judged by the scores, not the phrase
    expect(out.sources[0]!.segments[1]!.text).toBe("Mời bạn đăng ký kênh của tôi");
    expect(report).toMatchObject({ schema_version: "studio.transcript-clean/v1", min_mean_score: MIN_MEAN_WORD_SCORE, kept: 4 });
    expect(report.dropped.map((d) => [d.source_id, d.start, d.reason])).toEqual([
      ["src-a", 10, "low_score"], ["src-b", 30, "hallucinated_phrase"], ["src-b", 40, "hallucinated_phrase"],
    ]);
    expect(report.dropped[0]!.mean_score).toBeCloseTo(0.01);
    expect(report.dropped[1]!.mean_score).toBeNull();
    expect(TranscribeManifestSchema.parse(out)).toEqual(out);
  });

  it("a source left with nothing keeps its entry; an empty transcription stays empty", () => {
    const m = manifest();
    m.sources = [{ ...m.sources[1]!, segments: [m.sources[1]!.segments[1]!] }];
    expect(cleanTranscribeManifest(m).manifest.sources).toEqual([{ ...m.sources[0]!, segments: [] }]);
    expect(cleanTranscribeManifest({ ...m, sources: [] }).report).toMatchObject({ kept: 0, dropped: [] });
  });

  it("folds case, Vietnamese marks and punctuation", () => {
    expect(foldText("  HÃY Đăng-ký   kênh!! ")).toBe("hay dang ky kenh");
  });
});

describe("studio-cut-clean-transcript", () => {
  it("writes the cleaned transcribe.json and what it dropped", async () => {
    const { db, bucket } = world();
    const stages = cutStages({ db, bucket, footage: fakeFootage(), startEpisodeRun: async () => ({ runId: "x" }) });
    const run = stageWorkspace({ runId: "run-cut", stageKey: "clean-transcript", inputs: [{ type: STUDIO_TYPES.transcript, name: "transcribe.json", json: manifest() }] });
    await runStage(stages["studio-cut-clean-transcript"], run);

    const out = TranscribeManifestSchema.parse(run.json("transcribe.json"));
    expect(out.sources.flatMap((s) => s.segments).map((x) => x.text)).not.toContain("Thanks for watching!");
    expect(run.json<TranscriptCleanReport>("clean-report.json").dropped).toHaveLength(3);
    expect(run.logs.find((l) => l.msg === "transcript cleaned")?.fields).toEqual({ kept: 4, dropped: 3, low_score: 1, phrases: 2 });
  });
});
