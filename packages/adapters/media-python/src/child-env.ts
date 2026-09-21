/**
 * The child env allow-list for the Python media engine (sub-project 5A, spec: Global constraints): `PATH`,
 * `SystemRoot`, `TEMP`, `TMP`, any `CUDA_*` var, `HF_HOME`, `HF_HUB_OFFLINE` -- nothing else from the host
 * process ever reaches `transcribe.py`/`tts.py`/the probe script, and `PYTHONUTF8=1` is always set so those
 * scripts read/write UTF-8 regardless of the host's console code page (this machine is Windows).
 *
 * Same shape as `agentChildEnv` (`packages/adapters/agent-cli/src/cli-agent-runtime.ts`): a fixed allow-list
 * matched case-insensitively against the host env (Windows env var casing varies -- `Path`/`PATH`), emitting
 * the canonical name, plus a `CUDA_*` prefix pass-through (there is no fixed list of CUDA var names) -- and a
 * `HARNESS_SECRET_*` guard (case-insensitive on both sides) that wins over every other rule, including CUDA_*
 * (though no `CUDA_SECRET_*` var exists in practice, the guard is checked first for every key regardless).
 */
const FIXED_ALLOWLIST = ["PATH", "PATHEXT", "SystemRoot", "TEMP", "TMP", "HF_HOME", "HF_HUB_OFFLINE"];

function isHarnessSecret(key: string): boolean {
  return key.toUpperCase().startsWith("HARNESS_SECRET_");
}

export function mediaChildEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const upper = new Map<string, string | undefined>();
  for (const [k, v] of Object.entries(env)) upper.set(k.toUpperCase(), v);

  const out: Record<string, string> = {};
  for (const key of FIXED_ALLOWLIST) {
    if (isHarnessSecret(key)) continue;
    const v = upper.get(key.toUpperCase());
    if (v !== undefined) out[key] = v;
  }
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    const upperKey = key.toUpperCase();
    if (isHarnessSecret(upperKey)) continue;
    if (upperKey.startsWith("CUDA_")) out[key] = value;
  }
  out.PYTHONUTF8 = "1";
  return out;
}
