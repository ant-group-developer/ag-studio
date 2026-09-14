#!/usr/bin/env node
// Fake headless agent CLI, standing in for `claude -p ...` / `codex exec ...` in tests. Zero dependencies.
// Behaviour selected by argv[0] === "--version" (report and exit) or process.env.FAKE_AGENT_MODE (default "ok"):
//   ok         write every expected_outputs entry (a valid channel_package_draft for that type, `{ fake: true }` otherwise), exit 0
//   no-output  exit 0 without writing anything (runtime should report a missing-output contract failure)
//   crash      exit 1
//   env-dump   print every env var starting with HARNESS_ to stdout, then behave like "ok" (never HARNESS_SECRET_* — the
//              runtime must have stripped those from this process' env before spawning it)
//   long-title write like "ok" but with a 150-char title (over the skill's 100-char limit)
//   hang       never exit; the runtime is expected to kill this process once its deadline passes
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ULID_CHARS = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function fakeUlid() {
  let s = "";
  for (let i = 0; i < 26; i++) s += ULID_CHARS[Math.floor(Math.random() * ULID_CHARS.length)];
  return s;
}

if (process.argv[2] === "--version") {
  console.log("fake-agent 0.1.0");
  process.exit(0);
}

const cwd = process.cwd();
const promptPath = join(cwd, "agent-prompt.md");
if (!existsSync(promptPath)) process.exit(2);
const prompt = readFileSync(promptPath, "utf8");
const request = JSON.parse(readFileSync(join(cwd, "stage-request.json"), "utf8"));
const mode = process.env.FAKE_AGENT_MODE ?? "ok";

if (mode === "no-output") process.exit(0);
if (mode === "crash") process.exit(1);
if (mode === "hang") {
  setInterval(() => {}, 1 << 30); // keep the event loop alive: a bare pending promise does not by itself
  await new Promise(() => {}); // deliberately never resolves; only an external kill ends this process
}

if (mode === "env-dump") {
  for (const [k, v] of Object.entries(process.env)) if (k.startsWith("HARNESS_")) console.log(`${k}=${v}`);
}

function titleHint() {
  const m = prompt.match(/title_hint:\s*(.+)/);
  return (m ? m[1].trim() : "Fake package title").slice(0, 500);
}

mkdirSync(join(cwd, "output"), { recursive: true });
for (const eo of request.expected_outputs ?? []) {
  if (!eo.name) continue;
  const outPath = join(cwd, "output", eo.name);
  if (eo.kind === "directory") {
    mkdirSync(outPath, { recursive: true });
    writeFileSync(join(outPath, "placeholder.txt"), "fake");
    continue;
  }
  let content;
  if (eo.type === "channel_package_draft") {
    const title = mode === "long-title" ? "A".repeat(150) : titleHint();
    const thumbInput = (request.inputs ?? []).find((i) => i.type === "thumbnail_set");
    // Bare filename, not a path: both `hypothesis-complete` (readdirSync(thumbDir).includes(candidate)) and
    // `build-package` (join(sdk.input("thumbnail_set"), candidate)) resolve it relative to the thumbnail_set
    // directory root, not to the workspace root -- prefixing thumbInput.path here doubled that join and made
    // every real (non-fabricated) run of this fixture fail hypothesis-complete / ENOENT in build-package.
    let thumbnailCandidate = "thumbnail.png";
    if (thumbInput) {
      try {
        const files = readdirSync(join(cwd, thumbInput.path)).sort();
        if (files[0]) thumbnailCandidate = files[0];
      } catch { /* directory missing: keep the placeholder */ }
    }
    content = JSON.stringify({
      schema_version: "harness.channel-package-draft/v1",
      metadata: { title, description: "", tags: [], playlists: [], hashtags: [], pinned_comment: "", language: "vi" },
      hypothesis: {
        schema_version: "harness.hypothesis/v1",
        hypothesis_id: `hyp_${fakeUlid()}`,
        basis: [{ kind: "manual", note: "fake agent: no live research performed" }],
        chosen: { title, thumbnail_candidate: thumbnailCandidate, overlay_text: [], angle: "" },
        rejected: [{ title: "alternate title", angle: "", why: "fake agent placeholder rejection" }],
        expected: { metric: "views_72h", target: 1000, horizon_hours: 72 },
        status: "open",
        created_at: new Date().toISOString(),
      },
    }, null, 2);
  } else {
    content = JSON.stringify({ fake: true });
  }
  writeFileSync(outPath, content);
}

console.log(JSON.stringify({ total_cost_usd: 0.01 }));
