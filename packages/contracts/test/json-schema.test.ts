import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ALL_SCHEMAS, toJsonSchema } from "../scripts/gen-json-schema.js";

describe("generated JSON schemas", () => {
  it("match the Zod definitions on disk", () => {
    for (const [name, schema] of Object.entries(ALL_SCHEMAS)) {
      const file = join(__dirname, "..", "schemas", `${name}.json`);
      expect(existsSync(file), `${file} missing; run pnpm gen:schemas`).toBe(true);
      expect(JSON.parse(readFileSync(file, "utf8"))).toEqual(toJsonSchema(name, schema));
    }
  });
});
