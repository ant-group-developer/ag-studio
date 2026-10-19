/**
 * @ag-studio/render — public API for composition rendering.
 *
 * Re-exports the two-tier ffmpeg renderer (`renderComposition`, `probeNvenc`)
 * and its dependency/input types so callers only need to depend on this package
 * rather than on the full `@harness/core` monolith.
 *
 * Also re-exports CompositionSchema and Composition type from @harness/contracts
 * so ag-render-worker can validate compositions without a separate contracts dep.
 */
export { renderComposition, probeNvenc, RENDER_FEATURE_LEVEL, RENDER_INSPECT_LEVEL, RENDER_FONT_LEVEL, RENDER_PREMIERE_SCALE_LEVEL, compositionFeatureLevel, inspectRender, INSPECT_FILE } from "@harness/core";
export type { OutputTier, RenderDeps, RenderInput, SpawnFn, InspectDeps, InspectInput } from "@harness/core";
export { studioOverlayAss, studioDefaultBrand, studioFontFamilies, studioScriptFont, STUDIO_DEFAULT_FONT } from "@harness/core";
export { CompositionSchema, TEXT_FONTS } from "@harness/contracts";
export type { TextFont } from "@harness/contracts";
export type { Composition, RenderInspection } from "@harness/contracts";
