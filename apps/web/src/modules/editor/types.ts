import type { StudioClient } from "../../api/studio-client";

/** The slice of `StudioClient` the episode editor needs -- injectable so the playground can use an in-memory fake. */
export type EditorClient = Pick<
  StudioClient,
  | "getTimeline"
  | "saveRevision"
  | "renderPreview"
  | "getEditorJob"
  | "getAssetMedia"
  | "getProductionCatalog"
>;

/** Map asset_id -> media info (null when footage is not in scope or not ready). */
export type AssetMediaLookup = (assetId: string) => Promise<import("../../api/studio-client").AssetMedia | null>;
