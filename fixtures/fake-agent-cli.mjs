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
//
// Extra env var for sub-project 5A task 8's `narration.json` (edit-plan skill, library-production@1.2.0):
//   FAKE_NARRATION_CHARS   length in characters of each narration line's placeholder text when
//                          `brief.json.voice === "tts"` (default 40; a `media-fit-edl` test wanting a line
//                          longer than the footage available raises this). Ignored (fixed at 20) once
//                          `brief.json.request_notes` contains "thiếu" -- simulating a replanned, shorter line.
//
// Extra env var for sub-project 5B task 8's `overlays.json` (edit-plan skill, library-production@1.3.0):
//   FAKE_OVERLAYS   none | medium (default) | dense | invalid -- see buildOverlays below. `none` writes NO
//                   overlays.json at all (the output is `optional: true`, so the runtime must accept that);
//                   `dense` and `invalid` exist to make `overlays-valid` fail on purpose. A
//                   `brief.json.request_notes` containing "chữ" forces `medium`, simulating a replan after a
//                   text-related rejection.
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

/** `harness.survey-index/v2` (sub-project 5A task 8) from a multi-source `shots.json` (`sources: [...]`):
 * every shot gets `usable: true`, `score: 3`, and `speech` set to `"talking"` when `transcript.json` (input
 * type "transcript") has a segment overlapping the shot's `[in, out)` on the same `source_id`, else
 * `"none"`. */
function buildSurveyIndexV2(shotsDoc) {
  const transcriptInput = findInput("transcript");
  const transcriptDoc = transcriptInput ? tryReadJsonAt(transcriptInput.path) : null;
  const segmentsBySource = new Map();
  for (const s of transcriptDoc?.sources ?? []) segmentsBySource.set(s.source_id, s.segments ?? []);

  const shots = [];
  for (const src of shotsDoc.sources ?? []) {
    const segments = segmentsBySource.get(src.source_id) ?? [];
    for (const sh of src.shots ?? []) {
      const talking = segments.some((seg) => seg.start < sh.out && seg.end > sh.in);
      shots.push({
        source_id: src.source_id, shot_id: sh.shot_id, in: sh.in, out: sh.out, score: 3, tags: [],
        usable: true, note: "fake agent: no real survey", speech: talking ? "talking" : "none",
      });
    }
  }
  return { schema_version: "harness.survey-index/v2", shots: shots.length ? shots : [{ source_id: `src_${fakeUlid()}`, shot_id: "s000-000", in: 0, out: 1, score: 3, tags: [], usable: true, note: "fake agent: no real survey", speech: "none" }] };
}

/** `harness.survey-index/v1` from `shots.json` (input type "shots"): every shot gets score 4, usable true.
 * A multi-source `shots.json` (`{ sources: [...] }`, `library-production@1.2.0`) dispatches to
 * `buildSurveyIndexV2` instead; the single-source v1 shape (`{ source_id, shots: [...] }`, 1.1.0) below is
 * unchanged. */
