import { HarnessError, type Checksum, type HarnessConfig } from "@harness/contracts";
import { canonicalDigest } from "../artifacts/checksum.js";

export interface ResolveInput {
  harness: HarnessConfig;
  workflowDefaults: Record<string, unknown>;
  profileOverrides: Record<string, unknown>;
  channelOverrides: Record<string, unknown>;
  runOverrides: Record<string, unknown>;
  profileMaxCostUsd: number;
  extraKnownKeys?: string[];
}

const BASE_KEYS = ["lease_seconds", "heartbeat_seconds", "poll_seconds", "default_deadline_seconds", "default_max_cost_usd"] as const;

export function resolveEffectiveConfig(input: ResolveInput): { snapshot: Record<string, unknown>; digest: Checksum } {
  const known = new Set<string>([...BASE_KEYS, ...(input.extraKnownKeys ?? [])]);
  const overridable = new Set<string>([...input.harness.allowed_override_keys, ...(input.extraKnownKeys ?? [])]);
  const snapshot: Record<string, unknown> = Object.fromEntries(BASE_KEYS.map((k) => [k, input.harness[k]]));

  const layers: [string, Record<string, unknown>, boolean][] = [
    ["workflow", input.workflowDefaults, false],
    ["profile", input.profileOverrides, true],
    ["channel", input.channelOverrides, true],
    ["run", input.runOverrides, true],
  ];
  for (const [name, layer, restricted] of layers) {
    for (const [k, v] of Object.entries(layer)) {
      if (!known.has(k)) throw new HarnessError("UNKNOWN_CONFIG_KEY", `unknown config key "${k}" in ${name} layer`, { layer: name, key: k });
      if (v === undefined) throw new HarnessError("CONFIG_INVALID", `key "${k}" in ${name} layer must not be undefined`, { layer: name, key: k });
      if (restricted && !overridable.has(k)) throw new HarnessError("CONFIG_INVALID", `key "${k}" may not be overridden in ${name} layer`, { layer: name, key: k });
      snapshot[k] = v; // lists and objects replace, never merge
    }
  }
  // policy constraints (mandatory, applied last)
  const cost = Number(snapshot.default_max_cost_usd);
  if (Number.isFinite(cost) && cost > input.profileMaxCostUsd) snapshot.default_max_cost_usd = input.profileMaxCostUsd;
  return { snapshot, digest: canonicalDigest(snapshot) };
}
