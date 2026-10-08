#!/usr/bin/env node
// Fake `claude -p --output-format json --json-schema <schema> ...` for Studio skills (GĐ2). Zero dependencies.
//
// Reads the whole prompt from stdin exactly as StudioAgentExecutor sends it (skill, brief, then every input as a
// fenced JSON block under `## <artifact type> (<file>)`), answers like the real CLI's JSON mode:
//   {"type":"result","subtype":"success","is_error":false,"structured_output":{...},"total_cost_usd":0}
// and writes the `--json-schema` it was given to logs/fake-claude-schema-<n>.json so tests can see it.
//
// FAKE_STUDIO_MODE, comma-separated:
//   plan-bad-once     plan-episodes answers with an unknown asset_id the first time, valid on repair
//   rate-limit-once   the first call in a workspace prints the subscription-limit message and exits 1
//   web-research-bad-once  the web research first answers a link that is not YouTube, valid on repair
//   style-bad-once    the style first misquotes the measured median, valid on repair (resumed session)
//   edit-plan-ignore-style-once  the edit plan first cuts 4 s pieces whatever the style says, follows it on repair
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

if (process.argv[2] === "--version") { console.log("fake-studio-claude 2.0.0"); process.exit(0); }

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
    // full catalog (plan-episodes): a header line, then one asset per line; the R&D gets `studio_catalog_summary`
    // v2: first line is header JSON, rest are one asset per line (compact)
    const lines = body.split("\n").filter(Boolean);
    const [head, ...rows] = lines;
    const header = JSON.parse(head);
    const assets = rows.map((r) => JSON.parse(r));
    inputs[type] = { ...header, assets };
  } else { try { inputs[type] = JSON.parse(body); } catch { inputs[type] = {}; } }
}
const repairing = stdin.includes("# Lần trả lời trước bị hệ thống kiểm tra từ chối");
const brief = inputs.studio_brief ?? {};
const seed = inputs.studio_seed ?? {};

function fits(asset) {
  const o = asset.orientation ?? null;
  if (!o || o === "square") return true;
  return brief.aspect === "9:16" ? o === "portrait" : o === "landscape";
}

// ---------------------------------------------------------------------------
// GĐ2 skills
// ---------------------------------------------------------------------------

function trendReport() {
  return {
    schema_version: "studio.trend-report/v1",
    skipped: false,
    summary: "Dữ liệu nghiên cứu cho thấy video ngắn 3–5 phút với hook mạnh và thumbnail cận cảnh hoạt động tốt nhất trong lĩnh vực này.",
    working_angles: ["Trải nghiệm thực tế", "Bí mật ít người biết", "Lần đầu khám phá"],
    title_patterns: ["[Từ khoá] — [Con số/Bí mật]", "Lần đầu [Hành động] tại [Địa điểm]"],
    hook_patterns: ["Câu hỏi cá nhân hoá", "Con số gây ngạc nhiên", "Cảnh đẹp + nhạc nền"],
    thumbnail_patterns: ["Cận cảnh khuôn mặt + chữ nổi bật", "Cảnh đẹp panorama + logo nhỏ"],
    recommended_duration_s: brief.episode_target_seconds ?? seed.hints?.episode_target_seconds ?? 180,
    posting_schedule: "Thứ 3 và Thứ 6, 18:00–20:00 (UTC+7)",
    recommendations: ["Dùng hook câu hỏi trong 5 giây đầu", "Thumbnail luôn có yếu tố con người", "Upload phụ đề tiếng Anh để mở rộng reach"],
  };
}

