#!/usr/bin/env node
// Fake `claude -p --output-format json --json-schema <schema> ...` for Studio skills (GĐ4). Zero dependencies.
//
// Reads the whole prompt from stdin exactly as StudioAgentExecutor sends it (skill, brief, then every input as a
// fenced JSON block under `## <artifact type> (<file>)`), answers like the real CLI's JSON mode:
//   {"type":"result","subtype":"success","is_error":false,"structured_output":{...},"total_cost_usd":0}
// and writes the `--json-schema` it was given to logs/fake-claude-schema-<n>.json so tests can see it.
//
// FAKE_STUDIO_MODE, comma-separated:
//   select-bad-once   select-shots answers with an unknown id and a duplicate the first time, a valid
//                     selection once the prompt carries the repair section
//   select-bad-always select-shots never gets it right
//   rate-limit-once   the first call in a workspace prints the subscription-limit message and exits 1
//   narration-long    narration lines far longer than their beats
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv[2] === "--version") { console.log("fake-studio-claude 1.0.0"); process.exit(0); }

const modes = new Set((process.env.FAKE_STUDIO_MODE ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const cwd = process.cwd();
const stdin = await new Promise((res) => { let s = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", (d) => (s += d)); process.stdin.on("end", () => res(s)); });

mkdirSync(join(cwd, "logs"), { recursive: true });
const schemaIdx = process.argv.indexOf("--json-schema");
const schemaArg = schemaIdx > 0 ? process.argv[schemaIdx + 1] : null;
const n = readdirSync(join(cwd, "logs")).filter((f) => f.startsWith("fake-claude-schema-")).length;
if (schemaArg) { JSON.parse(schemaArg); writeFileSync(join(cwd, "logs", `fake-claude-schema-${n}.json`), schemaArg); }
appendFileSync(join(cwd, "logs", "fake-claude-prompts.log"), `----- call ${n}\n${stdin}\n`);

if (modes.has("rate-limit-once") && !existsSync(join(cwd, "logs", ".rate-limited"))) {
  writeFileSync(join(cwd, "logs", ".rate-limited"), "1");
  process.stderr.write("You've hit your 5-hour limit · resets 3pm (Asia/Ho_Chi_Minh)\n");
  process.exit(1);
}

const skill = (/^# Skill: (\S+)/m.exec(stdin) ?? [])[1];
const inputs = {};
for (const m of stdin.matchAll(/^## (\S+) \([^)]*\)\n```json\n([\s\S]*?)\n```/gm)) {
  const [, type, body] = m;
  if (type === "studio_catalog") {
    const [head, ...rows] = body.split("\n");
    inputs[type] = { ...JSON.parse(head), segments: rows.filter(Boolean).map((r) => JSON.parse(r)) };
  } else inputs[type] = JSON.parse(body);
}
const repairing = stdin.includes("# Lần trả lời trước bị hệ thống kiểm tra từ chối");
const brief = inputs.studio_brief;

function fits(seg) {
  const o = seg.orientation ?? null;
  if (!o || o === "square") return true;
  return brief.aspect === "9:16" ? o === "portrait" : o === "landscape";
}

function treatment() {
  const count = Math.max(2, Math.min(6, Math.round(brief.target_seconds / 10)));
  const base = Math.floor((brief.target_seconds / count) * 10) / 10;
  const beats = Array.from({ length: count }, (_, i) => ({
    beat_id: `B${String(i + 1).padStart(2, "0")}`,
    purpose: `Phần ${i + 1} về ${brief.title}`,
    seconds: i === count - 1 ? Math.round((brief.target_seconds - base * (count - 1)) * 10) / 10 : base,
    visual_idea: `Hình minh hoạ phần ${i + 1}`,
    narration_idea: `Ý lời dẫn phần ${i + 1}`,
  }));
  return { schema_version: "studio.treatment/v1", title: brief.title, logline: `Video ngắn về ${brief.title}`, beats };
}

function selection(bad) {
  const t = inputs.treatment;
  const pool = (inputs.studio_catalog?.segments ?? []).filter((s) => s.usable && fits(s));
  const used = new Set();
  const beats = t.beats.map((b) => {
    const picks = [];
    let footage = 0;
    for (const s of pool) {
      if (footage >= b.seconds) break;
      if (used.has(s.id)) continue;
      used.add(s.id); picks.push({ segment_id: s.id, reason: `hợp ý "${b.visual_idea}"` }); footage += s.duration_s;
    }
    return { beat_id: b.beat_id, picks, alternates: [] };
  });
  const spare = pool.filter((s) => !used.has(s.id));
  for (const b of beats) b.alternates = spare.slice(0, 3).map((s) => ({ segment_id: s.id, reason: "dự phòng" }));
  if (bad) {
    beats[0].picks.push({ segment_id: "khong-co-that", reason: "bịa" });
    if (beats[1]) beats[1].picks.push({ ...beats[0].picks[0] });
  }
  return { schema_version: "studio.selection/v1", beats };
}

function narration() {
  const t = inputs.treatment;
  let no = 0;
  const words = ["phở", "sáng", "hà", "nội", "nước", "dùng", "thơm", "ngon", "bánh", "thịt"];
  const lines = t.beats.flatMap((b) => {
    const count = modes.has("narration-long") ? Math.round(b.seconds * 6) : Math.max(2, Math.floor(b.seconds * 2.6 * 0.6));
    const text = Array.from({ length: count }, (_, i) => words[i % words.length]).join(" ");
    no++;
    return [{ line_id: `L${String(no).padStart(3, "0")}`, beat_id: b.beat_id, text: text.charAt(0).toUpperCase() + text.slice(1) + "." }];
  });
  return { schema_version: "studio.narration/v1", language: brief.language, lines };
}

let out;
if (skill === "studio-treatment") out = treatment();
else if (skill === "studio-select-shots") out = selection(modes.has("select-bad-always") || (modes.has("select-bad-once") && !repairing));
else if (skill === "studio-narration") out = narration();
else { process.stderr.write(`fake-studio-claude: unknown skill ${skill}\n`); process.exit(3); }

process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: out, total_cost_usd: 0, num_turns: 1 }) + "\n");
