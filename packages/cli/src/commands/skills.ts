import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { print, withContext } from "./shared.js";

/** Both places an agent runtime looks for skills in an ops project (spec: `.claude/skills/` for the Claude
 * CLI, `.agents/skills/` as the runtime-agnostic mirror). */
const SKILL_DEST_DIRS = [join(".claude", "skills"), join(".agents", "skills")];

export function registerSkills(program: Command): void {
  const skills = program.command("skills").description("agent-runtime skill files");

  skills.command("sync")
    .option("--json", "machine output", false)
    .description("copy <harnessRoot>/skills/* into .claude/skills/ and .agents/skills/ of this ops project")
    .action(async (o, cmd) => {
      await withContext(cmd, {}, (ctx) => {
        const srcRoot = join(ctx.harnessRoot, "skills");
        const names = existsSync(srcRoot)
          ? readdirSync(srcRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
          : [];
        for (const destDir of SKILL_DEST_DIRS) {
          const destRoot = join(ctx.projectDir, destDir);
          mkdirSync(destRoot, { recursive: true });
          for (const name of names) {
            const dest = join(destRoot, name);
            rmSync(dest, { recursive: true, force: true });
            cpSync(join(srcRoot, name), dest, { recursive: true });
          }
        }
        print(o.json, names, () => names.length ? names.join("\n") : "no skills to sync");
      });
    });
}
