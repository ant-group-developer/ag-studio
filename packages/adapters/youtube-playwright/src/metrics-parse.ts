// ĐỌC SỐ LIỆU YOUTUBE STUDIO — hàm THUẦN, chép từ `D:\<kênh>\scripts\lib\metrics-parse.mjs` (kho kênh
// cũ, chỉ đọc, không sửa) và TypeScript-hoá. Studio hiển thị "1.2K", "3,456", "1:23" (phút:giây),
// "5.4%" — đọc sai một chỗ là sổ số liệu nhiễm số rác mà không ai biết, nên các hàm ở đây có test vector
// riêng (`test/metrics-parse.test.ts`) thay vì được kiểm gián tiếp qua Studio thật.
//
// Mở rộng so với bản gốc: Studio bản tiếng Việt dùng dấu phẩy làm dấu thập phân khi có hậu tố quy mô
// ("1,2 N" = 1,2 nghìn = 1200) thay vì dấu phẩy ngăn nghìn như bản tiếng Anh ("1,234" = 1234). Có hậu
// tố (K/M/B/N/Tr/Tỷ) thì đọc dấu phẩy đầu tiên là thập phân; không có hậu tố thì đọc như bản gốc — dấu
// phẩy là ngăn nghìn, bỏ đi trước khi đọc số.
import type { StatsOutcome } from "@harness/contracts";

const COUNT_MULTIPLIER: Record<string, number> = {
  k: 1e3, m: 1e6, b: 1e9, // tiếng Anh
  n: 1e3, tr: 1e6, "tỷ": 1e9, // tiếng Việt: nghìn / triệu / tỷ
};

/** "1.2K" -> 1200 · "1,234" -> 1234 · "1,2 N" -> 1200 · "" / rác -> null (KHÔNG trả 0: 0 là một con số thật). */
export function parseCount(s: unknown): number | null {
  // Studio chèn dấu cách KHÔNG PHẢI U+0020 giữa số và hậu tố, tuỳ locale: U+00A0 (no-break), U+202F
  // (narrow no-break — bản en-US hay dùng), U+2009 (thin space).
  const t = String(s ?? "").replace(/[\u00A0\u202F\u2009]/g, " ").trim();
  if (!t) return null;
  const m = /^([\d.,]+)\s*(K|M|B|N|Tr|Tỷ)?$/i.exec(t);
  if (!m) return null;
  const [, numPart, suffix] = m;
  const n = Number(suffix ? numPart!.replace(",", ".") : numPart!.replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const mult = COUNT_MULTIPLIER[String(suffix ?? "").toLowerCase()] ?? 1;
  return Math.round(n * mult);
}

/** "5.4%" -> 5.4 · "5,3 %" -> 5.3 · "" -> null */
export function parsePercent(s: unknown): number | null {
  const t = String(s ?? "").replace(/[\u00A0\u202F\u2009]/g, " ").trim();
  const m = /^([\d.,]+)\s*%$/.exec(t);
  if (!m) return null;
  const n = Number(m[1]!.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

/** "1:23" -> 83 giây · "1:02:03" -> 3723 · "0:45" -> 45 · "45 giây" / rác -> null (chỉ nhận m:ss hoặc h:mm:ss). */
export function parseDuration(s: unknown): number | null {
  const t = String(s ?? "").trim();
  if (!/^\d{1,2}(:\d{2}){1,2}$/.test(t)) return null;
  const p = t.split(":").map(Number);
  return p.length === 3 ? p[0]! * 3600 + p[1]! * 60 + p[2]! : p[0]! * 60 + p[1]!;
}

function isNumberOrUndefined(v: unknown): v is number | undefined {
  return v === undefined || typeof v === "number";
}

/**
 * Parses one JSON line printed by `scripts/collect-stats.mjs` into a `StatsOutcome`. Validates the shape
 * itself (never trusts the child process blindly): `kind` must be one of `ok|no-views|blocked|error`, and
 * every numeric field on `ok` must actually be a number. Anything else — invalid JSON, an unrecognized
 * `kind`, a non-numeric field — comes back as `{ kind: "error", reason }` rather than throwing, mirroring
 * `PlaywrightPublisher`'s lookup-script JSON handling.
 */
export function parseStatsJson(raw: string): StatsOutcome {
  let parsed: unknown;
  try {
    const line = raw.trim().split(/\r?\n/).pop() ?? "";
    parsed = JSON.parse(line);
  } catch (e) {
    return { kind: "error", reason: `invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "error", reason: "stats output is not a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  if (obj.kind === "no-views") return { kind: "no-views" };

  if (obj.kind === "blocked") {
    if (typeof obj.reason !== "string") return { kind: "error", reason: "blocked result missing a string reason" };
    return { kind: "blocked", reason: obj.reason };
  }

  if (obj.kind === "error") {
    return { kind: "error", reason: typeof obj.reason === "string" ? obj.reason : "unspecified error" };
  }

  if (obj.kind === "ok") {
    if (typeof obj.views !== "number") return { kind: "error", reason: "ok result missing a numeric views" };
    if (!isNumberOrUndefined(obj.impressions)) return { kind: "error", reason: "ok result has a non-numeric impressions" };
    if (!isNumberOrUndefined(obj.ctr_pct)) return { kind: "error", reason: "ok result has a non-numeric ctr_pct" };
    if (!isNumberOrUndefined(obj.avg_view_sec)) return { kind: "error", reason: "ok result has a non-numeric avg_view_sec" };
    if (!isNumberOrUndefined(obj.retention30_pct)) return { kind: "error", reason: "ok result has a non-numeric retention30_pct" };
    if (obj.note !== undefined && typeof obj.note !== "string") return { kind: "error", reason: "ok result has a non-string note" };
    return {
      kind: "ok",
      views: obj.views,
      ...(obj.impressions !== undefined ? { impressions: obj.impressions as number } : {}),
      ...(obj.ctr_pct !== undefined ? { ctr_pct: obj.ctr_pct as number } : {}),
      ...(obj.avg_view_sec !== undefined ? { avg_view_sec: obj.avg_view_sec as number } : {}),
      ...(obj.retention30_pct !== undefined ? { retention30_pct: obj.retention30_pct as number } : {}),
      ...(obj.note !== undefined ? { note: obj.note as string } : {}),
    };
  }

  return { kind: "error", reason: `unrecognized stats kind: ${JSON.stringify(obj.kind)}` };
}
