import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { newId, type LibraryItem } from "@harness/contracts";
import { cli, freshLibraryWorld, writeActiveStyle, writeLibraryItem } from "../integration/library-helpers.js";

interface SyncReport {
  imported: { styles: string[]; requests: string[]; items: string[] };
  updated: { styles: string[]; requests: string[]; items: string[] };
  corrupt: { path: string; reason: string }[];
  missing: { kind: string; id: string }[];
}

// Acceptance 18: one bad file in the kho never costs the channel the rest of it. Two of five items are
// broken in the two ways that matter -- an unparseable manifest and a data file that no longer matches the
// checksum its manifest vouches for -- and the other three still import. `sync` exits 1 so an operator
// notices, but the mirror is usable. Hand-written files only, so no ffmpeg.
describe("acceptance 18: a corrupt file in the kho is isolated to its own item", () => {
  it("imports the three sound items, reports both broken ones, and exits 1", () => {
    const world = freshLibraryWorld({ media: false });
    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);

    const soundIds = [newId("library_item"), newId("library_item"), newId("library_item")];
    for (const itemId of soundIds) writeLibraryItem(world.lib, { itemId, styleId, status: "approved" });

    const brokenManifestId = newId("library_item");
    writeLibraryItem(world.lib, { itemId: brokenManifestId, styleId, status: "approved", corrupt: "manifest" });
    const badChecksumId = newId("library_item");
    writeLibraryItem(world.lib, { itemId: badChecksumId, styleId, status: "approved", corrupt: "checksum" });

    const sync = cli(world.channel, ["library", "sync", "--json"]);
    expect(sync.code, sync.out).toBe(1);
    const report = JSON.parse(sync.out) as SyncReport;

    expect(report.imported.items.sort()).toEqual([...soundIds].sort());
    expect(report.imported.styles).toEqual([styleId]);
    expect(report.corrupt).toHaveLength(2);

    const corruptPaths = report.corrupt.map((c) => c.path);
    expect(corruptPaths).toContain(join(world.lib, "items", brokenManifestId, "manifest.json"));
    expect(corruptPaths).toContain(join(world.lib, "items", badChecksumId, "episode.mp4"));
    expect(report.corrupt.find((c) => c.path.includes(badChecksumId))!.reason).toContain("checksum mismatch");
    // a corrupt item is "not yet there", not "gone": nothing is reported missing from the mirror
    expect(report.missing).toHaveLength(0);

    const listed = cli(world.channel, ["library", "list", "items", "--json"]);
    expect(listed.code, listed.err).toBe(0);
    const items = JSON.parse(listed.out) as LibraryItem[];
    expect(items.map((i) => i.item_id).sort()).toEqual([...soundIds].sort());

    // and the sound items are fully usable: one of them picks straight away
    const picked = cli(world.channel, ["library", "pick", soundIds[0]!, "--channel", "channel-one", "--json"]);
    expect(picked.code, picked.err).toBe(0);

    // once the owner rewrites the broken manifest, the next sync imports that item too and exits 0
    writeLibraryItem(world.lib, { itemId: brokenManifestId, styleId, status: "approved" });
    const second = cli(world.channel, ["library", "sync", "--json"]);
    expect(second.code, second.out).toBe(1); // the checksum-mismatched item is still broken
    const secondReport = JSON.parse(second.out) as SyncReport;
    expect(secondReport.imported.items).toEqual([brokenManifestId]);
    expect(secondReport.corrupt).toHaveLength(1);
  });
});
