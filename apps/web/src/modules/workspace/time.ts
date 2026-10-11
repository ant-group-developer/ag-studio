/** "3 phút trước", "hôm qua", "2 thg 10": how long ago an ISO time was, in the person's language. */
export function relativeTime(iso: string, lang: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const seconds = Math.round((then - now) / 1000);
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const abs = Math.abs(seconds);
  if (abs < 45) return rtf.format(0, "second");
  if (abs < 45 * 60) return rtf.format(Math.round(seconds / 60), "minute");
  if (abs < 22 * 3600) return rtf.format(Math.round(seconds / 3600), "hour");
  if (abs < 6 * 86400) return rtf.format(Math.round(seconds / 86400), "day");
  return new Date(then).toLocaleDateString(lang, { day: "numeric", month: "short", year: new Date(then).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric" });
}

/** `1:05`, `12:30`, `1:02:03`: an elapsed or remaining time in seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return `${h > 0 ? `${h}:` : ""}${mm}:${String(sec).padStart(2, "0")}`;
}

/** `12 KB`, `3.4 MB`. */
export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
