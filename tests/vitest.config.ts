import { defineConfig } from "vitest/config";
import { sharedConfig } from "../vitest.shared.js";
export default defineConfig(sharedConfig({ include: ["acceptance/**/*.test.ts", "integration/**/*.test.ts"], testTimeout: 120000, hookTimeout: 60000 }));
