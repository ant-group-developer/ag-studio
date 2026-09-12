import type { Command } from "commander";
import { withContext } from "./shared.js";
export function registerDb(program: Command): void {
  const db = program.command("db").description("state store maintenance");
  db.command("migrate").description("apply pending migrations").action(async (_o, cmd) => {
    await withContext(cmd, {}, (ctx) => { const applied = ctx.store.migrate(ctx.migrationsDir); process.stdout.write(applied.length ? `applied: ${applied.join(", ")}\n` : "up to date\n"); });
  });
}
