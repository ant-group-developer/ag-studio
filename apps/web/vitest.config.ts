import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const layout = fileURLToPath(new URL("../../packages/core/src/studio/layout.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { "@studio/timeline": layout } },
  test: {
    include: ["src/**/*.spec.{ts,tsx}"],
    environment: "jsdom",
    globals: true,
    setupFiles: ["src/test-setup.ts"],
  },
});
