/** `overlay.ass` builder: cues (plain or karaoke) plus branded text-event styling, as one ASS document
 * (sub-project 5B Task 3, spec §4.6). Pure: no I/O, no clock, no randomness -- rendering (`ass=...:fontsdir=...`)
 * happens in `media-render` (Task 7), which is also where the fontname-vs-family assumption below gets a real
 * check. */
import type { BrandProfile, CaptionCue, OverlayKind, SubtitleMode, TextAnimation, TextEvent, TextPosition } from "@harness/contracts";

export interface AssInput {
  brand: BrandProfile | null;
  mode: SubtitleMode;
  cues: CaptionCue[];
  text_events: TextEvent[];
  logo: { corner: "left" | "right"; height_px: number } | null;
}

const STYLES_FORMAT =
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding";
const EVENTS_FORMAT = "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text";

const KIND_STYLE_NAME: Record<OverlayKind, string> = { title: "Title", callout: "Callout", lower_third: "LowerThird" };

/**
 * Fontname libass will see for a brand font file: there is no way to read the family/PostScript name out of a
 * TTF without parsing it, so this is the file's basename without its extension, per the brief. `media-render`
 * (Task 7) passes `fontsdir=<brand fonts>` with fontconfig off, so libass resolves purely by name inside that
 * directory -- if a font file's internal family name ever differs from its filename, this needs revisiting
 * then, when it can be checked against a real render.
 */
function fontFamily(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(0, dot) : base;
}

/** `&HAABBGGRR`, AA = 255 - css alpha (css with no alpha channel means opaque, i.e. AA = "00"). */
function assColor(hex: string): string {
  const clean = hex.slice(1);
  const r = clean.slice(0, 2);
  const g = clean.slice(2, 4);
  const b = clean.slice(4, 6);
  const cssAlphaHex = clean.length === 8 ? clean.slice(6, 8) : "FF";
  const assAlpha = (255 - parseInt(cssAlphaHex, 16)).toString(16).padStart(2, "0");
  return `&H${assAlpha}${b}${g}${r}`.toUpperCase();
}

function escapeAss(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}").replace(/\n/g, "\\N");
}