function planEpisodes() {
  const catalog = inputs.studio_catalog;
  const assets = (catalog?.assets ?? []).filter((a) => a.usable && fits(a));
  const targetSeconds = brief.episode_target_seconds ?? 180;
  const maxEpisodes = brief.max_episodes ?? 2;
  if (!assets.length) {
    return {
      schema_version: "studio.series-plan/v1",
      series_title: brief.title ?? "Series",
      rationale: "Không đủ footage, tạo 1 tập với danh sách trống.",
      episodes: [{
        idx: 1, title: brief.title ?? "Tập 1", hook: "Khởi đầu hành trình.", logline: "Câu chuyện về " + (brief.title ?? "series"),
        target_seconds: targetSeconds, items: [], alternates: [], texts_suggested: [],
      }],
    };
  }
  // Split assets into up to maxEpisodes episodes (at most 2 when assets >= 4)
  const epCount = Math.min(maxEpisodes, assets.length >= 4 ? 2 : 1);
  const perEp = Math.ceil(assets.length / epCount);
  const episodes = [];
  for (let e = 0; e < epCount; e++) {
    const slice = assets.slice(e * perEp, (e + 1) * perEp);
    // Fill items until roughly targetSeconds; assign section_title every 2 items (skip first)
    const items = [];
    let dur = 0;
    for (const a of slice) {
      if (dur >= targetSeconds * 1.2) break;
      const sectionIdx = items.length;
      const section_title = sectionIdx > 0 && sectionIdx % 2 === 0 ? `Phần ${Math.floor(sectionIdx / 2) + 1}` : null;
      items.push({ asset_id: a.asset_id ?? a.id, reason: "phù hợp topic", section_title });
      dur += (a.duration_s ?? 30);
    }
    if (!items.length && slice.length) {
      items.push({ asset_id: slice[0].asset_id ?? slice[0].id, reason: "phù hợp topic", section_title: null });
    }
    // Inject a bad id on first call if mode is set
    if (e === 0 && (modes.has("plan-bad-always") || (modes.has("plan-bad-once") && !repairing))) {
      items.push({ asset_id: "khong-co-that", reason: "fake bad id", section_title: null });
    }
    // Alternates: remaining assets not used in this episode
    const usedIds = new Set(items.map((it) => it.asset_id));
    const alternates = assets.filter((a) => !usedIds.has(a.asset_id ?? a.id)).slice(0, 3).map((a) => ({ asset_id: a.asset_id ?? a.id, reason: "dự phòng" }));
    const texts_suggested = items.length >= 1 ? [{ at_item: 0, kind: "title", text: `Tập ${e + 1}: ${brief.title ?? "Video"}`.slice(0, 64) }] : [];
    episodes.push({
      idx: e + 1,
      title: `${brief.title ?? "Series"} — Phần ${e + 1}`,
      hook: `Khám phá những điều thú vị trong tập ${e + 1}.`,
      logline: `Tập ${e + 1} của series ${brief.title ?? ""} với ${items.length} clip nổi bật.`,
      target_seconds: targetSeconds,
      items,
      alternates,
      texts_suggested,
      // "plan-cut": the first episode is cut shot by shot with narration (phase 5); others whole videos
      ...(modes.has("plan-cut") ? (e === 0 ? { edit_style: "cut", narration: "tts" } : { edit_style: "whole", narration: "none" }) : {}),
    });
  }
  return {
    schema_version: "studio.series-plan/v1",
    series_title: brief.title ?? "Series",
    rationale: `Chia ${assets.length} video usable thành ${epCount} tập, mỗi tập ≈ ${targetSeconds}s.`,
    episodes,
  };
}

function youtubeKit() {
  const episode = inputs.studio_episode ?? {};
  const items = episode.items ?? [];
  const firstAssetId = items[0]?.asset_id ?? "unknown";
  const midAssetId = items[Math.floor(items.length / 2)]?.asset_id ?? firstAssetId;
  const lastAssetId = items[items.length - 1]?.asset_id ?? firstAssetId;
  const title = episode.title ?? brief.title ?? "Video";
  // Follow the production's branding when the episode has one (title length, thumbnail words and case, series
  // hashtags): the kit check asks Claude to fix those, so the fake must already comply.
  const b = inputs.studio_branding ?? null;
  const maxChars = b?.titles?.max_chars ?? 100;
  const maxWords = b?.thumbnail?.max_words ?? 8;
  const thumbText = (t) => {
    const words = t.split(/[^\p{L}\p{N}]+/u).filter(Boolean).slice(0, maxWords).join(" ").slice(0, 40);
    return b?.thumbnail?.text_case === "upper" ? words.toLocaleUpperCase("vi") : words;
  };
  return {
    schema_version: "studio.youtube-kit/v1",
    titles: [
      `${title} — Khám Phá Đầy Đủ`,
      `Bí Mật Về ${title} Ít Ai Biết`,
      `Lần Đầu Trải Nghiệm ${title}`,
    ].map((t) => t.slice(0, maxChars)),
    description: `${episode.hook ?? title}\n\nTập này sẽ đưa bạn đến với ${title}. Theo dõi kênh để không bỏ lỡ tập tiếp theo!`,
    tags: ["du lịch", "Việt Nam", ...(brief.keywords ?? []).slice(0, 5), title.split(" ").slice(0, 3).join(" ")],
    hashtags: [...new Set([...(b?.description?.hashtags ?? []), "#ViệtNam", "#DuLịch", `#${title.replace(/[^\p{L}\p{N}_]+/gu, "").slice(0, 60)}`])],
    thumbnails: [
      { asset_id: firstAssetId, text: thumbText(title) },
      { asset_id: midAssetId, text: thumbText("Khám Phá Ngay") },
      { asset_id: lastAssetId, text: thumbText("Không Thể Bỏ Lỡ") },
    ],
    playlist: b?.series_name ?? brief.title ?? "Series",
  };
}

