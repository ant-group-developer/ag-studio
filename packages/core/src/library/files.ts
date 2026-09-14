import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type { ZodType } from "zod";
import { HarnessError, LibraryClaimSchema, type LibraryClaim, type LibraryFile } from "@harness/contracts";
import { sha256File } from "../artifacts/checksum.js";
import { mimeTypeForPath } from "../source-catalog/catalog.js";

export type LibraryRole = "studio" | "channel";

export interface LibraryPaths {
  root: string;
  styles: string;
  requests: string;
  items: string;
  index: string;
  styleDir(id: string): string;
  styleFile(id: string): string;
  requestFile(id: string): string;
  itemDir(id: string): string;
  manifest(id: string): string;
  claimsDir(id: string): string;
  claimFile(id: string, channelId: string): string;
}

export function libraryPaths(root: string): LibraryPaths {
  const r = resolve(root);
  const styles = join(r, "styles");
  const requests = join(r, "requests");
  const items = join(r, "items");
  return {
    root: r,
    styles,
    requests,
    items,
    index: join(r, "index.json"),
    styleDir: (id) => join(styles, id),
    styleFile: (id) => join(styles, id, "style.json"),
    requestFile: (id) => join(requests, `${id}.json`),
    itemDir: (id) => join(items, id),
    manifest: (id) => join(items, id, "manifest.json"),
    claimsDir: (id) => join(items, id, "claims"),
    claimFile: (id, channelId) => join(items, id, "claims", `${channelId}.json`),
  };
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

  readJson<T>(path: string, schema: ZodType<T>): T {
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

  writeJsonAtomic(path: string, value: unknown): void {
    this.assertWritable(path);
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
      .filter((e) => e.isDirectory() && !e.name.startsWith(".tmp-") && existsSync(join(this.paths.styles, e.name, "style.json")))
      .map((e) => e.name)
      .sort();
  }

  listRequestIds(): string[] {
    if (!existsSync(this.paths.requests)) return [];
    return readdirSync(this.paths.requests, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".json"))
      .map((e) => e.name.slice(0, -".json".length))
      .sort();
  }

  listItemIds(): string[] {
    if (!existsSync(this.paths.items)) return [];
    return readdirSync(this.paths.items, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith(".tmp-") && existsSync(join(this.paths.items, e.name, "manifest.json")))
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
   * channel may create or overwrite requests/<id>.json and items/<id>/claims/<channel_id>.json.
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
    return deny();
  }
}
