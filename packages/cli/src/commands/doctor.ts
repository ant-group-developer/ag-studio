import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { parse } from "yaml";
import type { ProductionProfile } from "@harness/contracts";
import { resolveWorkflowScope, runDoctor, type DoctorRow, type LoadedWorkflow } from "@harness/core";
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

        // `project.yaml.workflows`, when set, is the list of workflow releases this ops project actually
        // runs: doctor then checks only those (and unlisted-ref -> a failing `workflow:<ref>` row) instead of
        // every workflow.yaml installed in the harness -- a footage-only machine should not fail doctor over
        // scripts a studio-only workflow needs and this project will never run.
        const scope = ctx.project.workflows;
        let workflows: { ref: string; loaded: LoadedWorkflow }[];
        if (scope) {
          const scoped = resolveWorkflowScope(scope, ctx.workflows);
          workflows = scoped.workflows;
          extraRows.push(...scoped.rows);
        } else {
          workflows = [];
          for (const dir of subdirsWith(join(ctx.harnessRoot, "workflows"), "workflow.yaml")) {
            try {
              const raw = parse(readFileSync(join(ctx.harnessRoot, "workflows", dir, "workflow.yaml"), "utf8")) as { id?: string; version?: string };
              const ref = `${raw.id ?? dir}@${raw.version ?? "0.0.0"}`;
              workflows.push({ ref, loaded: ctx.workflows(ref) });
            } catch (e) {
              extraRows.push({ check: `workflow:${dir}`, ok: false, detail: e instanceof Error ? e.message : String(e) });
            }
          }
        }
        extraRows.push({ check: "workflows", ok: true, detail: scope ? `scoped to project.yaml workflows: ${scope.join(", ")}` : "all workflows in harness" });

        const allProfiles: ProductionProfile[] = [];
        for (const dir of subdirsWith(join(ctx.harnessRoot, "production-profiles"), "profile.yaml")) {
          try { allProfiles.push(ctx.profiles(dir)); }
          catch (e) { extraRows.push({ check: `profile:${dir}:load`, ok: false, detail: e instanceof Error ? e.message : String(e) }); }
        }
        const profiles = scope ? allProfiles.filter((p) => scope.includes(p.workflow_release)) : allProfiles;

        const rows = [
          ...extraRows,
          ...runDoctor({
            projectDir: ctx.projectDir, project: ctx.project, harness: ctx.harness, scripts: ctx.scripts, builtinScripts: ctx.scriptCommandNames, workflows, profiles,
            secrets: ctx.secrets, proberAvailable: ctx.proberAvailable, store: ctx.store, migrationsDir: ctx.migrationsDir, configErrors: ctx.configErrors,
            ...(ctx.library ? { library: { fs: ctx.library.fs, role: ctx.library.role } } : {}),
          }),
        ];

        print(o.json, rows, () => rows.map((r) => `${r.ok ? "ok  " : "FAIL"} ${r.check.padEnd(42)} ${r.detail}`).join("\n"));
        if (rows.some((r) => !r.ok)) process.exitCode = 1;
      });
    });
}
