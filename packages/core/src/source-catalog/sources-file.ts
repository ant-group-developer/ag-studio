import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { HarnessError, SourcesRegistrySchema, type SourcesRegistry, type StateStore } from "@harness/contracts";
import { sha256File } from "../artifacts/checksum.js";
import type { SourceCatalog } from "./catalog.js";

export const SOURCES_FILE = join("source-catalog", "sources.yaml");

/** `source-catalog/sources.yaml` of an operations project, or undefined when the project has none. */
export function loadSourcesRegistry(projectDir: string): SourcesRegistry | undefined {
  const file = join(projectDir, SOURCES_FILE);
  if (!existsSync(file)) return undefined;
  const parsed = SourcesRegistrySchema.safeParse(parse(readFileSync(file, "utf8")));
  if (!parsed.success) throw new HarnessError("CONFIG_INVALID", `${file} invalid: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`, { file, issues: parsed.error.issues });
  return parsed.data;
}

export interface SyncReport {
  added: { source_id: string; path: string }[];
  already: { source_id: string; path: string }[];
  missing_files: string[];
  unregistered: { source_id: string; uri: string }[];
}

/** Reconcile `source-catalog/sources.yaml` against the DB catalog: ingest entries not yet in the DB (via
 * `catalog.ingest`, so materialisation and probing behave exactly like `source ingest`), report entries whose
 * file is gone, and flag DB rows whose checksum is not covered by any entry currently on disk. */
export async function syncSources(p: { catalog: SourceCatalog; store: StateStore; projectDir: string; registry: SourcesRegistry }): Promise<SyncReport> {
  const added: SyncReport["added"] = [];
  const already: SyncReport["already"] = [];
  const missing_files: string[] = [];
  const yamlChecksums = new Set<string>();

  for (const entry of p.registry.sources) {
    const abs = resolve(p.projectDir, entry.path);
    if (!existsSync(abs)) { missing_files.push(entry.path); continue; }
    const { checksum } = await sha256File(abs);
    yamlChecksums.add(checksum);
    const existing = p.store.findSourceItemByChecksum(checksum);
    if (existing) { already.push({ source_id: existing.source_id, path: entry.path }); continue; }
    const { source } = await p.catalog.ingest({ path: abs, collection: entry.collection, rights_status: entry.rights_status, language: entry.language });
    added.push({ source_id: source.source_id, path: entry.path });
  }

  const unregistered = p.store.listSourceItems()
    .filter((s) => !yamlChecksums.has(s.checksum))
    .map((s) => ({ source_id: s.source_id, uri: s.uri }));

  return { added, already, missing_files, unregistered };
}
