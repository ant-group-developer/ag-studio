import { describe, expect, it } from "vitest";
import { claudeOutputJsonSchema, STUDIO_SKILL_OUTPUTS, type StudioSkill } from "../src/studio.js";

const UNSUPPORTED = ["minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf", "minLength", "maxLength", "pattern", "minItems", "maxItems"];

function walk(node: unknown, visit: (o: Record<string, unknown>) => void): void {
  if (Array.isArray(node)) { node.forEach((n) => walk(n, visit)); return; }
  if (!node || typeof node !== "object") return;
  visit(node as Record<string, unknown>);
  for (const v of Object.values(node as Record<string, unknown>)) walk(v, visit);
}

describe("claudeOutputJsonSchema", () => {
  for (const skill of Object.keys(STUDIO_SKILL_OUTPUTS) as StudioSkill[]) {
    it(`${skill}: only keywords structured outputs accept, every object closed`, () => {
      const schema = claudeOutputJsonSchema(skill);
      expect(schema.type).toBe("object");
      walk(schema, (o) => {
        for (const k of UNSUPPORTED) expect(o, `${skill} still has ${k}`).not.toHaveProperty(k);
        if (o.type === "object") {
          expect(o.additionalProperties).toBe(false);
          expect(o.required).toEqual(Object.keys(o.properties as object));
        }
      });
    });
  }

  it("keeps the enum/const shape Claude has to follow", () => {
    const t = claudeOutputJsonSchema("studio-treatment") as { properties: { schema_version: { const?: string; enum?: string[] } } };
    const v = t.properties.schema_version;
    expect(v.const ?? v.enum?.[0]).toBe("studio.treatment/v1");
  });
});
