import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { BrandProfileSchema, HarnessError, type BrandProfile, type Clock, type StateStore } from "@harness/contracts";
import { sha256File } from "../artifacts/checksum.js";
import type { LibraryFs } from "./files.js";

const FONT_EXTS = new Set([".ttf", ".otf"]);
const LOGO_EXT = ".png";

export interface LoadedBrand {
  brand: BrandProfile;
  dir: string;
  fonts_dir: string;
  font_regular_path: string;
  font_bold_path: string;
  logo_path: string | null;
}

/** Reads a brand profile straight from the kho (not the DB mirror), mirroring `readVoiceOrUndefined`: an
 * absent file just means "no brand for this channel yet" (used by `setBrand` to tell new-vs-bump apart). */
function readBrandOrUndefined(fs: LibraryFs, channelId: string): BrandProfile | undefined {
  const path = fs.paths.brandFile(channelId);
  if (!existsSync(path)) return undefined;
  return fs.readJson(path, BrandProfileSchema);
}

/**
 * Sets (or bumps) a channel's brand profile in the kho from a `brand.json`-shaped source file that lives
 * *outside* the kho. `p.source_path`'s `fonts.regular`/`fonts.bold`/`logo.path` are resolved relative to the
 * directory containing that source file (spec §2.1: "mọi đường dẫn font/logo tương đối với thư mục chứa file
 * nguồn"); every referenced file is checked to exist -- and its extension checked (`.ttf`/`.otf` for fonts,
 * `.png` for the logo) -- *before* anything is copied into the kho, same ordering discipline as `addVoice`.
 *
 * The source file is parsed with the full `BrandProfileSchema` (so a hand-authored template can carry a
 * placeholder `revision`/`checksums`/timestamps and still validate), but those four fields are always
 * recomputed here and never taken from the source: `checksums` from the freshly-copied files, `revision` from
 * the kho's existing profile for this channel (absent -> 1, present -> +1), `created_at` kept from the
 * existing profile (or `now` for a first-time brand), `updated_at` always `now`.
 */
export async function setBrand(
  d: { fs: LibraryFs; store: StateStore; clock: Clock },
  p: { channel_id: string; source_path: string },
): Promise<BrandProfile> {
  if (!existsSync(p.source_path)) {
    throw new HarnessError("CONFIG_INVALID", `brand source not found: ${p.source_path}`, { source_path: p.source_path });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(p.source_path, "utf8"));
  } catch (e) {
    throw new HarnessError("CONFIG_INVALID", `invalid JSON in ${p.source_path}: ${(e as Error).message}`, { source_path: p.source_path });
  }
  const parsed = BrandProfileSchema.safeParse(raw);
  if (!parsed.success) {
    throw new HarnessError("CONFIG_INVALID", `schema validation failed for ${p.source_path}`, { path: p.source_path, issues: parsed.error.issues });
  }
  const source = parsed.data;
  if (source.channel_id !== p.channel_id) {
    throw new HarnessError("CONFIG_INVALID", `brand channel_id "${source.channel_id}" in ${p.source_path} does not match channel ${p.channel_id}`, { channel_id: p.channel_id, source_channel_id: source.channel_id });
  }

  const sourceDir = dirname(resolve(p.source_path));

  const regularExt = extname(source.fonts.regular).toLowerCase();
  if (!FONT_EXTS.has(regularExt)) {
    throw new HarnessError("CONFIG_INVALID", `fonts.regular must be .ttf or .otf: ${source.fonts.regular}`, { path: source.fonts.regular });
  }
  const boldExt = extname(source.fonts.bold).toLowerCase();
  if (!FONT_EXTS.has(boldExt)) {
    throw new HarnessError("CONFIG_INVALID", `fonts.bold must be .ttf or .otf: ${source.fonts.bold}`, { path: source.fonts.bold });
  }
  const regularSrc = resolve(sourceDir, source.fonts.regular);
  if (!existsSync(regularSrc)) {
    throw new HarnessError("CONFIG_INVALID", `fonts.regular file not found: ${regularSrc}`, { path: regularSrc });
  }
  const boldSrc = resolve(sourceDir, source.fonts.bold);
  if (!existsSync(boldSrc)) {
    throw new HarnessError("CONFIG_INVALID", `fonts.bold file not found: ${boldSrc}`, { path: boldSrc });
  }

  let logoSrc: string | undefined;
  if (source.logo) {
    const logoExt = extname(source.logo.path).toLowerCase();
    if (logoExt !== LOGO_EXT) {
      throw new HarnessError("CONFIG_INVALID", `logo.path must be .png: ${source.logo.path}`, { path: source.logo.path });
    }
    logoSrc = resolve(sourceDir, source.logo.path);
    if (!existsSync(logoSrc)) {
      throw new HarnessError("CONFIG_INVALID", `logo file not found: ${logoSrc}`, { path: logoSrc });
    }
  }

  const existing = readBrandOrUndefined(d.fs, p.channel_id);
  const now = d.clock.now();

  const regularDest = join(d.fs.paths.brandFontsDir(p.channel_id), basename(source.fonts.regular));
  const boldDest = join(d.fs.paths.brandFontsDir(p.channel_id), basename(source.fonts.bold));
  const regularFile = await d.fs.copyFileWithChecksum(regularSrc, regularDest);
  const boldFile = await d.fs.copyFileWithChecksum(boldSrc, boldDest);

  const checksums: Record<string, string> = {
    "fonts.regular": regularFile.checksum,
    "fonts.bold": boldFile.checksum,
  };

  let logoRelPath: string | undefined;
  if (logoSrc && source.logo) {
    const logoDest = join(d.fs.paths.brandDir(p.channel_id), basename(source.logo.path));
    const logoFile = await d.fs.copyFileWithChecksum(logoSrc, logoDest);
    checksums.logo = logoFile.checksum;
    logoRelPath = logoFile.path;
  }

  const profile: BrandProfile = BrandProfileSchema.parse({
    ...source,
    channel_id: p.channel_id,
    fonts: { ...source.fonts, regular: `fonts/${regularFile.path}`, bold: `fonts/${boldFile.path}` },
    ...(source.logo && logoRelPath ? { logo: { ...source.logo, path: logoRelPath } } : {}),
    checksums,
    revision: (existing?.revision ?? 0) + 1,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });

  d.fs.writeJsonAtomic(d.fs.paths.brandFile(p.channel_id), profile);
  d.store.upsertBrandProfile(profile);
  return profile;
}

