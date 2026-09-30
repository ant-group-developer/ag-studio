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
import { appendFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
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
    recommended_duration_s: brief.episode_target_seconds ?? 180,
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
  return {
    schema_version: "studio.youtube-kit/v1",
    titles: [
      `${title} — Khám Phá Đầy Đủ`,
      `Bí Mật Về ${title} Ít Ai Biết`,
      `Lần Đầu Trải Nghiệm ${title}`,
    ],
    description: `${episode.hook ?? title}\n\nTập này sẽ đưa bạn đến với ${title}. Theo dõi kênh để không bỏ lỡ tập tiếp theo!`,
    tags: ["du lịch", "Việt Nam", ...(brief.keywords ?? []).slice(0, 5), title.split(" ").slice(0, 3).join(" ")],
    hashtags: ["#ViệtNam", "#DuLịch", `#${title.replace(/\s+/g, "")}`],
    thumbnails: [
      { asset_id: firstAssetId, text: title.slice(0, 40) },
      { asset_id: midAssetId, text: "Khám Phá Ngay" },
      { asset_id: lastAssetId, text: "Không Thể Bỏ Lỡ" },
    ],
    playlist: brief.title ?? "Series",
  };
}

let out;
if (skill === "studio-trend-report") out = trendReport();
else if (skill === "studio-plan-episodes") out = planEpisodes();
else if (skill === "studio-youtube-kit") out = youtubeKit();
else { process.stderr.write(`fake-studio-claude: unknown skill ${skill}\n`); process.exit(3); }

process.stdout.write(JSON.stringify({ type: "result", subtype: "success", is_error: false, structured_output: out, total_cost_usd: 0, num_turns: 1 }) + "\n");
