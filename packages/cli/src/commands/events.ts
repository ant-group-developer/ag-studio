import type { Command } from "commander";
import { withContext } from "./shared.js";
export function registerEvents(program: Command): void {
  const events = program.command("events").description("event log");
  events.command("tail").option("--run <run_id>").option("--limit <n>", "max rows", "50").option("--json", "machine output", false).action(async (o, cmd) => {
    await withContext(cmd, {}, (ctx) => {
      const rows = ctx.store.listEvents({ ...(o.run ? { run_id: o.run } : {}), limit: Number(o.limit), newest: true });
      process.stdout.write((o.json ? JSON.stringify(rows) : rows.map((e) => `${e.occurred_at} ${e.severity.padEnd(5)} ${e.event_type.padEnd(36)} ${e.stage_run_id ?? ""} ${JSON.stringify(e.payload)}`).join("\n")) + "\n");
    });
  });
}
