import { describe, expect, it } from "vitest";
import { cli, freshProject } from "./helpers.js";

describe("18.3 #10 unknown config key fails validation before anything runs", () => {
  it("plan exits 1 with UNKNOWN_CONFIG_KEY and creates no run", () => {
    const p = freshProject();
    const r = cli(p, ["plan", "--workflow", "sample-three-stage@1.0.0", "--profile", "cartoon", "--override", "lease_secondz=5"]);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/UNKNOWN_CONFIG_KEY.*lease_secondz/);
    expect(cli(p, ["events", "tail", "--json"]).out).toBe("[]");
  });
});
