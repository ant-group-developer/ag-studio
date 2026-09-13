import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { parse } from "yaml";
import type { ProductionProfile } from "@harness/contracts";
import { runDoctor, type DoctorRow, type LoadedWorkflow } from "@harness/core";
import { print, withContext } from "./shared.js";

function subdirsWith(root: string, filename: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(root, d.name, filename)))
    .map((d) => d.name)
    .sort();
}

export function registerDoctor(program: Command): void {
  program
    .command("doctor")
    .option("--json", "machine output", false)
    .description("check the project and harness install (workflows, profiles, scripts, resources, sources) for consistency")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const extraRows: DoctorRow[] = [];

        const workflows: { ref: string; loaded: LoadedWorkflow }[] = [];
        for (const dir of subdirsWith(join(ctx.harnessRoot, "workflows"), "workflow.yaml")) {
          try {
            const raw = parse(readFileSync(join(ctx.harnessRoot, "workflows", dir, "workflow.yaml"), "utf8")) as { id?: string; version?: string };
            const ref = `${raw.id ?? dir}@${raw.version ?? "0.0.0"}`;
            workflows.push({ ref, loaded: ctx.workflows(ref) });
          } catch (e) {
            extraRows.push({ check: `workflow:${dir}`, ok: false, detail: e instanceof Error ? e.message : String(e) });
          }
        }

        const profiles: ProductionProfile[] = [];
        for (const dir of subdirsWith(join(ctx.harnessRoot, "production-profiles"), "profile.yaml")) {
          try { profiles.push(ctx.profiles(dir)); }
          catch (e) { extraRows.push({ check: `profile:${dir}:load`, ok: false, detail: e instanceof Error ? e.message : String(e) }); }
        }

        const rows = [
          ...extraRows,
          ...runDoctor({
            projectDir: ctx.projectDir, project: ctx.project, harness: ctx.harness, scripts: ctx.scripts, builtinScripts: ctx.scriptCommandNames, workflows, profiles,
            secrets: ctx.secrets, proberAvailable: ctx.proberAvailable, store: ctx.store, migrationsDir: ctx.migrationsDir, configErrors: ctx.configErrors,
          }),
        ];

        print(o.json, rows, () => rows.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.check.padEnd(42)} ${r.detail}`).join("\n"));
        if (rows.some((r) => !r.ok)) process.exitCode = 1;
      });
    });
}
