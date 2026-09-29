import type { SegmentMedia } from "../../api/ag-go-client";

/** Looks up a footage segment's media, scoped to the viewer's own footage access. `null` = out of scope. */
export type MediaLookup = (segmentId: string) => Promise<SegmentMedia | null>;
