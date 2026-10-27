/**
 * Text and subtitles burnt into a Studio render. Until teams have their own brand, every render uses one
 * default look set in Arial: the render worker takes Arial from the fonts installed on its machine (the
 * font's licence does not allow shipping the files in a repo or a bucket) and hands them to libass as
 * `fontsdir`.
 *
 * `buildAss` sizes everything in canvas pixels and the harness brand defaults were tuned on a 3840x2160
 * canvas, so the default brand scales them by the canvas' short edge: a 1080p or 9:16 render gets half. A callout is
 * drawn smaller than the harness's 160 px (`STUDIO_CALLOUT_PX`): at 80 px on 1080p it covered the picture.
 */
import { BrandProfileSchema, TEXT_FONT_INFO, type BrandProfile, type Composition, type TextFont, type TextLook, type TextScript } from "@harness/contracts";
import { buildAss } from "../media/ass.js";

export const STUDIO_DEFAULT_FONT = "Arial";

/** Hangul (syllables, jamo). */
const HANGUL = /[\u1100-\u11ff\u3130-\u318f\uac00-\ud7af]/;
/** Kana, CJK ideographs, CJK punctuation and full-width forms. */
const JAPANESE = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
/** Letters only Vietnamese uses: \u0103 \u00e2 \u0111 \u00ea \u00f4 \u01a1 \u01b0 and the stacked tone marks (Latin Extended Additional). */
const VIETNAMESE = /[\u0103\u00e2\u0111\u00ea\u00f4\u01a1\u01b0\u0102\u00c2\u0110\u00ca\u00d4\u01a0\u01af\u1ea0-\u1ef9]/;

/** The font that draws a script when the look's font has no glyphs for it. */
const SCRIPT_FALLBACK: Record<TextScript, TextFont> = { korean: "Noto Sans KR", japanese: "Noto Sans JP", vietnamese: "Be Vietnam Pro" };

/** The family name libass matches for a font: the name, unless the file calls itself otherwise (`TEXT_FONT_INFO.face`). */
export function studioFontFace(font: TextFont): string {
  return TEXT_FONT_INFO[font].face ?? font;
}

/**
 * The shipped font a text or subtitle is drawn in when its words are in a script the look's font lacks (Korean, Japanese,
 * Vietnamese: libass drew empty boxes), or null to keep the style's font. Korean wins over the CJK ranges it shares,
 * then Japanese, then Vietnamese.
 */
export function studioScriptFont(text: string, lookFont: TextFont = STUDIO_DEFAULT_FONT): TextFont | null {
  const need: TextScript | null = HANGUL.test(text) ? "korean" : JAPANESE.test(text) ? "japanese" : VIETNAMESE.test(text) ? "vietnamese" : null;
  if (need === null || TEXT_FONT_INFO[lookFont].scripts.includes(need)) return null;
  return SCRIPT_FALLBACK[need];
}

/** A callout's size on the design canvas (the harness default is 160 px). */
export const STUDIO_CALLOUT_PX = 104;

/** The canvas the harness brand defaults were designed for (short edge). */
const DESIGN_SHORT_EDGE = 2160;

export function studioDefaultBrand(canvas: { width: number; height: number }): BrandProfile {
  const k = Math.min(canvas.width, canvas.height) / DESIGN_SHORT_EDGE;
  // 24 px is the smallest size the brand schema accepts.
  const px = (n: number) => Math.max(24, Math.round(n * k));
  return BrandProfileSchema.parse({
    schema_version: "harness.brand/v1",
    channel_id: "studio-default",
    revision: 1,
    // libass matches the family name; the file name only feeds `buildAss`'s fontname ("Arial"). Bold
    // styles ask for Arial with the bold flag, which picks the bold face from the same fontsdir.
    fonts: {
      regular: `${STUDIO_DEFAULT_FONT}.ttf`,
      bold: `${STUDIO_DEFAULT_FONT}.ttf`,
      origin: "licensed",
      origin_note: "Arial cài sẵn trên máy render (Windows có sẵn; Linux cài ttf-mscorefonts-installer)",
    },
    colors: { primary: "#FFFFFF" },
    safe_margin_px: Math.round(120 * k),
    text: {
      title: { size_px: px(120) },
      callout: { size_px: px(STUDIO_CALLOUT_PX) },
      lower_third: { size_px: px(72) },
    },
    subtitles: { size_px: px(88) },
  });
}

