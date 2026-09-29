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
export { renderComposition, probeNvenc } from "@harness/core";
export type { RenderDeps, RenderInput, SpawnFn } from "@harness/core";
export { CompositionSchema } from "@harness/contracts";
export type { Composition } from "@harness/contracts";
