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
//   style-active  like "ok", but a `style` output with no existing `style` input defaults to status "active"
//                 instead of "draft" (see buildStyle below)
//
// Extra env vars for sub-project 4's five studio skills (style-analyze, style-review, source-survey,
// edit-plan, library-review), consulted only when an `expected_outputs[].type` needs them:
//   FAKE_STYLE_STATUS   overrides the `style` output's status outright (only when there is no `style`
//                        input to review -- i.e. this is standing in for style-analyze, not style-review)
//   FAKE_STYLE_REVIEW=keep-draft   when there IS a `style` input (style-review), keep status "draft"
//                                  instead of the default "active"
//   FAKE_REVIEW_MODE     approve (default) | reject-once | reject-always -- see buildReview below
//   FAKE_AGENT_FAIL_STAGE=<stage_key>   behave like "no-output" only when stage-request.json.stage_key
//                                       matches, regardless of FAKE_AGENT_MODE (task 8: targeted failure)
//
// Extra env vars for sub-project 3B's channel-planning/channel-package skills, consulted only when an
// `expected_outputs[].type` needs them:
//   FAKE_ANGLE    overrides the `angle` written into a `topic_proposal`'s topics / a `channel_package_draft`'s
//                 `hypothesis.chosen.angle` (a test learning a channel standard needs two packages sharing one angle)
//   FAKE_METRIC   overrides a `channel_package_draft`'s `hypothesis.expected.metric`
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

const failStage = process.env.FAKE_AGENT_FAIL_STAGE;
if (failStage && failStage === request.stage_key) process.exit(0);

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

/** First input entry of `type`, or undefined. */
function findInput(type) {
  return (request.inputs ?? []).find((i) => i.type === type);
}

/** Reads and JSON-parses `<cwd>/<relPath>`; null on any error (missing file, bad JSON, ...). */
function tryReadJsonAt(relPath) {
  try { return JSON.parse(readFileSync(join(cwd, relPath), "utf8")); }
  catch { return null; }
}

const DEFAULT_STYLE_PARAMS = {
  cut_rhythm: "medium",
  shot_seconds: [1, 3],
  transitions: ["cut"],
  text_overlay: { style: "bold", density: "medium" },
  subtitles: "none",
  music: { mood: "neutral", ducking: false },
  opening: { seconds: 2, structure: "hook" },
  aspect_ratio: "16:9",
  pace_notes: "",
};

/** `harness.edit-style/v1`. When an input of type "style" exists (style-review, reviewing a draft), the
 * status defaults to "active" (env FAKE_STYLE_REVIEW=keep-draft keeps "draft"); otherwise (style-analyze,
 * no draft to review yet) it is FAKE_STYLE_STATUS, or "active" only under FAKE_AGENT_MODE=style-active,
 * else "draft". Reuses the input style's fields where present so a review round-trips style_id/revision. */
function buildStyle() {
  const styleInput = findInput("style");
  const base = styleInput ? tryReadJsonAt(styleInput.path) : null;
  const now = new Date().toISOString();
  const status = base
    ? (process.env.FAKE_STYLE_REVIEW === "keep-draft" ? "draft" : "active")
    : (process.env.FAKE_STYLE_STATUS ?? (mode === "style-active" ? "active" : "draft"));

  let learnedFrom = base?.learned_from;
  if (!learnedFrom) {
    learnedFrom = [];
    const sampleInput = findInput("sample_set");
    const samples = sampleInput ? tryReadJsonAt(join(sampleInput.path, "samples.json")) : null;
    if (Array.isArray(samples)) {
      learnedFrom = samples.map((s, i) => ({ label: s.label ?? `s${s.index ?? i}`, notes: "fake agent: no real analysis" }));
    }
  }

  return {
    schema_version: "harness.edit-style/v1",
    style_id: base?.style_id ?? `style_${fakeUlid()}`,
    revision: base?.revision ?? 1,
    name: base?.name ?? "Fake style",
    status,
    learned_from: learnedFrom,
    params: base?.params ?? DEFAULT_STYLE_PARAMS,
    evidence: base?.evidence ?? [],
    created_at: base?.created_at ?? now,
    updated_at: now,
  };
}

/** One evidence line per `style.params.*` field, matching the style-analyze skill's documented shape. */
function buildStyleEvidenceNotes() {
  const style = buildStyle();
  const lines = ["# Evidence notes (fake agent)", ""];
  for (const key of Object.keys(style.params)) lines.push(`- ${key}: video s0, t=1.0s: fake evidence (no real analysis)`);
  return lines.join("\n") + "\n";
}

function buildReviewNotesMd() {
  const style = buildStyle();
  const lines = [`# Đối chiếu ${style.style_id}`, "", "| mục | đạt/lệch | khung dẫn chứng |", "|---|---|---|"];
  for (const key of Object.keys(style.params)) lines.push(`| ${key} | đạt | s0 t=1.0s |`);
  return lines.join("\n") + "\n";
}

