import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalDigest, canonicalJson, sha256File, sha256String } from "../../src/artifacts/checksum.js";

describe("checksum", () => {
  it("canonicalises key order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
    expect(canonicalDigest({ b: 1, a: 2 })).toBe(canonicalDigest({ a: 2, b: 1 }));
    expect(canonicalDigest({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("hashes files and strings identically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ck-"));
    writeFileSync(join(dir, "f.txt"), "hello");
    const r = await sha256File(join(dir, "f.txt"));
    expect(r).toEqual({ checksum: sha256String("hello"), size_bytes: 5 });
    expect(r.checksum).toBe("sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
  });
});
