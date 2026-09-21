import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ZodTypeDef, ZodType } from "zod";
import { HarnessError, idSchema, LibraryClaimSchema, type LibraryClaim, type LibraryFile } from "@harness/contracts";
import { sha256File } from "../artifacts/checksum.js";
import { mimeTypeForPath } from "../source-catalog/catalog.js";

export type LibraryRole = "studio" | "channel";

const VOICE_ID_SCHEMA = idSchema("voice_profile");

/** Defence in depth for every caller of `voiceDir`/`voiceFile`/`voiceRef`, present or future: an id that
 * does not match the `voice_<ULID>` shape must never reach a `join()` that builds a kho path -- a string like
 * `"../requests"` would otherwise resolve outside `voices/` entirely (onto a path a *different* rule of
 * `assertWritable` happens to allow), and a syntactically-odd-but-still-under-`voices/` id would leave an
 * orphan directory neither `listVoiceIds` nor `syncLibrary` ever look at. Review finding (Task 4 fix round 1).
 */
function assertValidVoiceId(voiceId: string): void {
  if (!VOICE_ID_SCHEMA.safeParse(voiceId).success) {
    throw new HarnessError("CONFIG_INVALID", `invalid voice_id: ${voiceId}`, { voice_id: voiceId });
  }
}

export interface LibraryPaths {
  root: string;
  styles: string;
  requests: string;
  items: string;
  index: string;
  voicesDir: string;
  styleDir(id: string): string;
  styleFile(id: string): string;
  requestFile(id: string): string;
  itemDir(id: string): string;
  manifest(id: string): string;
  claimsDir(id: string): string;
  claimFile(id: string, channelId: string): string;
  voiceDir(id: string): string;
  voiceFile(id: string): string;
  voiceRef(id: string): string;
}

export function libraryPaths(root: string): LibraryPaths {
  const r = resolve(root);
  const styles = join(r, "styles");
  const requests = join(r, "requests");
  const items = join(r, "items");
  const voicesDir = join(r, "voices");
  return {
    root: r,
    styles,
    requests,
    items,
    index: join(r, "index.json"),
    voicesDir,
    styleDir: (id) => join(styles, id),
    styleFile: (id) => join(styles, id, "style.json"),
    requestFile: (id) => join(requests, `${id}.json`),
    itemDir: (id) => join(items, id),
    manifest: (id) => join(items, id, "manifest.json"),
    claimsDir: (id) => join(items, id, "claims"),
    claimFile: (id, channelId) => join(items, id, "claims", `${channelId}.json`),
    voiceDir: (id) => { assertValidVoiceId(id); return join(voicesDir, id); },
    voiceFile: (id) => { assertValidVoiceId(id); return join(voicesDir, id, "voice.json"); },
    voiceRef: (id) => { assertValidVoiceId(id); return join(voicesDir, id, "ref.wav"); },
  };
}

/**
 * A kho entry is never a dot-name: the only dot-names that turn up are scratch (an interrupted write's
 * leftovers, `doctor`'s `.doctor-<role>-<uuid>.tmp` probe, or an OS artefact like `.DS_Store`). Listing one
 * as a style/request/item id would hand `syncLibrary` a "corrupt" entry for a file the kho does not own.
 */
function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

function removeTmpQuietly(tmp: string): void {
  try {
    if (existsSync(tmp)) rmSync(tmp, { force: true });
  } catch {
    // best-effort cleanup only; the original error is what matters to the caller
  }
}

export class LibraryFs {
  readonly paths: LibraryPaths;
  private readonly role: LibraryRole;

  constructor(o: { root: string; role: LibraryRole }) {
    this.paths = libraryPaths(o.root);
    this.role = o.role;
  }

  exists(): boolean {
    try {
      return statSync(this.paths.root).isDirectory();
    } catch {
      return false;
    }
  }

  // `ZodType<T>` defaults its Input param to T too, which rejects any schema with `.default()` fields
  // (their parse *input* is narrower than their parse *output* T) — pin Input to `any` so callers can pass
  // schemas like EditStyleSchema/ContentRequestSchema/LibraryItemSchema that lean on `.default()`.
  readJson<T>(path: string, schema: ZodType<T, ZodTypeDef, any>): T {
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch (e) {
      throw new HarnessError("IO_ERROR", `cannot read ${path}: ${(e as Error).message}`, { path });
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new HarnessError("IO_ERROR", `invalid JSON in ${path}: ${(e as Error).message}`, { path });
    }
    const result = schema.safeParse(parsed);
    if (!result.success) {
      throw new HarnessError("CONFIG_INVALID", `schema validation failed for ${path}`, { path, issues: result.error.issues });
    }
    return result.data;
  }

  /**
   * The kho is a mount, not a directory this process owns: when the root is not there, `mkdirSync(…, {
   * recursive: true })` would happily build a local tree standing in for the share and every write would
   * "succeed" into it. Every write checks the root first so an unmounted kho is a plain `IO_ERROR`
   * (`transient` to `library-stage`, exit 1 to the CLI) instead of a silently-scaffolded fake library.
   */
  private assertRootMounted(): void {
    if (!this.exists()) {
      throw new HarnessError("IO_ERROR", `library root not available: ${this.paths.root}`, { root: this.paths.root });
    }
  }

