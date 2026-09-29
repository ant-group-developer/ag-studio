import { defineConfig } from "vitest/config";
import { sharedConfig, workspaceAliases } from "../../vitest.shared.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

// ag-farm packages are linked into packages/executors/node_modules — alias them
// so the E2E test file can import them directly (same compiled versions as the
// executors package uses at runtime).
const AG_FARM_BASE = resolve(ROOT, "packages/executors/node_modules/@ag-farm");

export default defineConfig({
  ...sharedConfig({
    include: ["**/*.e2e.test.ts"],
    testTimeout: 300_000,  // 5 min – real renders
    hookTimeout: 120_000,  // 2 min – infra boot
  }),
  // Every E2E file boots (and tears down) the same Postgres container: never run two at once.
  test: {
    ...sharedConfig({ include: ["**/*.e2e.test.ts"], testTimeout: 300_000, hookTimeout: 120_000 }).test,
    fileParallelism: false,
  },
  resolve: {
    alias: {
      ...workspaceAliases,
      "@ag-farm/owner-client": resolve(AG_FARM_BASE, "owner-client/dist/index.js"),
      "@ag-farm/protocol": resolve(AG_FARM_BASE, "protocol/dist/index.js"),
    },
  },
});
