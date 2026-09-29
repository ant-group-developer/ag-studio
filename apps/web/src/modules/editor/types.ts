import type { StudioClient } from "../../api/studio-client";
import type { MediaLookup } from "../common/media";

/** The slice of `StudioClient` the editor needs -- injectable so the playground can use an in-memory fake. */
export type EditorClient = Pick<
  StudioClient,
  | "getTimeline"
  | "saveRevision"
  | "ttsLine"
  | "renderPreview"
  | "getEditorJob"
  | "audioUrl"
  | "submitGate"
  | "getStageDocument"
>;

export type { MediaLookup };
