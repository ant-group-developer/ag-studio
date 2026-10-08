import { existsSync, readFileSync } from "node:fs";
import { win32 } from "node:path";

export interface ResolveCommandDeps {
  platform: NodeJS.Platform;
  pathEnv: string | undefined;
  exists(path: string): boolean;
  readFile(path: string): string;
  /** Interpreter for a shim whose target is a JavaScript file. */
  nodePath: string;
}

export interface ResolvedCommand {
  cmd: string;
  prefixArgs: string[];
}

/** `"%dp0%\…"` / `"%~dp0\…"` target of an npm .cmd shim (cmd-shim writes one of the two). */
const SHIM_TARGET = /"%~?dp0%?\\?([^"%]+?\.(exe|cjs|mjs|js))"/gi;

/**
 * On Windows, `spawn("claude", …)` without a shell only finds `claude.exe`; an npm global install puts a
 * `claude.cmd` shim on PATH instead, so the spawn fails with ENOENT. Running the shim through cmd.exe would
 * mangle the quotes in `--json-schema`, so follow the shim to the file it wraps and spawn that directly:
 * an `.exe` as is, a JavaScript entry with node. Anything not found is returned unchanged, so a machine
 * without the CLI still fails the way it always has (ENOENT → `contract`).
 */
export function resolveCommand(cmd: string, deps: ResolveCommandDeps): ResolvedCommand {
  const unchanged: ResolvedCommand = { cmd, prefixArgs: [] };
  if (deps.platform !== "win32" || /[\\/]/.test(cmd) || /\.[A-Za-z0-9]+$/.test(cmd)) return unchanged;
  const dirs = (deps.pathEnv ?? "").split(";").map((d) => d.trim()).filter(Boolean);

  for (const dir of dirs) {
    const exe = win32.join(dir, `${cmd}.exe`);
    if (deps.exists(exe)) return { cmd: exe, prefixArgs: [] };
  }
  for (const dir of dirs) {
    const shim = win32.join(dir, `${cmd}.cmd`);
    if (!deps.exists(shim)) continue;
    let text: string;
    try {
      text = deps.readFile(shim);
    } catch {
      continue;
    }
    for (const m of text.matchAll(SHIM_TARGET)) {
      const target = win32.join(dir, m[1]!);
      // A shim may first try a node.exe next to itself; that is the interpreter, not the CLI.
      if (/^node\.exe$/i.test(win32.basename(target)) || !deps.exists(target)) continue;
      return m[2]!.toLowerCase() === "exe" ? { cmd: target, prefixArgs: [] } : { cmd: deps.nodePath, prefixArgs: [target] };
    }
  }
  return unchanged;
}

export function defaultResolveDeps(pathEnv: string | undefined): ResolveCommandDeps {
  return { platform: process.platform, pathEnv, exists: existsSync, readFile: (p) => readFileSync(p, "utf8"), nodePath: process.execPath };
}