function buildSurveyMd() {
  return "# Khảo sát nguồn (fake agent)\n\nKhông có phân tích thật -- dữ liệu giả cho test.\n";
}

/** `harness.survey-index/v1` from `shots.json` (input type "shots"): every shot gets score 4, usable true. */
function buildSurveyIndex() {
  const shotsInput = findInput("shots");
  const shotsDoc = shotsInput ? tryReadJsonAt(shotsInput.path) : null;
  const shots = shotsDoc?.shots?.length ? shotsDoc.shots : [{ in: 0, out: 1 }];
  return {
    schema_version: "harness.survey-index/v1",
    shots: shots.map((s) => ({ in: s.in, out: s.out, score: 4, tags: [], usable: true, note: "fake agent: no real survey" })),
  };
}

/** Trims/drops trailing shots so the total `out - in` lands inside `[min, max]`; keeps everything (no
 * padding) when the source is shorter than `min`. `shots` is `[{ in, out }, ...]` in source order. */
function fitShotsToRange(shots, range) {
  if (!range) return shots.map((s, i) => ({ ...s, order: i }));
  const [, max] = range;
  const out = [];
  let total = 0;
  for (const s of shots) {
    if (total >= max) break;
    const segLen = s.out - s.in;
    if (total + segLen <= max) {
      out.push({ in: s.in, out: s.out });
      total += segLen;
    } else {
      const remaining = max - total;
      if (remaining > 0) out.push({ in: s.in, out: s.in + remaining });
      break;
    }
  }
  return out.map((s, i) => ({ ...s, order: i }));
}

/** `harness.edl/v1` from `shots.json`: one entry per shot, trimmed to `brief.json.target_duration_seconds`
 * (input type "brief") when present. */
function buildEdl() {
  const shotsInput = findInput("shots");
  const shotsDoc = shotsInput ? tryReadJsonAt(shotsInput.path) : null;
  const sourceId = shotsDoc?.source_id ?? `src_${fakeUlid()}`;
  const rawShots = shotsDoc?.shots?.length ? shotsDoc.shots : [{ in: 0, out: 5 }];

  const briefInput = findInput("brief");
  const brief = briefInput ? tryReadJsonAt(briefInput.path) : null;
  const fitted = fitShotsToRange(rawShots, brief?.target_duration_seconds);

  return {
    schema_version: "harness.edl/v1",
    entries: fitted.map((s) => ({ source_id: sourceId, in: s.in, out: s.out, order: s.order, overlay: null, note: "" })),
  };
}

const REVIEW_CHECK_IDS = ["duration_in_range", "no_black_or_frozen_over_2s", "opening_matches_style", "text_not_clipped", "audio_present", "thumbnails_textless"];

/** `harness.review/v1` per FAKE_REVIEW_MODE: "approve" (default) always approves; "reject-always" always
 * rejects; "reject-once" rejects only on the first pass (brief.json.request_notes empty -- no prior
 * rejection recorded yet) and approves once a replan has carried request_notes forward. */
function buildReview() {
  const mode_ = process.env.FAKE_REVIEW_MODE ?? "approve";
  const briefInput = findInput("brief");
  const brief = briefInput ? tryReadJsonAt(briefInput.path) : null;
  const hasNotes = Boolean(brief?.request_notes && brief.request_notes.trim().length > 0);

  const rejected = mode_ === "reject-always" ? true : mode_ === "reject-once" ? !hasNotes : false;
  const checks = REVIEW_CHECK_IDS.map((id) => ({ id, pass: true, note: "" }));
  if (rejected) checks[0] = { id: REVIEW_CHECK_IDS[0], pass: false, note: "fake agent: thời lượng vượt khoảng đích tại t=95.0s" };

  return {
    schema_version: "harness.review/v1",
    decision: rejected ? "rejected" : "approved",
    note: rejected ? "fake agent: review tự động phát hiện lỗi" : "fake agent: review tự động, đạt",
    checks,
  };
}

/** medians.* key for a `ChannelLearned.metric` value -- `ctr` targets `medians.ctr_pct`, the other two share
 * their own name (see `ChannelLearnedSchema` in packages/contracts/src/learning.ts). */
const MEDIAN_KEY_FOR_METRIC = { ctr: "ctr_pct", views_72h: "views_72h", avg_view_pct: "avg_view_pct" };

/** lowercase, trim, collapse internal whitespace -- same normalization `learningCheckers`'s `topics-valid`
 * uses for duplicate detection (packages/core/src/learning/checkers.ts). */