/** Size steps of a team's text look, against the default look. */
const LOOK_SCALE = { s: 0.8, m: 1, l: 1.25 } as const;
/** The box behind titles and lower thirds lets some picture through, as the default look's does. */
const LOOK_BOX_ALPHA = "B3";

/**
 * The default look recoloured and resized by a team's text look (branding `on_screen_text.look`): text and outline
 * colours for texts and subtitles; with a box colour, titles and lower thirds sit on a box of it, else none does.
 */
export function studioLookBrand(canvas: { width: number; height: number }, look: TextLook): BrandProfile {
  const base = studioDefaultBrand(canvas);
  const k = LOOK_SCALE[look.size];
  const px = (n: number) => Math.max(24, Math.round(n * k));
  const boxed = look.box_color !== null;
  return BrandProfileSchema.parse({
    ...base,
    // `buildAss` names a font after its file's base name, so the family name libass matches stands in for the file
    ...(look.font ? { fonts: { ...base.fonts, regular: `${studioFontFace(look.font)}.ttf`, bold: `${studioFontFace(look.font)}.ttf`, origin: "licensed", origin_note: "font OFL đóng kèm ag-render-worker" } } : {}),
    colors: { primary: look.text_color, text: look.text_color, text_outline: look.outline_color, box: `${look.box_color ?? "#000000"}${LOOK_BOX_ALPHA}` },
    text: {
      title: { ...base.text.title, size_px: px(base.text.title.size_px), box: boxed },
      callout: { ...base.text.callout, size_px: px(base.text.callout.size_px), box: false },
      lower_third: { ...base.text.lower_third, size_px: px(base.text.lower_third.size_px), box: boxed },
    },
    subtitles: { ...base.subtitles, size_px: px(base.subtitles.size_px) },
  });
}

/**
 * The `overlay.ass` a Studio composition burns in, or `null` when it has no subtitle cue and no text. A composition
 * with a text look (cut 1.1.0) is drawn in it, its boxes in the box colour; one without, exactly as before.
 * `scriptFonts`: the render machine has the shipped fonts (`studioFontFamilies`), so Japanese and Korean words are
 * drawn in Noto Sans JP / KR.
 */
export function studioOverlayAss(c: Composition, o: { scriptFonts?: boolean } = {}): string | null {
  const cues = c.captions.mode === "none" ? [] : c.captions.cues;
  if (cues.length === 0 && c.text_events.length === 0) return null;
  const canvas = { width: c.output.width, height: c.output.height };
  return buildAss({
    brand: c.text_style ? studioLookBrand(canvas, c.text_style) : studioDefaultBrand(canvas),
    mode: c.captions.mode,
    cues,
    text_events: c.text_events,
    logo: null,
    canvas,
    ...(c.text_style ? { boxColorInOutline: true } : {}),
    ...(c.text_style?.shadow ? { shadow: true } : {}),
    ...(o.scriptFonts ? { scriptFont: (text: string) => {
      const f = studioScriptFont(text, c.text_style?.font);
      return f ? studioFontFace(f) : null;
    } } : {}),
  });
}

/**
 * The font families a composition's texts and subtitles are drawn in: the look's font (Arial when none) and the
 * script fonts its words need. The render worker hands libass exactly these (`fontsdir`).
 */
export function studioFontFamilies(c: Composition): TextFont[] {
  const look = c.text_style?.font ?? STUDIO_DEFAULT_FONT;
  const words = [...c.text_events.map((t) => t.text), ...(c.captions.mode === "none" ? [] : c.captions.cues.flatMap((q) => q.lines))];
  const script = words.map((w) => studioScriptFont(w, look)).filter((f): f is TextFont => f !== null);
  return [...new Set<TextFont>([look, ...script])];
}
