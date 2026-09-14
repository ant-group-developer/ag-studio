import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { isHarnessError, LibraryClaimSchema, newId } from "@harness/contracts";
import { LibraryFs, libraryPaths } from "../../src/index.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "library-"));
}

describe("libraryPaths", () => {
  it("builds paths for every kho entity", () => {
    const root = tempRoot();
    const p = libraryPaths(root);
    expect(p.styleDir("style_x")).toBe(join(root, "styles", "style_x"));
    expect(p.styleFile("style_x")).toBe(join(root, "styles", "style_x", "style.json"));
    expect(p.requestFile("req_x")).toBe(join(root, "requests", "req_x.json"));
    expect(p.itemDir("item_x")).toBe(join(root, "items", "item_x"));
    expect(p.manifest("item_x")).toBe(join(root, "items", "item_x", "manifest.json"));
    expect(p.claimsDir("item_x")).toBe(join(root, "items", "item_x", "claims"));
    expect(p.claimFile("item_x", "chan_a")).toBe(join(root, "items", "item_x", "claims", "chan_a.json"));
    expect(p.index).toBe(join(root, "index.json"));
  });
});

describe("LibraryFs.exists", () => {
  it("is true only when root is a directory", () => {
    const root = tempRoot();
    expect(new LibraryFs({ root, role: "studio" }).exists()).toBe(true);
    expect(new LibraryFs({ root: join(root, "nope"), role: "studio" }).exists()).toBe(false);
  });
});

describe("LibraryFs.writeJsonAtomic", () => {
  it("writes the file and leaves no .tmp- sibling", () => {
    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    const path = fs.paths.styleFile("style_a");
    fs.writeJsonAtomic(path, { hello: "world" });
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ hello: "world" });
    expect(readdirSync(join(root, "styles", "style_a")).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  it("throws IO_ERROR and leaves no dangling tmp file when the write fails midway", () => {
    const root = tempRoot();
    mkdirSync(join(root, "styles"), { recursive: true });
    const blocker = join(root, "styles", "blocker");
    writeFileSync(blocker, "not a directory");
    const fs = new LibraryFs({ root, role: "studio" });
    const path = join(blocker, "style.json");
    let caught: unknown;
    try {
      fs.writeJsonAtomic(path, { a: 1 });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "IO_ERROR")).toBe(true);
    expect(readdirSync(join(root, "styles")).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });
});

describe("LibraryFs writes against an unmounted kho", () => {
  it("writeJsonAtomic throws IO_ERROR and scaffolds nothing when the root is gone", () => {
    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    rmSync(root, { recursive: true, force: true });

    let caught: unknown;
    try {
      fs.writeJsonAtomic(fs.paths.styleFile("style_a"), { ok: true });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "IO_ERROR")).toBe(true);
    expect((caught as { details: { root: string } }).details.root).toBe(fs.paths.root);
    // the whole point: no local directory tree standing in for a share that is not mounted
    expect(existsSync(root)).toBe(false);
    expect(existsSync(fs.paths.styles)).toBe(false);
  });

  it("copyFileWithChecksum throws IO_ERROR and scaffolds nothing when the root is gone", async () => {
    const raw = tempRoot();
    const src = join(raw, "episode.mp4");
    writeFileSync(src, "fake episode bytes");

    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    rmSync(root, { recursive: true, force: true });

    let caught: unknown;
    try {
      await fs.copyFileWithChecksum(src, join(fs.paths.itemDir("item_a"), "episode.mp4"));
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "IO_ERROR")).toBe(true);
    expect(existsSync(root)).toBe(false);
    expect(existsSync(fs.paths.items)).toBe(false);
  });
});