function normalizeTopic(s) {
  return String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

function buildChannelPackageDraft() {
  const title = mode === "long-title" ? "A".repeat(150) : titleHint();
  const thumbInput = findInput("thumbnail_set");
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

  // Channel-aware (sub-project 3B, channel-publish@1.1.0's `package` stage): when a `channel_brief` input is
  // present, follow the channel's learned standard the same way the real `channel-package` skill does.
  const briefInput = findInput("channel_brief");
  const brief = briefInput ? tryReadJsonAt(briefInput.path) : null;
  const learned = brief?.learned ?? null;
  const standard = learned?.standard;
  const hasStandard = Boolean(standard && (standard.angle || standard.title_pattern || standard.overlay_lines));

  let angle = learned?.standard?.angle ?? "";
  if (process.env.FAKE_ANGLE !== undefined) angle = process.env.FAKE_ANGLE;

  const basis = [{ kind: "manual", note: "fake agent: no live research performed" }];
  if (hasStandard) basis.push({ kind: "channel", note: "theo chuẩn kênh (fake)" });

  const metric = process.env.FAKE_METRIC ?? learned?.metric ?? "views_72h";
  const medianValue = learned?.medians?.[MEDIAN_KEY_FOR_METRIC[metric]];
  const target = medianValue * 1.1 || 1000;

  return {
    schema_version: "harness.channel-package-draft/v1",
    metadata: { title, description: "", tags: [], playlists: [], hashtags: [], pinned_comment: "", language: "vi" },
    hypothesis: {
      schema_version: "harness.hypothesis/v1",
      hypothesis_id: `hyp_${fakeUlid()}`,
      basis,
      chosen: { title, thumbnail_candidate: thumbnailCandidate, overlay_text: [], angle },
      rejected: [{ title: "alternate title", angle: "", why: "fake agent placeholder rejection" }],
      expected: { metric, target, horizon_hours: 72 },
      status: "open",
      created_at: new Date().toISOString(),
    },
  };
}

/** `harness.topic-proposal/v1` for the `propose-topics` stage of `channel-planning` (sub-project 3B): reads
 * `needed` (and the per-run cap `topics_per_run`) from the `demand` input and the channel's niche/learned
 * angle plus everything already spoken for (open requests, recent hypothesis titles) from the `channel_brief`
 * input, then invents up to `max(1, min(needed, topics_per_run ?? 3, 3))` new, non-duplicate topics. */
function buildTopicProposal() {
  const demandInput = findInput("demand");
  const demand = demandInput ? tryReadJsonAt(demandInput.path) : null;
  const briefInput = findInput("channel_brief");
  const brief = briefInput ? tryReadJsonAt(briefInput.path) : null;

  const needed = typeof demand?.needed === "number" ? demand.needed : 1;
  const topicsPerRun = typeof demand?.topics_per_run === "number" ? demand.topics_per_run : 3;
  const niche = brief?.channel?.seo?.niche || "kênh";
  let angle = brief?.learned?.standard?.angle ?? "";
  if (process.env.FAKE_ANGLE !== undefined) angle = process.env.FAKE_ANGLE;

  const seen = new Set();
  for (const r of brief?.open_requests ?? []) seen.add(normalizeTopic(r.topic));
  for (const h of brief?.hypotheses ?? []) seen.add(normalizeTopic(h.chosen?.title));

  const count = Math.max(1, Math.min(needed, topicsPerRun, 3));
  const topics = [];
  for (let n = 1; topics.length < count && n <= count + seen.size + 10; n++) {
    const candidate = `Chủ đề tự động ${n} về ${niche}`;
    const key = normalizeTopic(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push({ topic: candidate, angle, why: "fake: theo demand" });
  }

  return { schema_version: "harness.topic-proposal/v1", topics };
}

mkdirSync(join(cwd, "output"), { recursive: true });
for (const eo of request.expected_outputs ?? []) {
  if (!eo.name) continue;
  const outPath = join(cwd, "output", eo.name);
  if (eo.kind === "directory") {
    mkdirSync(outPath, { recursive: true });
    if (eo.type === "style_evidence") writeFileSync(join(outPath, "notes.md"), buildStyleEvidenceNotes());
    else writeFileSync(join(outPath, "placeholder.txt"), "fake");
    continue;
  }
  let content;
  switch (eo.type) {
    case "channel_package_draft": content = JSON.stringify(buildChannelPackageDraft(), null, 2); break;
    case "topic_proposal": content = JSON.stringify(buildTopicProposal(), null, 2); break;
    case "style": content = JSON.stringify(buildStyle(), null, 2); break;
    case "review_notes": content = buildReviewNotesMd(); break;
    case "survey": content = buildSurveyMd(); break;
    case "survey_index": content = JSON.stringify(buildSurveyIndex(), null, 2); break;
    case "edl": content = JSON.stringify(buildEdl(), null, 2); break;
    case "edit_plan": content = JSON.stringify({ schema_version: "harness.edit-plan/v1", notes: "" }, null, 2); break;
    case "narration": content = ""; break;
    case "review": content = JSON.stringify(buildReview(), null, 2); break;
    default: content = JSON.stringify({ fake: true });
  }
  writeFileSync(outPath, content);
}

console.log(JSON.stringify({ total_cost_usd: 0.01 }));
