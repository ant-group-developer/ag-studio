import { fileURLToPath } from "node:url";
import type { Plugin, UserConfig } from "vitest/config";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const VIRTUAL_ID = "\0node:sqlite";

/** node:sqlite is an experimental builtin missing from module.builtinModules; vite-node cannot resolve it. */
export function nodeSqlitePlugin(): Plugin {
  return {
    name: "node-sqlite-builtin",
    resolveId(source) { return source === "sqlite" || source === "node:sqlite" ? VIRTUAL_ID : null; },
    load(id) {
      if (id !== VIRTUAL_ID) return null;
      return "const mod = process.getBuiltinModule('node:sqlite'); export const DatabaseSync = mod.DatabaseSync; export const StatementSync = mod.StatementSync; export default mod;";
    },
  };
}

/** Resolve workspace packages to their TypeScript sources in tests, so no dist/ build is needed. */
export const workspaceAliases: Record<string, string> = {
  "@harness/contracts": `${ROOT}packages/contracts/src/index.ts`,
  "@harness/core": `${ROOT}packages/core/src/index.ts`,
  "@harness/executors": `${ROOT}packages/executors/src/index.ts`,
  "@harness/adapter-fake": `${ROOT}packages/adapters/fake/src/index.ts`,
  "@harness/worker": `${ROOT}packages/worker/src/index.ts`,
};

export function sharedConfig(test: { include: string[]; testTimeout?: number; hookTimeout?: number }): UserConfig {
  return { plugins: [nodeSqlitePlugin()], resolve: { alias: workspaceAliases }, test };
}
