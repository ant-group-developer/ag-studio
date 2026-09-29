import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.js";

export default defineConfig(
  sharedConfig({
    include: ["**/*.e2e.test.ts"],
    testTimeout: 300_000,  // 5 min – real renders
    hookTimeout: 120_000,  // 2 min – infra boot
  }),
);
