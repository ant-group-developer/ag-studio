import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isHarnessError } from "@harness/contracts";
import { LibraryFs, loadBrand, setBrand, verifyBrandFiles } from "../../src/index.js";
import { makeTinyPng, openTempStore } from "../helpers.js";

function tempRoot(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function world() {
  const root = tempRoot("library-brands-kho-");
  const fs = new LibraryFs({ root, role: "channel" });
  const { store, clock } = openTempStore();
  return { root, fs, store, clock, d: { fs, store, clock } };
}

/** Builds a `brand.json` source file (outside the kho) plus the font/logo files it references, mirroring the
 * spec §2.1 sample: fonts/logo paths in the source are relative to the directory containing it. */
function buildSource(o: { channel_id: string; withLogo?: boolean; regularName?: string; boldName?: string; skipRegular?: boolean; skipBold?: boolean }): string {
  const dir = tempRoot("library-brands-src-");
  const fontsDir = join(dir, "fonts");
  mkdirSync(fontsDir, { recursive: true });
  const regularName = o.regularName ?? "Regular.ttf";
  const boldName = o.boldName ?? "Bold.ttf";
  if (!o.skipRegular) writeFileSync(join(fontsDir, regularName), "fake regular font bytes");
  if (!o.skipBold) writeFileSync(join(fontsDir, boldName), "fake bold font bytes");
  if (o.withLogo) makeTinyPng(join(dir, "logo.png"), 8);

  const brand = {
    schema_version: "harness.brand/v1",
    channel_id: o.channel_id,
    revision: 1,
    fonts: { regular: `fonts/${regularName}`, bold: `fonts/${boldName}`, origin: "royalty_free", origin_note: "OFL 1.1" },
    colors: { primary: "#F2C94C" },
    ...(o.withLogo ? { logo: { path: "logo.png" } } : {}),
  };
  const path = join(dir, "brand.json");
  writeFileSync(path, JSON.stringify(brand, null, 2));
  return path;
}

describe("setBrand", () => {
  it("copies fonts + logo into the kho, revision 1, checksums for all three keys, kho-relative paths", async () => {
    const { d, fs } = world();
    const source = buildSource({ channel_id: "ch1", withLogo: true });

    const brand = await setBrand(d, { channel_id: "ch1", source_path: source });

    expect(brand.revision).toBe(1);
    expect(Object.keys(brand.checksums).sort()).toEqual(["fonts.bold", "fonts.regular", "logo"]);
    for (const c of Object.values(brand.checksums)) expect(c).toMatch(/^sha256:[0-9a-f]{64}$/);

    expect(brand.fonts.regular).toBe("fonts/Regular.ttf");
    expect(brand.fonts.bold).toBe("fonts/Bold.ttf");
    expect(brand.logo?.path).toBe("logo.png");

    // files really landed under brands/ch1/
    expect(fs.paths.root).toBeTruthy();
    const loaded = loadBrand(fs, "ch1");
    expect(loaded).not.toBeNull();
    expect(loaded!.font_regular_path).toBe(join(fs.paths.brandDir("ch1"), "fonts", "Regular.ttf"));
    expect(loaded!.logo_path).toBe(join(fs.paths.brandDir("ch1"), "logo.png"));

    expect(d.store.getBrandProfile("ch1")).toEqual(brand);
  });

  it("without a logo: no logo checksum, logo null, still revision 1", async () => {
    const { d } = world();
    const source = buildSource({ channel_id: "ch1", withLogo: false });

    const brand = await setBrand(d, { channel_id: "ch1", source_path: source });

    expect(brand.revision).toBe(1);
    expect(Object.keys(brand.checksums).sort()).toEqual(["fonts.bold", "fonts.regular"]);
    expect(brand.logo).toBeUndefined();
  });

  it("setting the same channel again bumps revision to 2 and keeps created_at", async () => {
    const { d } = world();
    const first = await setBrand(d, { channel_id: "ch1", source_path: buildSource({ channel_id: "ch1", withLogo: true }) });

    d.clock.advance(60);
    const second = await setBrand(d, { channel_id: "ch1", source_path: buildSource({ channel_id: "ch1", withLogo: true }) });

    expect(second.revision).toBe(2);
    expect(second.created_at).toBe(first.created_at);
    expect(second.updated_at).not.toBe(first.updated_at);
  });

  it("rejects a source whose channel_id does not match --channel_id, without touching the kho", async () => {
    const { d, fs } = world();
    const source = buildSource({ channel_id: "ch2", withLogo: false });

    let caught: unknown;
    try {
      await setBrand(d, { channel_id: "ch1", source_path: source });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
    expect(fs.listBrandChannelIds()).toEqual([]);
  });

  it("rejects a missing fonts.regular file, naming it, without touching the kho", async () => {
    const { d, fs } = world();
    const source = buildSource({ channel_id: "ch1", withLogo: false, skipRegular: true });

    let caught: unknown;
    try {
      await setBrand(d, { channel_id: "ch1", source_path: source });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
    expect(String((caught as { message: string }).message)).toContain("Regular.ttf");
    expect(fs.listBrandChannelIds()).toEqual([]);
  });

  it("rejects a font extension that is not .ttf/.otf", async () => {
    const { d, fs } = world();
    const source = buildSource({ channel_id: "ch1", withLogo: false, regularName: "Regular.woff" });

    let caught: unknown;
    try {
      await setBrand(d, { channel_id: "ch1", source_path: source });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
    expect(fs.listBrandChannelIds()).toEqual([]);
  });

  it("rejects a logo extension that is not .png", async () => {
    const dir = tempRoot("library-brands-src-badlogo-");
    const fontsDir = join(dir, "fonts");
    mkdirSync(fontsDir, { recursive: true });
    writeFileSync(join(fontsDir, "Regular.ttf"), "regular");
    writeFileSync(join(fontsDir, "Bold.ttf"), "bold");
    writeFileSync(join(dir, "logo.jpg"), "not a png");
    const brand = {
      schema_version: "harness.brand/v1", channel_id: "ch1", revision: 1,
      fonts: { regular: "fonts/Regular.ttf", bold: "fonts/Bold.ttf", origin: "royalty_free", origin_note: "OFL 1.1" },
      colors: { primary: "#F2C94C" }, logo: { path: "logo.jpg" },
    };
    const path = join(dir, "brand.json");
    writeFileSync(path, JSON.stringify(brand));

    const { d, fs } = world();
    let caught: unknown;
    try {
      await setBrand(d, { channel_id: "ch1", source_path: path });
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
    expect(fs.listBrandChannelIds()).toEqual([]);
  });
});

describe("loadBrand", () => {
  it("returns null when the channel has no brand directory", () => {
    const { fs } = world();
    expect(loadBrand(fs, "no-such-channel")).toBeNull();
  });

  it("throws CONFIG_INVALID when brand.json is present but a referenced font is missing", async () => {
    const { d, fs } = world();
    await setBrand(d, { channel_id: "ch1", source_path: buildSource({ channel_id: "ch1", withLogo: false }) });

    // simulate the font disappearing from the kho after the fact
    const { rmSync } = await import("node:fs");
    rmSync(join(fs.paths.brandFontsDir("ch1"), "Regular.ttf"));

    let caught: unknown;
    try {
      loadBrand(fs, "ch1");
    } catch (e) {
      caught = e;
    }
    expect(isHarnessError(caught, "CONFIG_INVALID")).toBe(true);
  });
});

describe("verifyBrandFiles", () => {
  it("ok: true when every checksum matches", async () => {
    const { d, fs } = world();
    await setBrand(d, { channel_id: "ch1", source_path: buildSource({ channel_id: "ch1", withLogo: true }) });
    const loaded = loadBrand(fs, "ch1")!;
    expect(await verifyBrandFiles(fs, loaded)).toEqual({ ok: true });
  });

  it("ok: false with a reason when a font's bytes were tampered with after setBrand", async () => {
    const { d, fs } = world();
    await setBrand(d, { channel_id: "ch1", source_path: buildSource({ channel_id: "ch1", withLogo: false }) });
    const loaded = loadBrand(fs, "ch1")!;

    writeFileSync(loaded.font_regular_path, "tampered bytes");

    const result = await verifyBrandFiles(fs, loaded);
    expect(result.ok).toBe(false);
    expect((result as { ok: false; reason: string }).reason).toContain("checksum mismatch");
  });
});