describe("LibraryFs role-based write guard", () => {
  it("studio may write under styles/; channel may not", () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    expect(() => studio.writeJsonAtomic(studio.paths.styleFile("style_a"), { ok: true })).not.toThrow();

    const channel = new LibraryFs({ root, role: "channel" });
    let caught: unknown;
    try {
      channel.writeJsonAtomic(channel.paths.styleFile("style_b"), { ok: true });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });

  it("channel may write item claims; studio may not", () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    const claimPath = channel.paths.claimFile("item_a", "chan_a");
    expect(() => channel.writeJsonAtomic(claimPath, { channel_id: "chan_a" })).not.toThrow();

    const studio = new LibraryFs({ root, role: "studio" });
    let caught: unknown;
    try {
      studio.writeJsonAtomic(claimPath, { channel_id: "chan_a" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });

  it("studio may still write other item files (manifest, media)", () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    expect(() => studio.writeJsonAtomic(studio.paths.manifest("item_a"), { ok: true })).not.toThrow();
  });

  it("channel creates requests/*.json; studio may only overwrite an existing one", () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    const path = channel.paths.requestFile("req_a");
    expect(() => channel.writeJsonAtomic(path, { status: "open" })).not.toThrow();

    const studio = new LibraryFs({ root, role: "studio" });
    let caught: unknown;
    try {
      studio.writeJsonAtomic(studio.paths.requestFile("req_b"), { status: "open" });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);

    expect(() => studio.writeJsonAtomic(path, { status: "claimed" })).not.toThrow();
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ status: "claimed" });
  });

  it("studio may write index.json", () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    expect(() => studio.writeJsonAtomic(studio.paths.index, { generated_at: "now" })).not.toThrow();
  });

  it("rejects paths outside the library root regardless of role", () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    let caught: unknown;
    try {
      studio.assertWritable(join(root, "..", "escape.json"));
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });
});

describe("LibraryFs.readJson", () => {
  const schema = z.object({ n: z.number() }).strict();

  it("throws IO_ERROR when the file is missing or the JSON is corrupt", () => {
    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });

    let caught: unknown;
    try {
      fs.readJson(join(root, "missing.json"), schema);
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "IO_ERROR")).toBe(true);

    const corrupt = join(root, "corrupt.json");
    writeFileSync(corrupt, "{not json");
    caught = undefined;
    try {
      fs.readJson(corrupt, schema);
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "IO_ERROR")).toBe(true);
  });

  it("throws CONFIG_INVALID with issues in details when the schema does not match", () => {
    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    const path = join(root, "bad-schema.json");
    writeFileSync(path, JSON.stringify({ n: "not a number" }));
    let caught: unknown;
    try {
      fs.readJson(path, schema);
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
    expect(Array.isArray((caught as { details: { issues: unknown } }).details.issues)).toBe(true);
  });

  it("returns the parsed, typed value on success", () => {
    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    const path = join(root, "good.json");
    writeFileSync(path, JSON.stringify({ n: 7 }));
    expect(fs.readJson(path, schema)).toEqual({ n: 7 });
  });
});

