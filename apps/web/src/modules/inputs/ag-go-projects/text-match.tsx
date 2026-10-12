import type { ReactNode } from "react";
import { Typography } from "antd";

/**
 * Text matching as ag-go's web does it (`shared/lib/text-match`): lowercase, no Vietnamese diacritics (đ → d),
 * whitespace collapsed, so "Hà Nội", "ha noi" and "HA  NOI" compare equal.
 */
export function normalizeSearchText(value: string): string {
  return value.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Folds one character the way `normalizeSearchText` does, keeping it one character long. */
function foldChar(char: string): string {
  const folded = char.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[đĐ]/g, "d").toLowerCase();
  return folded.length === 1 ? folded : char.toLowerCase();
}

/** Alphabetical order for Vietnamese names ("Ă" after "A", "Đ" after "D", "2" before "10"). */
export const compareText = new Intl.Collator("vi", { numeric: true, sensitivity: "base" }).compare;

/** The normalised words of a query. */
export const searchWords = (query: string): string[] => normalizeSearchText(query).split(" ").filter(Boolean);

/** Every word appears in text already normalised. */
export const matchesWords = (words: string[], normalizedText: string): boolean => words.every((w) => normalizedText.includes(w));

/** Every word of `query` appears in `text`, ignoring case and diacritics. */
export const matchesAllWords = (query: string, text: string): boolean => matchesWords(searchWords(query), normalizeSearchText(text));

/** The first diacritic-insensitive match of `search` in `text`, marked. */
export function highlightText(text: string, search: string): ReactNode {
  const query = normalizeSearchText(search);
  if (!query) return text;
  const chars = Array.from(text);
  const index = chars.map(foldChar).join("").indexOf(query);
  if (index === -1) return text;
  const length = Array.from(query).length;
  return (
    <span>
      {chars.slice(0, index).join("")}
      <Typography.Text mark style={{ fontWeight: 600 }}>{chars.slice(index, index + length).join("")}</Typography.Text>
      {chars.slice(index + length).join("")}
    </span>
  );
}

/** Thousands grouping of the UI language: 1.234 in Vietnamese, 1,234 in English. */
export const formatNumber = (value: number | null | undefined, lang: string): string =>
  Number(value ?? 0).toLocaleString(lang.startsWith("en") ? "en-US" : "vi-VN");

/** "15:00 25/09/2026" as ag-go writes dates; missing or invalid shows "-". */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "-";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())} ${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()}`;
}
