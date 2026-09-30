import { describe, expect, it } from "vitest";
import { productionVoice } from "../src/voice.js";

describe("productionVoice", () => {
  it("keeps the voice a production chose", () => {
    const own = { reference: "library:voices/an.wav", reference_text: "Xin chào", speed: 1.1 };
    expect(productionVoice(JSON.stringify(own), { STUDIO_DEFAULT_VOICE_REFERENCE: "library:voices/default.wav" })).toEqual(own);
  });

  it("falls back to the Studio default voice", () => {
    expect(productionVoice(null, { STUDIO_DEFAULT_VOICE_REFERENCE: " library:voices/default.wav ", STUDIO_DEFAULT_VOICE_TEXT: "Câu mẫu." }))
      .toEqual({ reference: "library:voices/default.wav", reference_text: "Câu mẫu.", speed: 1 });
  });

  it("has no reference when no default is configured", () => {
    expect(productionVoice(null, {})).toEqual({ reference: null, reference_text: null, speed: 1 });
  });
});