describe("LibraryFs.copyFileWithChecksum / verifyFile", () => {
  it("copies the file atomically, checksums it, and verifies it back", async () => {
    const raw = tempRoot();
    const src = join(raw, "episode.mp4");
    writeFileSync(src, "fake episode bytes");

    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    const dest = join(fs.paths.itemDir("item_a"), "episode.mp4");
    const file = await fs.copyFileWithChecksum(src, dest);

    expect(file.path).toBe("episode.mp4");
    expect(file.mime_type).toBe("video/mp4");
    expect(existsSync(dest)).toBe(true);
    expect(readdirSync(fs.paths.itemDir("item_a")).filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(await fs.verifyFile(fs.paths.itemDir("item_a"), file)).toBe(true);

    writeFileSync(dest, "tampered bytes");
    expect(await fs.verifyFile(fs.paths.itemDir("item_a"), file)).toBe(false);
  });

  it("verifyFile returns false when the file is missing", async () => {
    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    const ok = await fs.verifyFile(fs.paths.itemDir("item_a"), {
      path: "nope.mp4",
      checksum: `sha256:${"0".repeat(64)}`,
      size_bytes: 1,
      mime_type: "video/mp4",
    });
    expect(ok).toBe(false);
  });
});

describe("LibraryFs listings", () => {
  it("listItemIds skips dirs without manifest.json and .tmp- entries", () => {
    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    fs.writeJsonAtomic(fs.paths.manifest("item_a"), { ok: true });
    mkdirSync(fs.paths.itemDir("item_b"), { recursive: true });
    mkdirSync(join(fs.paths.items, ".tmp-abc"), { recursive: true });
    writeFileSync(join(fs.paths.items, ".tmp-abc", "manifest.json"), "{}");

    expect(fs.listItemIds()).toEqual(["item_a"]);
  });

  it("listStyleIds requires style.json; listRequestIds strips the .json extension", () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    studio.writeJsonAtomic(studio.paths.styleFile("style_a"), { ok: true });
    mkdirSync(studio.paths.styleDir("style_b"), { recursive: true });

    const channel = new LibraryFs({ root, role: "channel" });
    channel.writeJsonAtomic(channel.paths.requestFile("req_a"), { ok: true });

    expect(studio.listStyleIds()).toEqual(["style_a"]);
    expect(studio.listRequestIds()).toEqual(["req_a"]);
  });

  it("skips every dot-name, so doctor's probe file is never mistaken for a request/style/item", () => {
    const root = tempRoot();
    const studio = new LibraryFs({ root, role: "studio" });
    const channel = new LibraryFs({ root, role: "channel" });
    studio.writeJsonAtomic(studio.paths.styleFile("style_a"), { ok: true });
    studio.writeJsonAtomic(studio.paths.manifest("item_a"), { ok: true });
    channel.writeJsonAtomic(channel.paths.requestFile("req_a"), { ok: true });

    // exactly what `doctor`'s library:write probe leaves behind if it ever fails to remove itself
    writeFileSync(join(channel.paths.requests, ".doctor-channel-6f9b.tmp"), "{}");
    writeFileSync(join(studio.paths.styles, ".doctor-studio-6f9b.tmp"), "{}");
    // and a dot-directory that happens to carry a manifest/style file
    mkdirSync(join(studio.paths.items, ".hidden-item"), { recursive: true });
    writeFileSync(join(studio.paths.items, ".hidden-item", "manifest.json"), "{}");
    mkdirSync(join(studio.paths.styles, ".hidden-style"), { recursive: true });
    writeFileSync(join(studio.paths.styles, ".hidden-style", "style.json"), "{}");

    expect(studio.listRequestIds()).toEqual(["req_a"]);
    expect(studio.listStyleIds()).toEqual(["style_a"]);
    expect(studio.listItemIds()).toEqual(["item_a"]);
  });

  it("returns empty arrays when the respective directories don't exist yet", () => {
    const root = tempRoot();
    const fs = new LibraryFs({ root, role: "studio" });
    expect(fs.listStyleIds()).toEqual([]);
    expect(fs.listRequestIds()).toEqual([]);
    expect(fs.listItemIds()).toEqual([]);
    expect(fs.listClaims("item_a")).toEqual([]);
  });

  it("listClaims parses valid claim files and silently skips corrupt ones", () => {
    const root = tempRoot();
    const channel = new LibraryFs({ root, role: "channel" });
    const claim = LibraryClaimSchema.parse({
      schema_version: "harness.library-claim/v1",
      item_id: newId("library_item"),
      channel_id: "chan_a",
      portfolio_id: "port_a",
      claimed_at: new Date().toISOString(),
    });
    channel.writeJsonAtomic(channel.paths.claimFile("item_a", "chan_a"), claim);
    mkdirSync(channel.paths.claimsDir("item_a"), { recursive: true });
    writeFileSync(join(channel.paths.claimsDir("item_a"), "chan_bad.json"), "{not json");

    const claims = channel.listClaims("item_a");
    expect(claims).toHaveLength(1);
    expect(claims[0].channel_id).toBe("chan_a");
  });
});
