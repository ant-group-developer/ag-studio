/**
 * The voice a production's narration is read in. OmniVoice clones a reference recording and cannot read
 * without one, so a production with no voice of its own uses the Studio default:
 * `STUDIO_DEFAULT_VOICE_REFERENCE` (a logical input the render worker signs, e.g. `library:voices/default.wav`
 * in the Studio bucket) and `STUDIO_DEFAULT_VOICE_TEXT` (what is said in that recording).
 */
import type { StudioTtsPayload } from "@ag-farm/protocol";

export type StudioVoice = StudioTtsPayload["voice"];

export function productionVoice(voiceJson: string | null, env: Record<string, string | undefined> = process.env): StudioVoice {
  if (voiceJson) return JSON.parse(voiceJson) as StudioVoice;
  const reference = env.STUDIO_DEFAULT_VOICE_REFERENCE?.trim() || null;
  const referenceText = env.STUDIO_DEFAULT_VOICE_TEXT?.trim() || null;
  return { reference, reference_text: reference ? referenceText : null, speed: 1 };
}
