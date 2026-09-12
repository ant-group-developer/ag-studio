import type { Command } from "commander";
import { print, withContext } from "./shared.js";
export function registerSource(program: Command): void {
  const source = program.command("source").description("source catalog");
  source.command("ingest <path>").option("--collection <name>", "collection", "main").option("--rights <status>", "unknown|cleared|restricted", "unknown").option("--language <code>").option("--json", "machine output", false)
    .description("register a raw source file (deduplicated by checksum)").action(async (path: string, o, cmd) => {
      await withContext(cmd, {}, async (ctx) => {
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
}
