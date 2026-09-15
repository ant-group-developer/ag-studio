#!/usr/bin/env node
// THU SỐ LIỆU STUDIO — READ-ONLY. Script này KHÔNG BAO GIỜ bấm hay gõ bất cứ gì trên trang: nó chỉ
// `goto` ba URL Analytics của một video (Overview / Reach / Engagement) theo id, đọc text hiển thị,
// và không tương tác gì khác. Nếu trang đòi đăng nhập lại (chuyển hướng về accounts.google.com, hoặc
// còn "Verify it's you") thì báo `blocked` và dừng ngay — đăng nhập lại là việc của CHỦ KÊNH, agent
// không bao giờ được gõ mật khẩu hay mã 2FA (xem `scripts/lookup.mjs`, cùng nguyên tắc).
//
// `playwright` không phải dependency của package adapter này; kênh (thư mục cha của --profile) đã cài
// sẵn, nên được resolve từ đó qua createRequire — giống hệt `scripts/lookup.mjs`.
//
// Usage: node collect-stats.mjs --profile <repo>/.upload-profile --video <video_id>
// In ra đúng MỘT dòng JSON rồi thoát:
//   { kind: "ok", views, impressions?, ctr_pct?, avg_view_sec? }   exit 0
//   { kind: "no-views" }                                          exit 0 (Studio tự khai chưa có lượt xem)
//   { kind: "blocked", reason }                                   exit 2 (tường đăng nhập lại)
//   { kind: "error", reason }                                     exit 3 (bất cứ lỗi nào khác)
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

function arg(flag) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

// ---- 3 hàm đọc số THUẦN — cùng quy tắc với packages/adapters/youtube-playwright/src/metrics-parse.ts
// (bản TypeScript, có test riêng). Chép lại ở đây dưới dạng JS thuần vì script này chạy độc lập, không
// import được TypeScript của package. ----
const COUNT_MULTIPLIER = { k: 1e3, m: 1e6, b: 1e9, n: 1e3, tr: 1e6, "tỷ": 1e9 };