// ---------------------------------------------------------------------------
// Research first (plan v2): R&D and branding
// ---------------------------------------------------------------------------

function rnd() {
  const h = seed.hints ?? {};
  const own = (seed.channels ?? []).filter((c) => c.role === "own");
  const footage = inputs.studio_catalog_summary ?? {};
  const title = seed.title ?? "Series";
  // rnd-ignore-hint-once: the first answer leaves the episode length the person typed (the check asks for a repair)
  const ignoreHint = modes.has("rnd-ignore-hint-once") && !repairing && h.episode_target_seconds != null;
  return {
    schema_version: "studio.rnd/v1",
    summary: `Series "${title}" dựng từ ${footage.kept ?? 0} video có sẵn, cho người xem trẻ thích khám phá.`,
    market: {
      opportunities: ["Ít kênh làm chủ đề này đều đặn"],
      gaps: ["Thiếu video quay buổi sáng"],
      risks: ["Kênh lớn đã có loạt tương tự"],
      competitors: [],
    },
    own_channels: own.length
      ? { assessment: `Kênh ${own[0].url} còn mới, cần nhịp đăng đều.`, strengths: ["Kho footage sẵn có"], weaknesses: ["Tiêu đề chưa có công thức"], recommendations: ["Đăng 2 tập mỗi tuần"] }
      : null,
    footage_fit: { summary: "Footage hợp các tập ngắn về món ăn và phố phường.", strong_themes: ["ẩm thực"], gaps: [] },
    direction: {
      description: h.description || `Mỗi tập kể một câu chuyện về ${title}.`,
      goal: h.goal || "Tăng người xem trung thành",
      audience: h.audience || "Người Việt 18–35 thích khám phá",
      tone: h.tone || "Ấm áp, gần gũi",
      positioning: `${title}: chân thật, không dàn dựng`,
      content_pillars: [{ name: "Câu chuyện", description: "Mỗi tập một câu chuyện trọn vẹn" }],
      episode_target_seconds: ignoreHint ? h.episode_target_seconds + 60 : (h.episode_target_seconds ?? 120),
      max_episodes: h.max_episodes ?? 2,
      posting_schedule: "Thứ 3 và Thứ 6, 19:00",
      keywords: (seed.keywords ?? []).slice(0, 5),
      episode_ideas: [{ title: `${title} — tập mở màn`.slice(0, 150), angle: "Giới thiệu chủ đề bằng cảnh đẹp nhất" }],
      notes: h.notes || "",
    },
  };
}