/** Truncated (not rounded) `H:MM:SS.cc`. */
function formatAssTime(seconds: number): string {
  const totalCs = Math.trunc(Math.max(0, seconds) * 100);
  const cs = totalCs % 100;
  const totalSec = Math.trunc(totalCs / 100);
  const s = totalSec % 60;
  const totalMin = Math.trunc(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.trunc(totalMin / 60);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${h}:${pad(m)}:${pad(s)}.${pad(cs)}`;
}

function styleLine(s: {
  name: string;
  fontname: string;
  size: number;
  primary: string;
  secondary: string;
  outline: string;
  back: string;
  bold: boolean;
  borderStyle: 1 | 3;
  alignment: number;
  marginV: number;
}): string {
  const bold = s.bold ? -1 : 0;
  return `Style: ${s.name},${s.fontname},${s.size},${s.primary},${s.secondary},${s.outline},${s.back},${bold},0,0,0,100,100,0,0,${s.borderStyle},4,0,${s.alignment},0,0,${s.marginV},1`;
}

/** `\an<n>\pos(x,y)` anchor for a text-event `position`, from the brand's `safe_margin_px` (`m`). */
function positionTag(position: TextPosition, m: number): { an: number; x: number; y: number } {
  switch (position) {
    case "top_left":
      return { an: 7, x: m, y: m };
    case "top_center":
      return { an: 8, x: 1920, y: m };
    case "top_right":
      return { an: 9, x: 3840 - m, y: m };
    case "center":
      return { an: 5, x: 1920, y: 1080 };
    case "bottom_left":
      return { an: 1, x: m, y: 2160 - m };
    case "bottom_center":
      return { an: 2, x: 1920, y: 2160 - m };
    case "bottom_right":
      return { an: 3, x: 3840 - m, y: 2160 - m };
  }
}

function animationTag(animation: TextAnimation, x: number, y: number): string {
  switch (animation) {
    case "fade":
      return "\\fad(250,250)";
    case "slide_up":
      return `\\move(${x},${y + 60},${x},${y},0,250)\\fad(250,0)`;
    case "pop":
      return "\\fscx80\\fscy80\\t(0,250,\\fscx100\\fscy100)\\fad(120,120)";
    case "none":
      return "";
  }
}

/**
 * Karaoke text for one cue: `{\kf<cs>}<word>` per word (`cs` = `round(word duration * 100)`), with a
 * `{\kf<cs>}` filler for the gap before the cue's first word (when the cue starts before it) and for any gap
 * between two words, so the sum of every `\kf` value equals the cue's own duration in centiseconds. That
 * filler carries the SPACE separating the two words (see below). `\N` breaks land between the words
 * `cue.lines` puts on different lines -- `lines` is `words` re-wrapped at existing spaces, so each line's
 * word count is exactly its whitespace-token count.
 */
function karaokeText(cue: CaptionCue): string {
  const lineParts: string[] = [];
  let wordIdx = 0;
  for (const line of cue.lines) {
    const tokenCount = line.split(/\s+/).filter((t) => t.length > 0).length;
    const parts: string[] = [];
    for (let t = 0; t < tokenCount; t++) {
      const w = cue.words[wordIdx];
      if (!w) break;
      const prevEnd = wordIdx === 0 ? cue.start : cue.words[wordIdx - 1]!.end;
      const gapCs = Math.round((w.start - prevEnd) * 100);
      // The space between two words of the same line. libass draws exactly the characters inside the `\kf`
      // segments and nothing else, so a gap filler of `{\kf4}` with no content draws NOTHING: the first real
      // 4K render (Task 11) came out reading "Chợbênsôngmởtừlúc". The separator rides inside the gap segment
      // when there is one (so it wipes in with the silence) and is emitted bare when two words abut. No
      // separator after a `\N`, where the line break already does the job, and none before the first word.
      const sep = t > 0 ? " " : "";
      if (gapCs > 0) parts.push(`{\\kf${gapCs}}${sep}`);
      else if (sep !== "") parts.push(sep);
      parts.push(`{\\kf${Math.round((w.end - w.start) * 100)}}${escapeAss(w.word)}`);
      wordIdx++;
    }
    lineParts.push(parts.join(""));
  }
  const last = cue.words[cue.words.length - 1];
  if (last) {
    const trailingCs = Math.round((cue.end - last.end) * 100);
    if (trailingCs > 0 && lineParts.length > 0) lineParts[lineParts.length - 1] += `{\\kf${trailingCs}}`;
  }
  return lineParts.join("\\N");
}

function cueText(cue: CaptionCue, mode: SubtitleMode): string {
  if (mode === "karaoke" && cue.words.length > 0) return karaokeText(cue);
  return cue.lines.map(escapeAss).join("\\N");
}

function buildCueDialogue(cue: CaptionCue, mode: SubtitleMode, marginBase: number): string {
  const style = mode === "karaoke" ? "SubHi" : "Sub";
  const marginV = marginBase + cue.raise_px;
  return `Dialogue: 0,${formatAssTime(cue.start)},${formatAssTime(cue.end)},${style},,0,0,${marginV},,${cueText(cue, mode)}`;
}

function buildTextEventDialogue(ev: TextEvent, m: number): string {
  const { an, x, y } = positionTag(ev.position, m);
  const anim = animationTag(ev.animation, x, y);
  const override = `{\\an${an}\\pos(${x},${y})${anim}}`;
  return `Dialogue: 1,${formatAssTime(ev.start)},${formatAssTime(ev.end)},${KIND_STYLE_NAME[ev.kind]},,0,0,0,,${override}${escapeAss(ev.text)}`;
}

const NO_BRAND_STYLE = styleLine({
  name: "Sub",
  fontname: "Arial",
  size: 88,
  primary: "&H00FFFFFF",
  secondary: "&H00FFFFFF",
  outline: "&H00000000",
  back: "&H00000000",
  bold: false,
  borderStyle: 1,
  alignment: 2,
  marginV: 120,
});

export function buildAss(p: AssInput): string {
  const { brand, mode, cues, text_events } = p;

  const scriptInfo = ["[Script Info]", "ScriptType: v4.00+", "PlayResX: 3840", "PlayResY: 2160", "WrapStyle: 2", "ScaledBorderAndShadow: yes"];

  if (brand === null) {
    // Brief decision: brand null -> header + default style, zero Dialogue lines, regardless of `mode`.
    return [...scriptInfo, "", "[V4+ Styles]", STYLES_FORMAT, NO_BRAND_STYLE, "", "[Events]", EVENTS_FORMAT].join("\n") + "\n";
  }

  const m = brand.safe_margin_px;
  const regularFont = fontFamily(brand.fonts.regular);
  const boldFont = fontFamily(brand.fonts.bold);
  const primary = assColor(brand.colors.text);
  const outline = assColor(brand.colors.text_outline);
  const back = assColor(brand.colors.box);

  const subAlignment = brand.subtitles.position === "top_center" ? 8 : 2;
  const subStyle = styleLine({
    name: "Sub",
    fontname: regularFont,
    size: brand.subtitles.size_px,
    primary,
    secondary: primary,
    outline,
    back,
    bold: false,
    borderStyle: 1,
    alignment: subAlignment,
    marginV: m,
  });
  const subHiStyle = styleLine({
    name: "SubHi",
    fontname: regularFont,
    size: brand.subtitles.size_px,
    primary,
    secondary: assColor(brand.subtitles.highlight_color),
    outline,
    back,
    bold: false,
    borderStyle: 1,
    alignment: subAlignment,
    marginV: m,
  });

  const kindStyle = (kind: OverlayKind): string => {
    const cfg = brand.text[kind];
    const bold = kind === "title" || kind === "callout";
    return styleLine({
      name: KIND_STYLE_NAME[kind],
      fontname: bold ? boldFont : regularFont,
      size: cfg.size_px,
      primary,
      secondary: primary,
      outline,
      back,
      bold,
      borderStyle: cfg.box ? 3 : 1,
      alignment: positionTag(cfg.position, m).an,
      marginV: m,
    });
  };

  const eventLines: string[] = [];
  if (mode !== "none") for (const cue of cues) eventLines.push(buildCueDialogue(cue, mode, m));
  for (const ev of text_events) eventLines.push(buildTextEventDialogue(ev, m));

  return (
    [
      ...scriptInfo,
      "",
      "[V4+ Styles]",
      STYLES_FORMAT,
      subStyle,
      subHiStyle,
      kindStyle("title"),
      kindStyle("callout"),
      kindStyle("lower_third"),
      "",
      "[Events]",
      EVENTS_FORMAT,
      ...eventLines,
    ].join("\n") + "\n"
  );
}

export function countDialogues(ass: string): number {
  return ass.split("\n").filter((l) => l.startsWith("Dialogue:")).length;
}