function parseCount(s) {
  const t = String(s ?? "").replace(/[   ]/g, " ").trim();
  if (!t) return null;
  const m = /^([\d.,]+)\s*(K|M|B|N|Tr|Tỷ)?$/i.exec(t);
  if (!m) return null;
  const [, numPart, suffix] = m;
  const n = Number(suffix ? numPart.replace(",", ".") : numPart.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = COUNT_MULTIPLIER[String(suffix ?? "").toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

function parsePercent(s) {
  const t = String(s ?? "").replace(/[   ]/g, " ").trim();
  const m = /^([\d.,]+)\s*%$/.exec(t);
  if (!m) return null;
  const n = Number(m[1].replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function parseDuration(s) {
  const t = String(s ?? "").trim();
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(t)) return null;
  const p = t.split(":").map(Number);
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

// LẤY MỘT SỐ THEO NHÃN, so khớp THEO DÒNG (không phải regex trên cả trang) — Studio dựng mỗi ô chỉ số
// thành hai dòng kề nhau và chiều không cố định (nhãn trước hay số trước tuỳ tab), nên nhìn cả dòng
// trên lẫn dòng dưới của mỗi lần khớp nhãn. So khớp trên CẢ DÒNG (không phải regex chạy trên toàn
// trang) để "1:35" không bị một regex tham lam nuốt mất chữ số đầu vào một ô khác.
function pickMetric(pageText, labels, valueRe) {
  if (typeof pageText !== "string") return null;
  const lines = pageText.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const whole = new RegExp(`^(?:${valueRe.source})$`, "i");
  for (const label of labels) {
    const want = label.toLowerCase();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase() !== want) continue;
      for (const j of [i + 1, i - 1]) {
        const v = lines[j];
        if (v && whole.test(v)) return v;
      }
    }
  }
  return null;
}

// Cắt bỏ mọi thứ từ thẻ "Realtime"/"Thời gian thực" trở đi: trang Overview có HAI chỗ mang nhãn
// "Views" (ô chỉ số chính, và thẻ Realtime bên cạnh đo một cửa sổ 48h khác hẳn) — không cắt thì
// `pickMetric` có thể vơ nhầm số của thẻ Realtime.
function sliceBeforeRealtime(text) {
  if (typeof text !== "string") return "";
  const lines = text.split(/\r?\n/);
  const i = lines.findIndex((l) => /^(realtime|thời gian thực)$/i.test(l.trim()));
  return i < 0 ? text : lines.slice(0, i).join("\n");
}

// Studio nói thẳng bằng một câu khi video chưa có lượt xem nào — nguồn chắc chắn hơn ô chỉ số (ô đó
// hiện gạch ngang khi không có dữ liệu, không phải khi bằng 0).
function saysNoViews(text) {
  return /hasn.?t gotten any views|chưa có lượt xem/i.test(String(text ?? ""));
}

// Tường đăng nhập lại của Google ("Verify it's you" / "sign in again") không bao giờ vẽ ra bất kỳ nhãn
// nào script này tìm, nên mọi tab kiểm cùng một điều kiện trước khi đọc tiếp.
function isLoginWall(url, text) {
  const hay = `${url}\n${text || ""}`;
  return /accounts\.google\.com|Verify it.s you|sign in again|Xác minh danh tính|Đăng nhập lại/i.test(hay);
}

const RE_COUNT = /[\d][\d.,]*\s*(?:K|M|B|N|Tr|Tỷ)?/;
const RE_PCT = /[\d][\d.,]*\s*%/;
const RE_DUR = /\d+:\d{2}(?::\d{2})?/;

const VIEWS_LABELS = ["Views", "Lượt xem"];
const REACH_IMPRESSIONS_LABELS = ["Thumbnail impressions", "Impressions", "Số lần hiển thị theo hình thu nhỏ", "Số lần hiển thị"];
const REACH_CTR_LABELS = ["Thumbnail click-through rate", "Impressions click-through rate", "Tỷ lệ nhấp"];
const AVG_VIEW_LABELS = ["Average view duration", "Thời lượng xem trung bình"];

function ok(fields) {
  console.log(JSON.stringify({ kind: "ok", ...fields }));
  process.exit(0);
}
function noViews() {
  console.log(JSON.stringify({ kind: "no-views" }));
  process.exit(0);
}
function blocked(reason) {
  console.log(JSON.stringify({ kind: "blocked", reason }));
  process.exit(2);
}
function fail(reason) {
  console.log(JSON.stringify({ kind: "error", reason }));
  process.exit(3);
}

async function readTab(page, url) {
  await page.goto(url, { waitUntil: "domcontentloaded" });
  const text = await page.evaluate(() => document.body.innerText);
  if (isLoginWall(page.url(), text)) return { text: null, loginWall: true };
  return { text: sliceBeforeRealtime(text), loginWall: false };
}

async function main() {
  const profile = arg("--profile");
  const video = arg("--video");
  if (!profile || !video) return fail("missing required --profile/--video");

  const repoDir = dirname(profile); // profile is "<repo>/.upload-profile"
  let chromium;
  try {
    const require = createRequire(join(repoDir, "package.json"));
    ({ chromium } = require("playwright"));
  } catch {
    return fail(`playwright not installed in ${repoDir}`);
  }

  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { headless: true });
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(60000);

    // ---- tab-overview: Views, and the definitive "no views yet" sentence ----
    const overview = await readTab(page, `https://studio.youtube.com/video/${video}/analytics/tab-overview/period-since_publish`);
    if (overview.loginWall) return blocked("Studio yêu cầu đăng nhập lại (Verify it's you)");
    if (saysNoViews(overview.text)) return noViews();
    const views = parseCount(pickMetric(overview.text, VIEWS_LABELS, RE_COUNT));
    if (views === null) return fail("không đọc được Views trên tab overview");

    // ---- tab-reach: impressions + CTR (không có ở tab overview) ----
    const reach = await readTab(page, `https://studio.youtube.com/video/${video}/analytics/tab-reach/period-since_publish`);
    if (reach.loginWall) return blocked("Studio yêu cầu đăng nhập lại (Verify it's you)");
    const impressions = parseCount(pickMetric(reach.text, REACH_IMPRESSIONS_LABELS, RE_COUNT));
    const ctr_pct = parsePercent(pickMetric(reach.text, REACH_CTR_LABELS, RE_PCT));

    // ---- tab-engagement: thời lượng xem trung bình (không có ở tab overview) ----
    const engagement = await readTab(page, `https://studio.youtube.com/video/${video}/analytics/tab-engagement/period-since_publish`);
    if (engagement.loginWall) return blocked("Studio yêu cầu đăng nhập lại (Verify it's you)");
    const avg_view_sec = parseDuration(pickMetric(engagement.text, AVG_VIEW_LABELS, RE_DUR));

    return ok({
      views,
      ...(impressions !== null ? { impressions } : {}),
      ...(ctr_pct !== null ? { ctr_pct } : {}),
      ...(avg_view_sec !== null ? { avg_view_sec } : {}),
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e));
  } finally {
    if (context) await context.close().catch(() => {});
  }
}

main();
