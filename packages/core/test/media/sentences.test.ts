import { describe, expect, it } from "vitest";
import { splitSentences } from "../../src/media/sentences.js";

// A small maxChars isolates sentence-boundary detection from the maxChars packing step (step 3 merges
// adjacent sentences back together whenever they fit within maxChars -- with the realistic default of 280
// every sentence below would merge back into one chunk, which is exactly what the "packs sentences up to
// maxChars" test further down is checking). Each maxChars here sits between the longest individual sentence
// and the two sentences' combined length, so splitting is visible without a merge undoing it.
describe("splitSentences", () => {
  it("does not split a decimal point (3.5) mid-sentence", () => {
    const out = splitSentences("Giá là 3.5 triệu. Xong.", "vi", 20);
    expect(out).toEqual(["Giá là 3.5 triệu.", "Xong."]);
  });

  it("does not split after a known English abbreviation", () => {
    const out = splitSentences("Dr. Smith came. He left.", "en", 20);
    expect(out).toEqual(["Dr. Smith came.", "He left."]);
  });

  it("does not split after a known Vietnamese abbreviation, including one with an internal dot", () => {
    const out = splitSentences("TP. Hồ Chí Minh đẹp. Thật.", "vi", 20);
    expect(out).toEqual(["TP. Hồ Chí Minh đẹp.", "Thật."]);
  });

  it("primary-subtag lookup: en-US resolves the same abbreviation list as en", () => {
    const out = splitSentences("Dr. Smith came. He left.", "en-US", 20);
    expect(out).toEqual(["Dr. Smith came.", "He left."]);
  });

  it("an unknown language only gets the (automatic) decimal-point exception, no abbreviation list", () => {
    const out = splitSentences("Дэ. Смит пришел.", "ru", 15);
    expect(out).toEqual(["Дэ.", "Смит пришел."]);
  });

  it("merges adjacent short sentences up to maxChars", () => {
    const out = splitSentences("One. Two. Three.", "en", 280);
    expect(out).toEqual(["One. Two. Three."]);
  });

  it("a long sentence with commas: every chunk <= maxChars, rejoining with \" \" reproduces the input", () => {
    const maxChars = 280;
    const words = Array.from({ length: 120 }, (_, i) => `word${i}`);
    const sentence = `${words.join(", ")}.`;
    expect(sentence.length).toBeGreaterThan(600);

    const out = splitSentences(sentence, "en", maxChars);
    expect(out.length).toBeGreaterThan(1);
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(maxChars);
    expect(out.join(" ")).toBe(sentence);
  });

  it("no comma, no space: hard-cuts at maxChars (join adds a space the source never had)", () => {
    const maxChars = 280;
    const sentence = `${"a".repeat(650)}.`;
    const out = splitSentences(sentence, "en", maxChars);
    for (const chunk of out) expect(chunk.length).toBeLessThanOrEqual(maxChars);
    expect(out.every((c) => c.length > 0)).toBe(true);
    // hard-cut exception: rejoining inserts spaces the original text never had, so compare with spaces stripped
    expect(out.join(" ").replace(/ /g, "")).toBe(sentence.replace(/ /g, ""));
  });

  it("returns [] for an all-whitespace (or empty) string", () => {
    expect(splitSentences("   \n\t  ", "en", 280)).toEqual([]);
    expect(splitSentences("", "en", 280)).toEqual([]);
  });

  it("never returns an empty-string chunk", () => {
    const out = splitSentences("Hi. ", "en", 280);
    expect(out.every((c) => c.length > 0)).toBe(true);
  });

  it("normalizes internal whitespace runs (including newlines) to a single space before splitting", () => {
    const out = splitSentences("Line one.\n\nLine   two.", "en", 280);
    expect(out).toEqual(["Line one. Line two."]);
  });
});
