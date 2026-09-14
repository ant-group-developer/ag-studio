import { describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { newId, type LibraryItem } from "@harness/contracts";
import { SqliteStateStore } from "@harness/core";
import { cli, freshLibraryWorld, librarySync, writeActiveStyle, writeLibraryItem } from "../integration/library-helpers.js";

// Acceptance 17: a channel can only ever `pick` an item the studio has approved. `pending_review` (still
// being reviewed), `rejected` (reviewed and turned down) and `withdrawn` (the kho's stand-in for deletion)
// are all refused, and refusing leaves no claim file behind. Hand-written manifests only, so no ffmpeg.
describe("acceptance 17: an unapproved library item is never picked", () => {
  it("refuses pending_review, rejected and withdrawn, and claims only the approved item", () => {
    const world = freshLibraryWorld({ media: false });
    const styleId = newId("edit_style");
    writeActiveStyle(world.lib, styleId);

    const unapproved: LibraryItem["status"][] = ["pending_review", "rejected", "withdrawn"];
    const ids = new Map<LibraryItem["status"], string>();
    for (const status of [...unapproved, "approved" as const]) {
      const itemId = newId("library_item");
      ids.set(status, itemId);
      writeLibraryItem(world.lib, { itemId, styleId, status, titleHint: `Tập ${status}` });
    }

    // every item is intact as far as the kho is concerned: what differs is only its review status
    const synced = librarySync(world.channel);
    expect(synced.imported.items).toHaveLength(4);
    expect(synced.corrupt).toHaveLength(0);

    for (const status of unapproved) {
      const itemId = ids.get(status)!;
      const picked = cli(world.channel, ["library", "pick", itemId, "--channel", "channel-one"]);
      expect(picked.code, `${status} should not be pickable: ${picked.out}`).toBe(1);
      expect(picked.err).toContain("INVALID_TRANSITION");
      expect(picked.err).toContain(status);
      expect(existsSync(join(world.lib, "items", itemId, "claims", "channel-one.json"))).toBe(false);
    }

    const approvedId = ids.get("approved")!;
    const picked = cli(world.channel, ["library", "pick", approvedId, "--channel", "channel-one", "--json"]);
    expect(picked.code, picked.err).toBe(0);
    const contentId = (JSON.parse(picked.out) as { content_id: string }).content_id;
    expect(existsSync(join(world.lib, "items", approvedId, "claims", "channel-one.json"))).toBe(true);

    // exactly one local ContentItem was minted, and it points at the approved item
    const store = new SqliteStateStore(join(world.channel, "data", "state", "harness.db"));
    try {
      const contents = store.listContentItems();
      expect(contents).toHaveLength(1);
      expect(contents[0]!.content_id).toBe(contentId);
      expect(contents[0]!.library_item_id).toBe(approvedId);
    } finally {
      store.close();
    }

    // and the refusal is not a mirror artefact: the DB still lists all four items
    expect((JSON.parse(cli(world.channel, ["library", "list", "items", "--json"]).out) as LibraryItem[])).toHaveLength(4);
  });
});
