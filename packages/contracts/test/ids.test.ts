import { describe, expect, it } from "vitest";
import { ID_PREFIXES, idSchema, newId } from "../src/ids.js";

describe("ids", () => {
  it("generates prefixed ULIDs for every kind", () => {
    for (const kind of Object.keys(ID_PREFIXES) as (keyof typeof ID_PREFIXES)[]) {
      const id = newId(kind);
      expect(id).toMatch(new RegExp(`^${ID_PREFIXES[kind]}_[0-9A-HJKMNP-TV-Z]{26}$`));
      expect(idSchema(kind).safeParse(id).success).toBe(true);
    }
  });
  it("rejects ids with the wrong prefix", () => {
    expect(idSchema("run").safeParse(newId("attempt")).success).toBe(false);
  });
  it("uses the blueprint prefixes", () => {
    expect(ID_PREFIXES).toEqual({
      run: "run", stage_run: "stage", attempt: "attempt", artifact: "artifact",
      external_operation: "op", check_result: "check", event: "evt", source_item: "src",
      content_item: "content", content_variant: "variant", channel_package: "pkg",
      publication_job: "pub", incident: "inc",
    });
  });
});