function branding() {
  const d = inputs.studio_rnd?.direction ?? {};
  const name = (seed.title ?? "Series").slice(0, 100);
  const tag = `#${name.replace(/[^\p{L}\p{N}_]+/gu, "").slice(0, 40) || "Series"}`;
  // branding-bad-once: the first answer has unreadable thumbnail colours (text = outline)
  const bad = modes.has("branding-bad-once") && !repairing;
  return {
    schema_version: "studio.branding/v1",
    series_name: name,
    tagline: (d.positioning ?? "").slice(0, 200),
    positioning: d.positioning || `${name}: chân thật`,
    voice: { personality: ["ấm áp", "gần gũi"], do: ["Kể như đang nói với bạn"], dont: ["Giật tít sai sự thật"], signature_phrases: ["Đi cùng mình nhé"], banned_words: ["sốc"] },
    titles: { formulas: ["[Chủ đề] — [điều bất ngờ]"], rules: ["Từ khoá chính ở đầu"], examples: [`${name} — tập mở màn`.slice(0, 60)], max_chars: 70 },
    description: { opening: (d.description ?? "").slice(0, 500), cta: "Theo dõi kênh để xem tập tiếp theo", hashtags: [tag] },
    thumbnail: {
      concept: "Cận cảnh chủ thể chính, chữ lớn tương phản", text_rules: ["2–4 chữ"], max_words: 4, text_case: "upper",
      palette: { text: "#FFFFFF", outline: bad ? "#FFFFFF" : "#000000", accent: "#E63946" }, position: "bottom", emotion: "tò mò",
      do: ["Chữ to"], dont: ["Chữ nhỏ"],
    },
    on_screen_text: { style: "Chữ trắng viền đen", max_chars: 40, rules: ["Tối đa 2 dòng"],
      look: { text_color: "#FFFFFF", outline_color: "#000000", box_color: "#1D3557", size: "m" } },
    music_mood: ["ấm áp"],
  };
}

// ---------------------------------------------------------------------------
// Chat (spec local-chat §3.1): a prompt with `# Góp ý` answers {reply, action, proposal}. Deterministic from the
// last message: "?" → answer; "ok"/"duyệt"/"được" → suggest_approve; anything else → revise with a visible change.
//   chat-bad-once     the first answer of a turn proposes something the check refuses, valid on repair
//   chat-bad-always   every answer proposes something the check refuses
// ---------------------------------------------------------------------------

function chatCurrent() {
  const m = /\n# Bản hiện tại\n```json\n([\s\S]*?)\n```/.exec(stdin);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch { return null; }
}

function lastUserMessage() {
  const section = stdin.split("\n# Góp ý\n")[1]?.split("\n# Đầu ra")[0] ?? "";
  return [...section.matchAll(/^- Người dùng: (.*)$/gm)].at(-1)?.[1] ?? "";
}

function reviseDoc(doc) {
  const d = structuredClone(doc);
  const mark = (s, room) => `${String(s).slice(0, room)} (đã sửa)`;
  if (d.schema_version === "studio.edit-plan/v1" && d.texts?.[0]) d.texts[0].text = mark(d.texts[0].text, 40);
  else if (Array.isArray(d.titles)) d.titles[0] = mark(d.titles[0], 40);
  else if (Array.isArray(d.episodes) && d.episodes[0]) d.episodes[0].title = mark(d.episodes[0].title, 40);
  else if (typeof d.series_name === "string") d.series_name = mark(d.series_name, 30);
  else if (typeof d.summary === "string") d.summary = mark(d.summary, 200);
  return d;
}

function intakeDraft(current, msg, bad) {
  const d = current ?? {
    schema_version: "studio.intake-draft/v1", title: null, folder_ids: [], channels: [], keywords: [], aspect: null, language: null,
    hints: { description: "", goal: "", audience: "", tone: "", notes: "", episode_target_seconds: null, max_episodes: null }, questions: [],
  };
  let firstFolder = null;
  for (const m of msg.matchAll(/@\[([^\]]+)\]\(folder:([^)]+)\)/g)) {
    firstFolder ??= m[1];
    if (!d.folder_ids.includes(m[2])) d.folder_ids.push(m[2]);
  }
  for (const m of msg.replace(/@\[[^\]]+\]\([^)]+\)/g, "").matchAll(/(?:^|\s)(@[A-Za-z0-9_.-]+)/g)) {
    if (!d.channels.some((c) => c.url === m[1])) d.channels.push({ url: m[1], role: "reference" });
  }
  const low = msg.toLowerCase();
  if (/ngang|16:9/.test(low)) d.aspect = "16:9";
  if (/dọc|9:16/.test(low)) d.aspect = "9:16";
  d.title ??= firstFolder ? `Series ${firstFolder}` : null;
  d.language ??= "vi";
  // links pasted for a voice sample / background music: whichever word comes before each link
  for (const m of msg.matchAll(/(giọng|nhạc)[^h]*?(https?:\/\/\S+)/gi)) {
    d.audio_links ??= { voice: null, music: null };
    d.audio_links[m[1].toLowerCase() === "giọng" ? "voice" : "music"] = m[2];
  }
  if (bad) d.folder_ids = ["folder-khong-co"];
  d.questions = [];
  if (!d.title) d.questions.push({ field: "title", question: "Series tên là gì?", options: [] });
  if (!d.folder_ids.length) d.questions.push({ field: "folder_ids", question: "Dùng footage ở folder nào? Gắn bằng @.", options: [] });
  if (!d.aspect) d.questions.push({ field: "aspect", question: "Video ngang hay dọc?", options: ["Ngang 16:9", "Dọc 9:16"] });
  if (!d.channels.length && !d.keywords.length) d.questions.push({ field: "research", question: "Kênh nào để tham khảo?", options: [] });
  return d;
}

