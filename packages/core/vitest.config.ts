import { defineConfig, type Plugin } from "vitest/config";

// node:sqlite is unflagged in Node 22 but is still an experimental builtin, so
// it is absent from Node's `module.builtinModules` list. Vitest's vite-node
// runtime consults that list to decide whether a specifier is a Node builtin;
// for anything it does not recognize it strips the "node:" prefix and then
// fails to resolve the bare "sqlite" specifier as an npm package. This plugin
// intercepts that specifier and serves a tiny virtual module that fetches the
// real builtin via `process.getBuiltinModule`, which bypasses Vite/vite-node
// module resolution entirely (it is a plain runtime call, not an import).
const VIRTUAL_ID = "\0node:sqlite";

function nodeSqlitePlugin(): Plugin {
  return {
    name: "node-sqlite-builtin",
    resolveId(source) {
      if (source === "sqlite" || source === "node:sqlite") return VIRTUAL_ID;
      return null;
    },
    load(id) {
      if (id === VIRTUAL_ID) {
        return "const mod = process.getBuiltinModule('node:sqlite'); export const DatabaseSync = mod.DatabaseSync; export const StatementSync = mod.StatementSync; export default mod;";
      }
      return null;
    },
  };
}

export default defineConfig({
  plugins: [nodeSqlitePlugin()],
  test: { include: ["test/**/*.test.ts"], testTimeout: 20000 },
});
