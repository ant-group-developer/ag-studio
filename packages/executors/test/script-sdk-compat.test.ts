import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { directoryDigest, listDirectoryFiles } from "@harness/core";
import { directoryListing } from "@harness/script-sdk";

describe("script-sdk directory digest matches core", () => {
  it("same checksum and size for a nested tree", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmp-"));
    mkdirSync(join(dir, "sub")); writeFileSync(join(dir, "b.txt"), "bb"); writeFileSync(join(dir, "sub", "a.txt"), "a");
    const core = directoryDigest(await listDirectoryFiles(dir));
    const sdk = directoryListing(dir);
    expect(sdk.checksum).toBe(core.checksum);
    expect(sdk.size_bytes).toBe(core.size_bytes);
  });
});
