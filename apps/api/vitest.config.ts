import { defineConfig } from "vitest/config";
import { nodeSqlitePlugin, workspaceAliases } from "../../vitest.shared.js";

// Workspace packages resolve to their TypeScript sources (no dist/ build needed), like every other package.
export default defineConfig({
  plugins: [nodeSqlitePlugin()],
  resolve: { alias: workspaceAliases },
  test: {
    include: ["src/**/*.spec.ts"],
    environment: "node",
    // the first Postgres (PGlite) of each test worker takes a few seconds under a full parallel run
    hookTimeout: 30_000,
  },
});
