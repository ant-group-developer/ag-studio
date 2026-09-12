import { describe, expect, it } from "vitest";
import { evaluateWhen, parseWhen } from "../../src/source-catalog/when.js";

describe("when expressions", () => {
  it("parses == and !=", () => {
    expect(parseWhen('options.voice == "tts"')).toEqual({ key: "voice", op: "==", value: "tts" });
    expect(parseWhen('options.avatar != "none"')).toEqual({ key: "avatar", op: "!=", value: "none" });
  });
  it("evaluates against options and treats a missing key as empty string", () => {
    expect(evaluateWhen('options.voice == "tts"', { voice: "tts" })).toBe(true);
    expect(evaluateWhen('options.voice == "tts"', { voice: "none" })).toBe(false);
    expect(evaluateWhen('options.avatar != "none"', {})).toBe(true);
  });
  it("rejects anything else", () => {
    expect(() => parseWhen("voice == tts")).toThrow();
  });
});
