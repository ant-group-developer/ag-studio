import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The editor shares Timeline v2 layout and editing operations with the API and the workflow
// (packages/core/src/studio/layout.ts): one definition of where a beat starts, everywhere.
const layout = fileURLToPath(new URL("../../packages/core/src/studio/layout.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@studio/timeline": layout } },
  server: { port: 5173, proxy: { "/api": "http://localhost:3100" } },
  build: { outDir: "dist" },
});
