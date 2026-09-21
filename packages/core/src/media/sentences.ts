/**
 * Pure sentence splitting for TTS chunking (sub-project 5A Task 5, spec §3.4): normalize whitespace, split on
 * sentence-ending punctuation (skipping decimals and known abbreviations), pack adjacent sentences up to
 * `maxChars`, and hard-split anything still too long. No I/O, no engine, no config beyond the three arguments.
 */

const BOUNDARY_CHARS = new Set([".", "!", "?", "…", ";", ":"]);

/** Case-sensitive, matched as the whole whitespace-delimited token immediately before the period. Looked up
 * by the language code's primary subtag (`en-US` -> `en`); any other language uses only the digit rule. */
const ABBREVIATIONS: Record<string, string[]> = {
  en: ["Mr", "Mrs", "Ms", "Dr", "Prof", "St", "vs", "etc", "e.g", "i.e", "U.S"],
  vi: ["TP", "Th.S", "TS", "PGS", "GS", "ThS", "Q", "P"],
};

function primarySubtag(language: string): string {
  return (language.split("-")[0] ?? language).toLowerCase();
}

/**
 * Splits already-whitespace-normalized text into raw sentences at `[.!?…;:]` followed by a space or the end
 * of the string. A candidate `.` is skipped when the token right before it (from the previous space, or the
 * start of the string) is a known abbreviation for `language`'s primary subtag -- since that token can itself
 * contain an internal `.` (`Th.S`, `e.g`), this is a whole-token match, not a single-character lookback. A
 * decimal point (`3.5`) is never a candidate in the first place: nothing follows it but the next digit, so it
 * never has the trailing space a candidate requires.
 */
function splitIntoSentences(normalized: string, language: string): string[] {
  const abbreviations = new Set(ABBREVIATIONS[primarySubtag(language)] ?? []);
  const sentences: string[] = [];
  let start = 0;

  for (let i = 0; i < normalized.length; i++) {
    const ch = normalized[i]!;
    if (!BOUNDARY_CHARS.has(ch)) continue;
    const atEnd = i + 1 === normalized.length;
    if (!atEnd && normalized[i + 1] !== " ") continue;

    if (ch === ".") {
      const tokenStart = normalized.lastIndexOf(" ", i - 1) + 1;
      const token = normalized.slice(tokenStart, i);
      if (abbreviations.has(token)) continue;
    }

    sentences.push(normalized.slice(start, i + 1));
    start = atEnd ? normalized.length : i + 2;
  }
  if (start < normalized.length) sentences.push(normalized.slice(start));
  return sentences;
}

/** Index of the `,` in `s` closest to its midpoint, or -1 when there is none. */
function commaNearMiddle(s: string): number {
  const mid = s.length / 2;
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== ",") continue;
    const d = Math.abs(i - mid);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/** Index of the ` ` in `s` closest to `target`, or -1 when there is none. */
function spaceNearTarget(s: string, target: number): number {
  let best = -1;
  let bestDist = Infinity;
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== " ") continue;
    const d = Math.abs(i - target);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

/**
 * Recursively cuts `s` (a single sentence, already too long for `maxChars`) into pieces each `<= maxChars`:
 * prefer the comma nearest the middle of the current piece (comma kept on the left half, the one separating
 * space dropped since rejoining with `" "` puts it back); failing that, the whitespace nearest `maxChars`;
 * failing that (one unbroken token longer than `maxChars`, no space or comma anywhere), a hard character cut
 * at exactly `maxChars` -- the one case where `chunks.join(" ")` does not exactly reproduce the input, since
 * it inserts a space the original text never had at that position.
 */
function chunkLong(s: string, maxChars: number): string[] {
  if (s.length <= maxChars) return s.length > 0 ? [s] : [];

  const commaIdx = commaNearMiddle(s);
  if (commaIdx > 0 && commaIdx < s.length - 1) {
    const left = s.slice(0, commaIdx + 1);
    const right = s.slice(commaIdx + 1).replace(/^ /, "");
    if (left.length > 0 && right.length > 0) return [...chunkLong(left, maxChars), ...chunkLong(right, maxChars)];
  }

  const spaceIdx = spaceNearTarget(s, maxChars);
  if (spaceIdx > 0 && spaceIdx < s.length - 1) {
    const left = s.slice(0, spaceIdx);
    const right = s.slice(spaceIdx + 1);
    if (left.length > 0 && right.length > 0) return [...chunkLong(left, maxChars), ...chunkLong(right, maxChars)];
  }

  return [s.slice(0, maxChars), ...chunkLong(s.slice(maxChars), maxChars)];
}

/**
 * 1) normalizes whitespace (collapses any run of whitespace, including newlines, to a single space, trims
 * the ends); an all-whitespace (or empty) input normalizes to `""` and returns `[]`.
 * 2) splits into sentences on `[.!?…;:]` followed by whitespace/end-of-string, skipping a decimal point or a
 * known abbreviation (see `splitIntoSentences`); any other language than `en`/`vi` only gets the (automatic)
 * decimal-point exception.
 * 3) greedily packs adjacent sentences together while their combined length stays `<= maxChars`.
 * 4) anything still over `maxChars` (a single original sentence longer than the limit) is cut further --
 * comma nearest the middle, then whitespace nearest `maxChars`, then a hard character cut (see `chunkLong`).
 *
 * Never returns an empty string in the result. `chunks.join(" ")` reproduces the whitespace-normalized input
 * exactly, except across a hard character cut, where `chunks.join(" ").replace(/ /g, "")` still equals
 * `normalized.replace(/ /g, "")` (the join adds a space the source never had at that one position).
 */
export function splitSentences(text: string, language: string, maxChars: number): string[] {
  const normalized = text.trim().replace(/\s+/g, " ");
  if (normalized === "") return [];

  const rawSentences = splitIntoSentences(normalized, language);

  const merged: string[] = [];
  for (const sentence of rawSentences) {
    const last = merged.length > 0 ? merged[merged.length - 1]! : undefined;
    if (last !== undefined && last.length + 1 + sentence.length <= maxChars) {
      merged[merged.length - 1] = `${last} ${sentence}`;
    } else {
      merged.push(sentence);
    }
  }

  const out: string[] = [];
  for (const chunk of merged) out.push(...chunkLong(chunk, maxChars));
  return out;
}
