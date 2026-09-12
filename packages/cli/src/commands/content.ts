import type { Command } from "commander";
import { print, withContext } from "./shared.js";
export function registerContent(program: Command): void {
  const content = program.command("content").description("content items");
  content.command("create").requiredOption("--title <title>").option("--source <src_id>", "source id (repeatable)", (v: string, acc: string[]) => [...acc, v], [] as string[]).option("--json", "machine output", false)
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const c = ctx.catalog.createContent({ source_ids: o.source, title: o.title });
        print(o.json, { content_id: c.content_id, revision: c.revision }, () => `${c.content_id} "${c.title}" sources=${c.source_ids.length}`);
      });
    });
}
