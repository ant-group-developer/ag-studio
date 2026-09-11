import { describe, expect, it } from "vitest";
import { HarnessConfigSchema, isHarnessError } from "@harness/contracts";
import { resolveEffectiveConfig } from "../../src/config/resolve.js";

const harness = HarnessConfigSchema.parse({ schema_version: "harness.config/v1" });

describe("resolveEffectiveConfig", () => {
  it("applies precedence system < workflow < profile < channel < run", () => {
    const { snapshot } = resolveEffectiveConfig({
      harness, workflowDefaults: { lease_seconds: 100, default_max_cost_usd: 4 }, profileOverrides: { lease_seconds: 110 },
      channelOverrides: { lease_seconds: 120 }, runOverrides: { lease_seconds: 130 }, profileMaxCostUsd: 5,
    });
    expect(snapshot.lease_seconds).toBe(130);
    expect(snapshot.default_max_cost_usd).toBe(4);
    expect(snapshot.heartbeat_seconds).toBe(30);
  });
  it("rejects unknown keys at any layer", () => {
    try { resolveEffectiveConfig({ harness, workflowDefaults: { leese_seconds: 1 }, profileOverrides: {}, channelOverrides: {}, runOverrides: {}, profileMaxCostUsd: 5 }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "UNKNOWN_CONFIG_KEY")).toBe(true); expect((e as Error).message).toContain("leese_seconds"); }
  });
  it("rejects overrides of keys that are not overridable", () => {
    try { resolveEffectiveConfig({ harness, workflowDefaults: {}, profileOverrides: {}, channelOverrides: {}, runOverrides: { heartbeat_seconds: 1 }, profileMaxCostUsd: 5 }); throw new Error("no throw"); }
    catch (e) { expect(isHarnessError(e, "CONFIG_INVALID")).toBe(true); }
  });
  it("clamps max cost to the profile policy and produces a stable digest", () => {
    const a = resolveEffectiveConfig({ harness, workflowDefaults: {}, profileOverrides: {}, channelOverrides: {}, runOverrides: { default_max_cost_usd: 50 }, profileMaxCostUsd: 5 });
    expect(a.snapshot.default_max_cost_usd).toBe(5);
    const b = resolveEffectiveConfig({ harness, workflowDefaults: {}, profileOverrides: {}, channelOverrides: {}, runOverrides: { default_max_cost_usd: 50 }, profileMaxCostUsd: 5 });
    expect(a.digest).toBe(b.digest);
  });
  it("keeps secret references as references", () => {
    const { snapshot } = resolveEffectiveConfig({ harness, workflowDefaults: { tts_account: "secret://tts/main" }, profileOverrides: {}, channelOverrides: {}, runOverrides: {}, profileMaxCostUsd: 5, extraKnownKeys: ["tts_account"] });
    expect(snapshot.tts_account).toBe("secret://tts/main");
  });
});
