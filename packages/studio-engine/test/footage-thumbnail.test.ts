/**
 * A thumbnail picked at the YouTube kit gate, before any render: a keyframe of one of the episode's videos with the
 * kit idea's words drawn on it, the person's, selected — and still the pick after a render replaces its suggestions.
 */
import { describe, expect, it } from "vitest";
import {
  footageThumbnail, getEpisode, listThumbnails, MemoryBucket, replaceEpisodes, replaceRenderThumbnails, selectedThumbnail,
} from "../src/index.js";
import { fakeThumbnails, seedProduction, world } from "./helpers.js";

describe("footageThumbnail", () => {
  it("keeps the keyframe as the person's frame, draws the idea's words on it and picks it; a render keeps the pick", async () => {
    const w = world();
    const prod = seedProduction(w.db);
    replaceEpisodes(w.db, prod, [{ id: "ep-1", idx: 1, title: "T", hook: "h", plan: "{}" }], "plan-run");
    const renderer = fakeThumbnails();
    const d = { core: w.core, db: w.db, bucket: new MemoryBucket() };
    const ep = getEpisode(w.db, "ep-1")!;
    const picked = await footageThumbnail(d, renderer, ep, { assetId: "a1", image: Buffer.from("jpeg"), text: "Lúa vàng", userId: "auth0|editor" });
    expect(picked).toMatchObject({ kind: "composed", text: "Lúa vàng", asset_id: "a1", created_by: "auth0|editor" });
    expect(renderer.calls[0]).toBe("normalize");
    expect(renderer.calls[1]).toMatch(/^compose /);
    expect(listThumbnails(w.db, "ep-1").map((t) => [t.kind, t.asset_id])).toEqual(expect.arrayContaining([["frame", "a1"], ["composed", "a1"]]));
    expect(selectedThumbnail(w.db, getEpisode(w.db, "ep-1")!)?.id).toBe(picked.id);

    // the render's own frames and suggestions replace the system ones, never the person's pick
    replaceRenderThumbnails(w.db, "ep-1", "run-render", null);
    expect(selectedThumbnail(w.db, getEpisode(w.db, "ep-1")!)?.id).toBe(picked.id);

    // no words: the clean keyframe is the pick
    const clean = await footageThumbnail(d, renderer, ep, { assetId: "a2", image: Buffer.from("jpeg"), text: null, userId: "auth0|editor" });
    expect(clean).toMatchObject({ kind: "frame", asset_id: "a2", text: null });
    expect(selectedThumbnail(w.db, getEpisode(w.db, "ep-1")!)?.id).toBe(clean.id);
    w.core.close();
  });
});