  writeJsonAtomic(path: string, value: unknown): void {
    this.assertWritable(path);
    this.assertRootMounted();
    const tmp = `${path}.tmp-${randomUUID()}`;
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
      renameSync(tmp, path);
    } catch (e) {
      removeTmpQuietly(tmp);
      if (e instanceof HarnessError) throw e;
      throw new HarnessError("IO_ERROR", `cannot write ${path}: ${(e as Error).message}`, { path });
    }
  }

  async copyFileWithChecksum(src: string, dest: string): Promise<LibraryFile> {
    this.assertWritable(dest);
    this.assertRootMounted();
    const tmp = `${dest}.tmp-${randomUUID()}`;
    try {
      mkdirSync(dirname(dest), { recursive: true });
      copyFileSync(src, tmp);
      renameSync(tmp, dest);
    } catch (e) {
      removeTmpQuietly(tmp);
      if (e instanceof HarnessError) throw e;
      throw new HarnessError("IO_ERROR", `cannot copy ${src} to ${dest}: ${(e as Error).message}`, { src, dest });
    }
    const { checksum, size_bytes } = await sha256File(dest);
    return { path: basename(dest), checksum, size_bytes, mime_type: mimeTypeForPath(dest) };
  }

  async verifyFile(dir: string, f: LibraryFile): Promise<boolean> {
    const path = join(dir, f.path);
    if (!existsSync(path)) return false;
    const { checksum, size_bytes } = await sha256File(path);
    return checksum === f.checksum && size_bytes === f.size_bytes;
  }

  listStyleIds(): string[] {
    if (!existsSync(this.paths.styles)) return [];
    return readdirSync(this.paths.styles, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isHiddenName(e.name) && existsSync(join(this.paths.styles, e.name, "style.json")))
      .map((e) => e.name)
      .sort();
  }

  listRequestIds(): string[] {
    if (!existsSync(this.paths.requests)) return [];
    return readdirSync(this.paths.requests, { withFileTypes: true })
      .filter((e) => e.isFile() && !isHiddenName(e.name) && e.name.endsWith(".json"))
      .map((e) => e.name.slice(0, -".json".length))
      .sort();
  }

  listItemIds(): string[] {
    if (!existsSync(this.paths.items)) return [];
    return readdirSync(this.paths.items, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isHiddenName(e.name) && existsSync(join(this.paths.items, e.name, "manifest.json")))
      .map((e) => e.name)
      .sort();
  }

  listVoiceIds(): string[] {
    if (!existsSync(this.paths.voicesDir)) return [];
    return readdirSync(this.paths.voicesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !isHiddenName(e.name) && existsSync(join(this.paths.voicesDir, e.name, "voice.json")))
      .map((e) => e.name)
      .sort();
  }

  listClaims(itemId: string): LibraryClaim[] {
    const dir = this.paths.claimsDir(itemId);
    if (!existsSync(dir)) return [];
    const claims: LibraryClaim[] = [];
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isFile() || !e.name.endsWith(".json")) continue;
      try {
        const parsed = LibraryClaimSchema.parse(JSON.parse(readFileSync(join(dir, e.name), "utf8")));
        claims.push(parsed);
      } catch {
        // corrupt claim file: skip silently here; Task 3's sync surfaces corrupt claims separately
      }
    }
    return claims.sort((a, b) => (a.channel_id < b.channel_id ? -1 : a.channel_id > b.channel_id ? 1 : 0));
  }

  /**
   * studio may write under styles/, under items/ except any `claims` segment, index.json,
   * and requests/<id>.json only when the file already exists (studio never creates a request).
   * channel may create or overwrite requests/<id>.json, items/<id>/claims/<channel_id>.json, and
   * voices/<id>/<file> (exactly two path segments below voices/ -- a voice's own voice.json/ref.wav,
   * never a nested path). studio may never write under voices/ at all -- a voice profile is channel-owned,
   * the one library entity where the write ownership is reversed from styles/.
   * Anything else, or any path outside the library root, is CONFIG_INVALID.
   */
  assertWritable(path: string): void {
    const abs = resolve(path);
    const root = this.paths.root;
    const rootWithSep = root.endsWith(sep) ? root : root + sep;
    if (abs !== root && !abs.startsWith(rootWithSep)) {
      throw new HarnessError("CONFIG_INVALID", `path ${path} is outside the library root`, { path, root });
    }
    const rel = relative(root, abs).split(sep).join("/");
    const segs = rel.split("/");
    const deny = (): never => {
      throw new HarnessError("CONFIG_INVALID", `role ${this.role} may not write ${rel}`, { path: rel, role: this.role });
    };

    if (this.role === "studio") {
      if (segs[0] === "styles") return;
      if (segs[0] === "items") {
        if (segs.includes("claims")) return deny();
        return;
      }
      if (rel === "index.json") return;
      if (segs[0] === "requests" && segs.length === 2 && existsSync(abs)) return;
      return deny();
    }

    // channel
    if (segs[0] === "requests" && segs.length === 2) return;
    if (segs[0] === "items" && segs.includes("claims")) return;
    if (segs[0] === "voices" && segs.length === 3) return;
    return deny();
  }
}
