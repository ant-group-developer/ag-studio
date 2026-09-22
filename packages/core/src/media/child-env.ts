/**
 * Env for any child process the media path spawns -- the transcribe hook, every ffmpeg the renderer runs,
 * every ffmpeg/ffprobe a checker or a doctor probe shells out to.
 *
 * Everything the harness process itself has, minus every `HARNESS_SECRET_*` variable: none of these children
 * has a legitimate reason to see a secret, and the repo rule is absolute ("child processes never receive
 * `HARNESS_SECRET_*`", AGENTS.md). This is a DENYLIST by name prefix, not an allowlist -- ffmpeg needs an
 * ordinary user environment (`PATH`, `TEMP`, locale, `CUDA_VISIBLE_DEVICES`, ...), exactly like the Playwright
 * children `publisherChildEnv()` builds in sub-project 3. The prefix match is case-insensitive, matching 5A's
 * `mediaChildEnv`: Windows environment variable names are case-insensitive, so a `harness_secret_x_y` set in a
 * shell is the same variable as `HARNESS_SECRET_X_Y` and must be stripped too.
 */
export function childEnvWithoutSecrets(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k.toUpperCase().startsWith("HARNESS_SECRET_")) continue;
    out[k] = v;
  }
  return out;
}