function timelineOps(msg, bad) {
  if (bad) return { ops: [{ op: "addClip", asset_id: "asset-khong-co", index: 0 }] };
  const low = msg.toLowerCase();
  const timeline = inputs.Timeline ?? {};
  const ops = [];
  if (/nhạc nhỏ/.test(low) && timeline.music) ops.push({ op: "setMusic", music: { ...timeline.music, gain_db: Math.max(-40, timeline.music.gain_db - 4) } });
  // shot-cut edits (timeline v4): shorten the first clip to 1.5 s, dissolve out of it, karaoke captions
  const firstClip = timeline.clips?.[0];
  if (/ngắn lại/.test(low) && firstClip) ops.push({ op: "trimClip", clip_id: firstClip.clip_id, in: firstClip.in ?? 0, out: Math.round(((firstClip.in ?? 0) + 1.5) * 1000) / 1000 });
  if (/mờ dần/.test(low) && firstClip) ops.push({ op: "setTransition", clip_id: firstClip.clip_id, kind: "dissolve", seconds: 0.5 });
  if (/karaoke/.test(low)) ops.push({ op: "setCaptions", mode: "karaoke" });
  // cut 1.1.0: "tắt tiếng clip 2" mutes the second clip's own sound
  const mute = /tắt tiếng clip (d+)/.exec(low);
  const muteClip = mute ? timeline.clips?.[Number(mute[1]) - 1] : undefined;
  if (muteClip) ops.push({ op: "setClipMuted", clip_id: muteClip.clip_id, muted: true });
  const quoted = /"([^"]{1,64})"/.exec(msg)?.[1];
  if (quoted || /chữ/.test(low) || !ops.length) {
    const clip = timeline.clips?.[1] ?? timeline.clips?.[0];
    ops.push({ op: "addText", kind: "lower_third", text: quoted ?? "Chữ mới", start: clip ? clip.start + 1 : 1, duration: 4, position: "bottom_left" });
  }
  return { ops };
}

/**
 * Scene selection: "giữ lại <shot>" keeps it (the first rejected shot when none is named), "bỏ <shot>" rejects it (the
 * first usable one when none is named). Resumed from the stage session, the note says it looked again.
 */
function surveyOps(msg, bad) {
  if (bad) return { ops: [{ op: "keep", shot_id: "s999-999", note: null }] };
  const survey = chatCurrent() ?? { shots: [] };
  const named = /s\d{3}-\d{3}/.exec(msg)?.[0];
  const seen = resumed && existsSync(join(cwd, "logs", `fake-session-${resumed}.json`));
  if (/(^|\s)bỏ(\s|$)/i.test(msg)) {
    const id = named ?? survey.shots.find((r) => r.usable)?.shot_id;
    return { ops: [{ op: "reject", shot_id: id, reason: msg.slice(0, 300) }] };
  }
  const id = named ?? survey.shots.find((r) => !r.usable)?.shot_id ?? survey.shots[0]?.shot_id;
  return { ops: [{ op: "keep", shot_id: id, note: seen ? "giữ lại · đã xem lại, rung nhẹ" : "giữ lại · rung nhẹ" }] };
}

