/**
 * The voice a production's narration is read in (ADR-0001 item 167). OmniVoice clones a reference recording and
 * cannot read without one. `productions.voice` is NULL until the person is asked; then it is a sample they gave
 * (`clone`) or narration declined for the whole production (`none`). NULL falls back to the Studio default
 * `STUDIO_DEFAULT_VOICE_REFERENCE` (a logical input the render worker signs, e.g. `library:voices/default.wav`) and
 * `STUDIO_DEFAULT_VOICE_TEXT` (what is said in it); without one the voice is `missing` and the episode asks.
 */
import type { StudioTtsPayload } from "@ag-farm/protocol";
import { ProductionVoiceSchema } from "@harness/contracts";

export type StudioVoice = StudioTtsPayload["voice"];

export type NarrationVoice = { kind: "clone"; voice: StudioVoice } | { kind: "none" } | { kind: "missing" };

export function productionVoice(voiceJson: string | null, env: Record<string, string | undefined> = process.env): NarrationVoice {
  if (voiceJson) {
    const v = ProductionVoiceSchema.parse(JSON.parse(voiceJson));
    if ("mode" in v && v.mode === "none") return { kind: "none" };
    // a machine voice still being made: episodes wait for it as for a missing one (never the Studio default)
    if ("mode" in v && v.mode === "designing") return { kind: "missing" };
    // the voice the farm reads with and the voice store keys by: reference, its text, speed (nothing about provenance)
    if (v.reference) return { kind: "clone", voice: { reference: v.reference, reference_text: v.reference_text, speed: v.speed } };
  }
  const reference = env.STUDIO_DEFAULT_VOICE_REFERENCE?.trim() || null;
  if (!reference) return { kind: "missing" };
  return { kind: "clone", voice: { reference, reference_text: env.STUDIO_DEFAULT_VOICE_TEXT?.trim() || null, speed: 1 } };
}
