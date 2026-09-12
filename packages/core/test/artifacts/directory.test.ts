import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyTree, directoryDigest, listDirectoryFiles } from "../../src/artifacts/directory.js";
import { sha256String } from "../../src/artifacts/checksum.js";

describe("directory artifacts", () => {
  it("lists files recursively with stable order and forward slashes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "da-"));
    mkdirSync(join(dir, "b")); writeFileSync(join(dir, "b", "2.txt"), "two"); writeFileSync(join(dir, "1.txt"), "one");
    const entries = await listDirectoryFiles(dir);
    expect(entries).toEqual([
      { path: "1.txt", checksum: sha256String("one"), size_bytes: 3 },
      { path: "b/2.txt", checksum: sha256String("two"), size_bytes: 3 },
    ]);
    const d1 = directoryDigest(entries);
    expect(d1.size_bytes).toBe(6);
    writeFileSync(join(dir, "b", "2.txt"), "TWO");
    expect(directoryDigest(await listDirectoryFiles(dir)).checksum).not.toBe(d1.checksum);
  });
  it("copies a tree", async () => {
    const src = mkdtempSync(join(tmpdir(), "da-")); mkdirSync(join(src, "x")); writeFileSync(join(src, "x", "f.bin"), "z");
    const dest = join(mkdtempSync(join(tmpdir(), "da-")), "copy");
    await copyTree(src, dest);
    expect(readFileSync(join(dest, "x", "f.bin"), "utf8")).toBe("z");
  });
});