/** Edit plan: "câu L002 ngắn lại" shortens that narration line (first half of its words); anything else, the title. */
function editPlanRevise(current, msg) {
  const named = /L\d{3}/.exec(msg)?.[0];
  const line = named && current.lines?.find((l) => l.line_id === named);
  if (!line || !/ngắn/i.test(msg)) return reviseDoc(current);
  const d = structuredClone(current);
  const words = line.text.split(/\s+/);
  d.lines.find((l) => l.line_id === named).text = `${words.slice(0, Math.max(1, Math.ceil(words.length / 2))).join(" ").replace(/[.,]$/, "")}.`;
  return d;
}

function chat() {
  const msg = lastUserMessage();
  const low = msg.toLowerCase();
  const bad = modes.has("chat-bad-always") || (modes.has("chat-bad-once") && !repairing);
  if (msg.includes("?")) return { reply: `Trả lời: ${msg.slice(0, 80)}`, action: "answer", proposal: null };
  if (/(^|\s)(ok|duyệt|được)(\s|$|[.!])/.test(low)) return { reply: "Bấm Duyệt để chuyển sang bước sau.", action: "suggest_approve", proposal: null };
  if (skill === "studio-intake") {
    const d = intakeDraft(chatCurrent(), msg, bad);
    return { reply: d.questions[0]?.question ?? "Đã đủ thông tin, bấm Bắt đầu.", action: d.questions.length ? "revise" : "suggest_approve", proposal: d };
  }
  if (skill === "studio-timeline") return { reply: `Đã sửa timeline theo góp ý: ${msg.slice(0, 60)}`, action: "revise", proposal: timelineOps(msg, bad) };
  if (skill === "studio-edit-plan" && !bad) {
    return { reply: `Đã sửa kế hoạch dựng theo góp ý: ${msg.slice(0, 60)}`, action: "revise", proposal: editPlanRevise(chatCurrent() ?? {}, msg) };
  }
  if (skill === "studio-survey") return { reply: `Đã sửa bản chọn cảnh theo góp ý: ${msg.slice(0, 60)}`, action: "revise", proposal: surveyOps(msg, bad) };
  const current = chatCurrent();
  return { reply: `Đã sửa theo góp ý: ${msg.slice(0, 60)}`, action: "revise", proposal: bad ? { schema_version: "broken" } : reviseDoc(current ?? {}) };
}

// ---------------------------------------------------------------------------
// Shot-cut skills (phase 5). The scene selection runs in files mode: it writes output/survey.json itself and answers
// with a session id; "--resume <id>" stands in for Claude remembering what it saw (the inputs it was given are kept
// in logs/fake-session-<id>.json of the workspace).
// ---------------------------------------------------------------------------

const resumeIdx = process.argv.indexOf("--resume");
const resumed = resumeIdx > 0 ? process.argv[resumeIdx + 1] : null;
function sessionInputs() {
  if (!resumed) return inputs;
  const p = join(cwd, "logs", `fake-session-${resumed}.json`);
  return existsSync(p) ? { ...JSON.parse(readFileSync(p, "utf8")), ...inputs } : inputs;
}
function newSession(kept) {
  const id = resumed ? `${resumed}-r` : `fake-sess-${n}`;
  writeFileSync(join(cwd, "logs", `fake-session-${id}.json`), JSON.stringify(kept));
  return id;
}

/** Every shot usable (score 4) but the first, which is too shaky, unless FAKE_STUDIO_MODE has "survey-keep-all". */
function sourceSurvey(kept) {
  const repairingFile = stdin.includes("bị hệ thống kiểm tra từ chối");
  const shots = (kept.shots?.sources ?? []).flatMap((src) => (src.shots ?? []).map((x) => ({ src, x })));
  const rows = shots.map(({ src, x }, i) => {
    const reject = i === 0 && !modes.has("survey-keep-all") && shots.length > 1;
    return {
      source_id: src.source_id, shot_id: x.shot_id, in: x.in, out: x.out, score: reject ? 1 : 4, tags: reject ? ["rung"] : ["phố"],
      usable: !reject, note: reject ? "Loại: rung mạnh" : `Cảnh ${x.shot_id} dùng được`, speech: src.has_audio ? "ambient" : "none",
    };
  });
  // "survey-bad-once": the first answer forgets the last shot; the repair (resumed session) adds it back
  if (modes.has("survey-bad-once") && !repairingFile) rows.pop();
  return { schema_version: "harness.survey-index/v2", shots: rows };
}

