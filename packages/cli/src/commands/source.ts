import { existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { HarnessError } from "@harness/contracts";
import { syncSources } from "@harness/core";
import { print, withContext } from "./shared.js";
export function registerSource(program: Command): void {
  const source = program.command("source").description("source catalog");
  source.command("ingest <path>").option("--collection <name>", "collection", "main").option("--rights <status>", "unknown|cleared|restricted", "unknown").option("--language <code>").option("--recursive", "descend into subdirectories (directory <path> only)", false).option("--json", "machine output", false)
    .description("register a raw source file, or every video file under a directory (deduplicated by checksum)").action(async (path: string, o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
        if (existsSync(path) && statSync(path).isDirectory()) {
          const r = await ctx.catalog.ingestDirectory({ dir: path, recursive: Boolean(o.recursive), collection: o.collection, rights_status: o.rights, language: o.language ?? null });
          const ingested = r.ingested.map((i) => ({ source_id: i.source.source_id, path: fileURLToPath(i.source.original_uri), created: i.created }));
          print(o.json, { ingested, skipped: r.skipped }, () =>
            [
              ...ingested.map((i) => `${i.source_id} ${i.created ? "created" : "already registered"} ${i.path}`),
              ...r.skipped.map((s) => `SKIPPED ${s.path}: ${s.why}`),
            ].join("\n") || "no video files found",
          );
          return;
        }
        const r = await ctx.catalog.ingest({ path, collection: o.collection, rights_status: o.rights, language: o.language ?? null });
        print(o.json, { source_id: r.source.source_id, created: r.created, checksum: r.source.checksum, uri: r.source.uri }, () => `${r.source.source_id} ${r.created ? "created" : "already registered"} ${r.source.checksum.slice(0, 19)}`);
      });
    });
  source.command("list").option("--collection <name>").option("--json", "machine output", false).action(async (o, cmd) => {
    await withContext(cmd, {}, (ctx) => {
      const rows = ctx.store.listSourceItems(o.collection ? { collection: o.collection } : {});
      print(o.json, rows, () => rows.map((s) => `${s.source_id} ${s.collection.padEnd(8)} ${s.mime_type.padEnd(18)} ${s.rights_status.padEnd(10)} ${s.uri}`).join("\n") || "no sources");
    });
  });
  source.command("verify").option("--json", "machine output", false).description("re-hash every registered source").action(async (o, cmd) => {
    await withContext(cmd, {}, async (ctx) => {
      const rows = await ctx.catalog.verify();
      print(o.json, rows, () => rows.map((r) => `${r.source_id} ${r.ok ? "ok" : "BROKEN " + r.reason}`).join("\n") || "no sources");
      if (rows.some((r) => !r.ok)) process.exitCode = 1;
    });
  });
  source.command("sync").option("--json", "machine output", false).description("reconcile source-catalog/sources.yaml against the DB catalog").action(async (o, cmd) => {
    await withContext(cmd, {}, async (ctx) => {
      // buildContext keeps a malformed registry from aborting every command; the command that actually needs
      // it still fails loudly, with the parse error the loader produced.
      if (ctx.configErrors.sources) throw new HarnessError("CONFIG_INVALID", ctx.configErrors.sources, { projectDir: ctx.projectDir });
      if (!ctx.sources) throw new HarnessError("NOT_FOUND", `source-catalog/sources.yaml not found in ${ctx.projectDir}`, { projectDir: ctx.projectDir });
      const report = await syncSources({ catalog: ctx.catalog, store: ctx.store, projectDir: ctx.projectDir, registry: ctx.sources });
      print(o.json, report, () =>
        [
          `added: ${report.added.length}`,
          ...report.added.map((a) => `  + ${a.source_id} ${a.path}`),
          `already: ${report.already.length}`,
          `missing_files: ${report.missing_files.length}`,
          ...report.missing_files.map((m) => `  ! ${m}`),
          `unregistered: ${report.unregistered.length}`,
          ...report.unregistered.map((u) => `  ? ${u.source_id} ${u.uri}`),
        ].join("\n"),
      );
      if (report.missing_files.length > 0) process.exitCode = 1;
    });
  });
}
