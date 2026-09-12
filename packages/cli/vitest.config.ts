import { defineConfig } from "vitest/config";
import { sharedConfig } from "../../vitest.shared.js";
export default defineConfig(sharedConfig({ include: ["test/**/*.test.ts"], testTimeout: 60000 }));