/**
 * Usable shots in order, pieces from each shot's start until the target is reached (up to 4 s; with a style, the middle
 * of its shot length); a line every 3 shots.
 */
function editPlan() {
  const survey = inputs.survey_index ?? { shots: [] };
  const range = inputs.studio_style?.skipped === false ? inputs.studio_style.params?.shot_seconds : null;
  const longest = range && !(modes.has("edit-plan-ignore-style-once") && !repairing) ? (range.min + range.max) / 2 : 4;
  const sources = inputs.cut_sources ?? { narration: "tts", language: "vi", episode_id: "e" };
  const episode = inputs.studio_episode ?? {};
  const target = episode.target_seconds ?? 60;
  const narration = sources.narration ?? "tts";
  const usable = (survey.shots ?? []).filter((r) => r.usable);
  const shots = [];
  let total = 0;
  for (const r of usable) {
    if (total >= target) break;
    const length = Math.min(longest, Math.max(0.5, r.out - r.in - 0.5));
    const order = shots.length + 1;
    shots.push({
      order, shot_id: r.shot_id, source_id: r.source_id, in: r.in, out: Math.round((r.in + length) * 1000) / 1000,
      line_id: narration === "tts" && order % 3 === 1 ? `L${String(Math.floor(order / 3) + 1).padStart(3, "0")}` : null,
      transition: r.out - r.in - length >= 0.5 && order % 2 === 1 ? "dissolve" : "cut", section_title: null, note: r.note.slice(0, 100),
    });
    total += length;
  }
  const lines = shots.filter((x) => x.line_id).map((x) => ({ line_id: x.line_id, text: `Câu dẫn ${x.line_id} về cảnh này.` }));
  if (modes.has("edit-plan-bad-once") && !repairing && shots[0]) shots[0].in = -1;
  return {
    schema_version: "studio.edit-plan/v1", episode_id: sources.episode_id ?? episode.episode_id ?? "e", narration, language: sources.language ?? "vi",
    target_seconds: target, shots, lines,
    texts: shots.length ? [{ text_id: "T001", kind: "title", text: (episode.title ?? "Tập").slice(0, 64), at_order: 1, offset_s: 0.3, duration: 3, position: "top_left" }] : [],
    music_mood: "calm",
  };
}

// ---------------------------------------------------------------------------
// Series plan 3.2.0: the web research (web mode) answers each gap with two video links (fake ids); a channel gets its
// page back. "web-research-bad-once": the first answer has a link that is not YouTube, the repair fixes it.
// ---------------------------------------------------------------------------
function webResearch() {
  const gaps = inputs.research_gaps ?? { channels: [], keywords: [] };
  const vid = (prefix, i) => ({ url: `https://www.youtube.com/watch?v=${`${prefix}${i}`.replace(/[^\w-]/g, "").padEnd(11, "x").slice(0, 11)}`, title: `${prefix} ${i}`, views: null, duration_s: null, published_at: null });
  const bad = modes.has("web-research-bad-once") && !repairing;
  return {
    schema_version: "studio.web-finds/v1", skipped: false,
    channels: gaps.channels.map((c, k) => ({
      input: c.input, channel_url: c.input.startsWith("@") ? `https://www.youtube.com/${c.input}` : null, title: `Kênh ${c.input}`,
      videos: bad && k === 0 ? [{ ...vid("ch", 1), url: "https://example.com/video.mp4" }] : [vid(`ch${k}v`, 1), vid(`ch${k}v`, 2)],
      notes: "Kênh chính chủ (giả)",
    })),
    keywords: gaps.keywords.map((keyword, k) => ({ keyword, videos: [vid(`kw${k}v`, 1), vid(`kw${k}v`, 2)] })),
    sources: ["https://www.youtube.com/results"],
  };
}