/** Reads a brand profile plus the resolved on-disk paths of everything it references, straight from the kho
 * (not the DB mirror) -- `null` when the channel has no brand directory at all (spec §2.1: "Không có brand ->
 * tập vẫn dựng"), not an error. A brand directory that exists but is missing `brand.json`, is unparsable, or
 * is missing a font it declares, is CONFIG_INVALID -- unlike "no brand", a half-written brand is a real
 * problem the caller must not silently treat as "no brand". */
export function loadBrand(fs: LibraryFs, channelId: string): LoadedBrand | null {
  const dir = fs.paths.brandDir(channelId);
  if (!existsSync(dir)) return null;

  const brand = fs.readJson(fs.paths.brandFile(channelId), BrandProfileSchema);
  const fonts_dir = fs.paths.brandFontsDir(channelId);
  const font_regular_path = join(dir, brand.fonts.regular);
  const font_bold_path = join(dir, brand.fonts.bold);
  const logo_path = brand.logo ? join(dir, brand.logo.path) : null;

  if (!existsSync(font_regular_path)) {
    throw new HarnessError("CONFIG_INVALID", `brand fonts.regular file missing: ${font_regular_path}`, { channel_id: channelId, path: font_regular_path });
  }
  if (!existsSync(font_bold_path)) {
    throw new HarnessError("CONFIG_INVALID", `brand fonts.bold file missing: ${font_bold_path}`, { channel_id: channelId, path: font_bold_path });
  }
  if (logo_path && !existsSync(logo_path)) {
    throw new HarnessError("CONFIG_INVALID", `brand logo file missing: ${logo_path}`, { channel_id: channelId, path: logo_path });
  }

  return { brand, dir, fonts_dir, font_regular_path, font_bold_path, logo_path };
}

/**
 * `loadBrand` + `verifyBrandFiles` in one call, raising a mismatch as the `CONFIG_INVALID` both callers
 * want -- `intake` (before `claimRequest`, so a broken brand leaves the request `open`) and `media-compose`
 * (a cheap re-check before a two-hour render). `null` means "this channel has no brand", which is not an
 * error anywhere: the episode is simply built plain (spec §2.1).
 *
 * `channelId` may be `null`/`undefined` for a run with no originating request (or a request created without
 * a channel); that answers `null` too, for the same reason.
 */
export async function requireValidBrand(fs: LibraryFs, channelId: string | null | undefined): Promise<LoadedBrand | null> {
  if (!channelId) return null;
  const brand = loadBrand(fs, channelId);
  if (brand === null) return null;
  const verified = await verifyBrandFiles(fs, brand);
  if (!verified.ok) {
    throw new HarnessError("CONFIG_INVALID", `brand for channel ${channelId} is broken: ${verified.reason}`, { channel_id: channelId, reason: verified.reason });
  }
  return brand;
}

/** Verifies every file a loaded brand references (fonts, logo) still matches the sha256 checksum recorded in
 * `brand.json` -- used at `intake` (spec §7: checked before `claimRequest`, alongside the voice check) and
 * re-checked cheaply at `media-compose`. Never throws for a mismatch/missing file; that is an ordinary
 * `{ ok: false, reason }` result the caller decides how to fail on. */
export async function verifyBrandFiles(fs: LibraryFs, b: LoadedBrand): Promise<{ ok: true } | { ok: false; reason: string }> {
  const files: [string, string][] = [
    ["fonts.regular", b.font_regular_path],
    ["fonts.bold", b.font_bold_path],
  ];
  if (b.logo_path) files.push(["logo", b.logo_path]);

  for (const [key, path] of files) {
    const expected = b.brand.checksums[key];
    if (!expected) return { ok: false, reason: `missing checksum for ${key}` };
    if (!existsSync(path)) return { ok: false, reason: `file missing: ${path}` };
    const { checksum } = await sha256File(path);
    if (checksum !== expected) return { ok: false, reason: `checksum mismatch: ${path}` };
  }
  return { ok: true };
}
