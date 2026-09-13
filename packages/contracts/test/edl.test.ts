import { describe, expect, it } from "vitest";
import { EdlSchema } from "../src/edl.js";

const SRC = "src_01J00000000000000000000000";
describe("EdlSchema", () => {
  it("accepts ordered entries with in < out", () => {
    const edl = EdlSchema.parse({ schema_version: "harness.edl/v1", entries: [{ source_id: SRC, in: 0, out: 2.5, order: 0 }, { source_id: SRC, in: 2.5, out: 5, order: 1, overlay: "avatar", note: "b-roll" }] });
    expect(edl.entries[0]).toMatchObject({ overlay: null, note: "" });
  });
  it("rejects in >= out and duplicate order", () => {
    expect(EdlSchema.safeParse({ schema_version: "harness.edl/v1", entries: [{ source_id: SRC, in: 3, out: 3, order: 0 }] }).success).toBe(false);
    expect(EdlSchema.safeParse({ schema_version: "harness.edl/v1", entries: [{ source_id: SRC, in: 0, out: 1, order: 0 }, { source_id: SRC, in: 1, out: 2, order: 0 }] }).success).toBe(false);
  });
});