// Series plan 3.2.0: the style step runs in files mode — it reads style_watch/watch.json (the directory named in the
// prompt, remembered by the session for the repair round) and writes output/style.json. "style-bad-once": the first
// answer misquotes the measured median, the repair copies it right.
function styleFromWatch(kept) {
  const watch = JSON.parse(readFileSync(join(cwd, kept.watchDir, "watch.json"), "utf8"));
  const picks = kept.refs?.picks ?? [];
  const watched = (watch.videos ?? []).filter((v) => !v.error);
  const m = watch.measured;
  const measured = modes.has("style-bad-once") && !stdin.includes("bị hệ thống kiểm tra từ chối") ? { ...m, shot_seconds: { ...m.shot_seconds, median: m.shot_seconds.median + 3 } } : m;
  const med = m.shot_seconds.median;
  const frames = watched.flatMap((v) => v.frames.map((f) => ({ video_id: v.video_id, t: f.t })));
  return {
    schema_version: "studio.style/v1", skipped: false, skipped_reason: null, name: "Phong cách giả", summary: `Cảnh trung bình ${med} giây.`,
    references: watched.map((v) => {
      const p = picks.find((x) => x.video_id === v.video_id) ?? {};
      return { video_id: v.video_id, title: p.title ?? v.title, channel_title: p.channel_title ?? "", url: p.url ?? `https://www.youtube.com/watch?v=${v.video_id}`, duration_s: p.duration_s ?? v.duration_s ?? 0 };
    }),
    measured,
    params: {
      cut_rhythm: med < 2.5 ? "fast" : med > 5 ? "slow" : "medium",
      shot_seconds: { min: Math.max(0.5, Math.min(m.shot_seconds.p25, med)), max: Math.max(m.shot_seconds.p75, med, 0.5) },
      transitions: ["cut"], opening: { seconds: Math.min(60, Math.round(m.first_shot_s * 4)), structure: "montage ngắn" },
      text_overlay: { density: "low", style: "chữ nhỏ góc dưới" }, subtitles: "none", voice: "unknown", music: { mood: "", ducking: null },
      visual: "khung rộng", pace_notes: "",
    },
    do: ["Mở bằng montage ngắn"], dont: [],
    evidence: frames.slice(0, 3).map((f, i) => ({ param: ["opening", "text_overlay", "visual"][i], video_id: f.video_id, t: f.t, note: "khung giả" })),
  };
}

if (skill === "studio-style" && !stdin.includes("\n# Góp ý\n")) {
  const dir = (/^- style_watch: (.+?)\/?$/m.exec(stdin) ?? [])[1];
  const kept = resumed ? JSON.parse(readFileSync(join(cwd, "logs", `fake-session-${resumed}.json`), "utf8")) : { watchDir: dir, refs: inputs.style_refs };
  mkdirSync(join(cwd, "output"), { recursive: true });
  writeFileSync(join(cwd, "output", "style.json"), JSON.stringify(styleFromWatch(kept), null, 2));
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Đã ghi output/style.json", session_id: newSession(kept), total_cost_usd: 0, num_turns: 4 }) + "\n");
  process.exit(0);
}

if (skill === "studio-source-survey" && !stdin.includes("\n# Góp ý\n")) {
  const kept = sessionInputs();
  mkdirSync(join(cwd, "output"), { recursive: true });
  writeFileSync(join(cwd, "output", "survey.json"), JSON.stringify(sourceSurvey(kept), null, 2));
  process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Đã ghi output/survey.json", session_id: newSession(kept), total_cost_usd: 0, num_turns: 3 }) + "\n");
  process.exit(0);
}

let out;
if (stdin.includes("\n# Góp ý\n")) out = chat();
else if (skill === "studio-edit-plan") out = editPlan();
else if (skill === "studio-trend-report") out = trendReport();
else if (skill === "studio-rnd") out = rnd();
else if (skill === "studio-branding") out = branding();
else if (skill === "studio-plan-episodes") out = planEpisodes();
else if (skill === "studio-youtube-kit") out = youtubeKit();
else if (skill === "studio-web-research") out = webResearch();
else { process.stderr.write(`fake-studio-claude: unknown skill ${skill}\n`); process.exit(3); }

// a resumed (forked) session answers with a new session id of its own, like the real CLI
const sessionId = resumed ? { session_id: `${resumed}-chat-${n}` } : {};
process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: out, ...sessionId, total_cost_usd: 0, num_turns: 1 }) + "\n");
