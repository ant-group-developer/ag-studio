import type { Command } from "commander";
import { print, withContext } from "./shared.js";
export function registerResources(program: Command): void {
  const resources = program.command("resources").description("shared resource capacity");
  resources.command("status").option("--json", "machine output", false).action(async (o, cmd) => {
    await withContext(cmd, {}, (ctx) => {
      const held = ctx.store.countLeasedResources();
      const names = new Set([...Object.keys(ctx.resourceCapacity), ...Object.keys(held)]);
      const rows = [...names].sort().map((resource) => { const capacity = ctx.resourceCapacity[resource] ?? 0; const h = held[resource] ?? 0; return { resource, capacity, held: h, free: Math.max(0, capacity - h) }; });
      print(o.json, rows, () => rows.map((r) => `${r.resource.padEnd(12)} capacity=${r.capacity} held=${r.held} free=${r.free}`).join("\n") || "no resources declared");
    });
  });
}