function buildSurveyIndex() {
  const shotsInput = findInput("shots");
  const shotsDoc = shotsInput ? tryReadJsonAt(shotsInput.path) : null;
  if (shotsDoc && Array.isArray(shotsDoc.sources)) return buildSurveyIndexV2(shotsDoc);
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

/** `harness.edl/v1` from a multi-source `shots.json` (task 8): the first shot of up to 3 sources, one EDL
 * entry per source (`order` 0..n-1) -- `media-fit-edl` (run downstream) reshapes this to fit the narration,
 * so this fake agent does not need to fit any duration itself. */
function buildEdlMulti(shotsDoc) {
  const sources = (shotsDoc.sources ?? []).slice(0, 3);
  const entries = sources.map((src, i) => {
    const first = (src.shots ?? [])[0] ?? { in: 0, out: 1 };
    return { source_id: src.source_id, in: first.in, out: first.out, order: i, overlay: null, note: "" };
  });
  if (entries.length === 0) entries.push({ source_id: `src_${fakeUlid()}`, in: 0, out: 1, order: 0, overlay: null, note: "" });
  return { schema_version: "harness.edl/v1", entries };
}

/** `harness.edl/v1` from `shots.json`: one entry per shot, trimmed to `brief.json.target_duration_seconds`
 * (input type "brief") when present. A multi-source `shots.json` (`{ sources: [...] }`,
 * `library-production@1.2.0`) dispatches to `buildEdlMulti`; the single-source v1 shape (1.1.0) below is
 * unchanged. */
function buildEdl() {
  const shotsInput = findInput("shots");
  const shotsDoc = shotsInput ? tryReadJsonAt(shotsInput.path) : null;
  if (shotsDoc && Array.isArray(shotsDoc.sources)) return buildEdlMulti(shotsDoc);

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

/** `harness.narration/v1` (task 8): `lines: []` unless `brief.json.voice === "tts"`. One line per EDL entry
 * (`buildEdl()`, so `edl_order` always exists), each a fixed-length placeholder string: `FAKE_NARRATION_CHARS`
 * chars (default 40), or 20 when `brief.json.request_notes` contains "thiếu" -- simulating the agent writing
 * a shorter line after a `media-fit-edl` shortfall rejection carried that word into the replanned brief. */
function buildNarration() {
  const briefInput = findInput("brief");
  const brief = briefInput ? tryReadJsonAt(briefInput.path) : null;
  const language = brief?.language ?? "vi";
  if (!brief || brief.voice !== "tts") return { schema_version: "harness.narration/v1", language, lines: [] };

  const edl = buildEdl();
  const hadShortfallNote = typeof brief.request_notes === "string" && brief.request_notes.includes("thiếu");
  const perLineChars = hadShortfallNote ? 20 : Number(process.env.FAKE_NARRATION_CHARS ?? 40);
  const lines = edl.entries.map((e, i) => ({ line_id: `L${String(i + 1).padStart(3, "0")}`, edl_order: e.order, text: "x".repeat(Math.max(1, perLineChars)) }));
  return { schema_version: "harness.narration/v1", language, lines };
}

/** `FAKE_OVERLAYS` for this run: the env var, except that a brief whose `request_notes` mention "chữ" (a
 * text-related rejection carried into the replan) always goes back to the safe `medium` plan. */
function overlaysMode() {
  const briefInput = findInput("brief");
  const brief = briefInput ? tryReadJsonAt(briefInput.path) : null;
  if (typeof brief?.request_notes === "string" && brief.request_notes.includes("chữ")) return "medium";
  return process.env.FAKE_OVERLAYS ?? "medium";
}

/**
 * `harness.overlays/v1` (sub-project 5B §3). `medium` (the default) is a plan `overlays-valid` accepts: one
 * `title` anchored at the first narration line (`L001`) -- or at `edl_order 0` when there is no narration to
 * anchor to -- plus one `callout` at the middle EDL entry, and `music.mood: "calm"`. `dense` writes 30
 * callouts on one `edl_order` so the density/spacing rule fails; `invalid` anchors at a `line_id` no
 * narration has.
 */
function buildOverlays() {
  const mode_ = overlaysMode();
  const edl = buildEdl();
  const narration = buildNarration();
  const orders = edl.entries.map((e) => e.order);
  const firstOrder = orders[0] ?? 0;
  const midOrder = orders[Math.floor(orders.length / 2)] ?? firstOrder;

  if (mode_ === "dense") {
    return {
      schema_version: "harness.overlays/v1",
      items: Array.from({ length: 30 }, (_, i) => ({
        id: `OV${String(i + 1).padStart(3, "0")}`, kind: "callout", text: `chữ ${i + 1}`, anchor: { edl_order: firstOrder }, seconds: 3,
      })),
      transitions: [],
      music: { mood: "calm" },
    };
  }
  if (mode_ === "invalid") {
    return {
      schema_version: "harness.overlays/v1",
      items: [{ id: "OV01", kind: "title", text: "Tiêu đề sai neo", anchor: { line_id: "L999" }, seconds: 4 }],
      transitions: [],
      music: { mood: "calm" },
    };
  }

  const titleAnchor = narration.lines.length > 0 ? { line_id: narration.lines[0].line_id } : { edl_order: firstOrder };
  return {
    schema_version: "harness.overlays/v1",
    items: [
      { id: "OV01", kind: "title", text: "Tiêu đề mở đầu", anchor: titleAnchor, seconds: 4 },
      { id: "OV02", kind: "callout", text: "Điểm nhấn", anchor: { edl_order: midOrder }, seconds: 3 },
    ],
    transitions: [],
    music: { mood: "calm" },
  };
}

const REVIEW_CHECK_IDS = ["duration_in_range", "no_black_or_frozen_over_2s", "opening_matches_style", "text_not_clipped", "audio_present", "thumbnails_textless"];

/** `harness.review/v1` per FAKE_REVIEW_MODE: "approve" (default) always approves; "reject-always" always
 * rejects; "reject-once" rejects only on the first pass (brief.json.request_notes empty -- no prior
 * rejection recorded yet) and approves once a replan has carried request_notes forward.
 *
 * Task 8: when a `fit_report` input (`harness.fit-report/v1`, `media-fit-edl`'s output) is present and
 * `shortfalls.length > 0 || reused_seconds > 5 || within_target === false`, this rejects unconditionally --
 * `FAKE_REVIEW_MODE` is not consulted at all, mirroring the `library-review` skill's own step 0 (a footage
 * shortfall is always a hard reject, decided before the 6 fixed checks). `note` names every `line_id` and the
 * total `missing_seconds` so a replanned `edit-plan` fixes the right lines. */
function buildReview() {
  const mode_ = process.env.FAKE_REVIEW_MODE ?? "approve";
  const briefInput = findInput("brief");
  const brief = briefInput ? tryReadJsonAt(briefInput.path) : null;
  const hasNotes = Boolean(brief?.request_notes && brief.request_notes.trim().length > 0);

  const fitReportInput = findInput("fit_report");
  const fitReport = fitReportInput ? tryReadJsonAt(fitReportInput.path) : null;
  const shortfalls = fitReport?.shortfalls ?? [];
  const footageRejected = Boolean(fitReport && (shortfalls.length > 0 || (fitReport.reused_seconds ?? 0) > 5 || fitReport.within_target === false));

  // Sub-project 5B (library-production@1.3.0): the composition side of the review. `render-report.json`
  // (`render_report` input) is the authority on what was actually rendered; `composition.json` carries the
  // same `warnings`/`text_dropped` and is read alongside it, exactly as the skill tells a real reviewer to.
  const renderReport = findInput("render_report") ? tryReadJsonAt(findInput("render_report").path) : null;
  const composition = findInput("composition") ? tryReadJsonAt(findInput("composition").path) : null;
  const downgraded = renderReport?.transitions?.downgraded ?? [];
  const requestedTransitions = renderReport?.transitions?.requested ?? 0;
  const droppedText = renderReport?.text_events?.dropped ?? composition?.text_dropped ?? [];
  const musicTrackId = renderReport ? (renderReport.music?.track_id ?? null) : undefined;
  const musicReason = renderReport?.music?.reason ?? composition?.music_reason;
  const musicMissing = Boolean(renderReport && musicTrackId === null && !["no_brand", "brand_no_tracks"].includes(String(musicReason)));
  const transitionsBroken = requestedTransitions > 0 && downgraded.length > 0.3 * requestedTransitions;
  const renderRejected = Boolean(renderReport) && (transitionsBroken || droppedText.length > 0 || musicMissing);

  /** Every rejection reason EXCEPT the composition-side one -- the two write different `checks` entries. */
  const otherRejected = footageRejected || (mode_ === "reject-always" ? true : mode_ === "reject-once" ? !hasNotes : false);
  const rejected = otherRejected || renderRejected;
  // A `within_target: false` rejection with NO shortfall is a different fault from "the lines have no
  // picture": the picture covers the script fine, the programme is simply the wrong length. Saying "thiếu
  // 0.0 s ở " there (what this used to write) tells a replanned `edit-plan` nothing at all, so name the
  // measured duration and the target instead -- the real `library-review` skill's step 0 does the same.
  const overshot = Boolean(fitReport && shortfalls.length === 0 && fitReport.within_target === false);
  const checks = REVIEW_CHECK_IDS.map((id) => ({ id, pass: true, note: "" }));
  // A composition-side rejection (5B) names the overlay ids / `before_order`s that need replanning, so a
  // replanned `edit-plan` fixes the right items (spec §6.3). It fails `text_not_clipped`, not the duration
  // check the footage path uses, and it is decided BEFORE the footage/`FAKE_REVIEW_MODE` notes below so a
  // rejection reason is never attributed to the wrong check.
  const renderNote = renderRejected
    ? "fake agent: " + [
      droppedText.length > 0 ? `chữ bị bỏ: ${droppedText.map((d) => `${d.id} (${d.reason})`).join(", ")}` : "",
      transitionsBroken ? `chuyển cảnh hạ cấp: ${downgraded.map((d) => `before_order ${d.before_order} (${d.reason})`).join(", ")}` : "",
      musicMissing ? `nhạc không chọn được: ${String(musicReason ?? "unknown")}` : "",
    ].filter(Boolean).join("; ")
    : "";
  if (renderRejected) checks[3] = { id: REVIEW_CHECK_IDS[3], pass: false, note: renderNote };
  if (otherRejected) {
    const footageNote = overshot
      ? `fake agent: ${Number(fitReport.total_seconds ?? 0).toFixed(1)} s ngoài khoảng đích ${JSON.stringify(fitReport.target_duration_seconds ?? [])}`
      : "fake agent: thiếu hình cho lời (media-fit-edl)";
    checks[0] = { id: REVIEW_CHECK_IDS[0], pass: false, note: footageRejected ? footageNote : "fake agent: thời lượng vượt khoảng đích tại t=95.0s" };
  }
  if (renderRejected) return { schema_version: "harness.review/v1", decision: "rejected", note: renderNote, checks };

  let note;
  if (overshot) {
    note = `fake agent: tổng ${Number(fitReport.total_seconds ?? 0).toFixed(1)} s nằm ngoài khoảng đích ${JSON.stringify(fitReport.target_duration_seconds ?? [])}`;
  } else if (footageRejected) {
    const missingSeconds = shortfalls.reduce((a, s) => a + (s.missing_seconds ?? 0), 0);
    const lineIds = shortfalls.flatMap((s) => s.line_ids ?? []);
    note = `fake agent: thiếu ${missingSeconds.toFixed(1)} s ở ${lineIds.join(", ")}`;
  } else {
    note = rejected ? "fake agent: review tự động phát hiện lỗi" : "fake agent: review tự động, đạt";
  }

  return { schema_version: "harness.review/v1", decision: rejected ? "rejected" : "approved", note, checks };
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
  // `FAKE_OVERLAYS=none`: write no overlays.json at all. The output is declared `optional: true` in
  // `library-production@1.3.0`, so the runtime must accept the stage without it -- an edit plan with no text
  // on screen is a legitimate plan.
  if (eo.type === "overlays" && overlaysMode() === "none") continue;
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
    // 1.1.0's narration output is text/plain narration.txt (always empty, unchanged); 1.2.0's is
    // application/json narration.json (harness.narration/v1, task 8).
    case "narration": content = eo.mime_type === "application/json" ? JSON.stringify(buildNarration(), null, 2) : ""; break;
    case "overlays": content = JSON.stringify(buildOverlays(), null, 2); break;
    case "review": content = JSON.stringify(buildReview(), null, 2); break;
    default: content = JSON.stringify({ fake: true });
  }
  writeFileSync(outPath, content);
}

console.log(JSON.stringify({ total_cost_usd: 0.01 }));
