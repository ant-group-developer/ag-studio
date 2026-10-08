/**
 * Text and subtitles burnt into a Studio render. Until teams have their own brand, every render uses one
 * default look set in Arial: the render worker takes Arial from the fonts installed on its machine (the
 * font's licence does not allow shipping the files in a repo or a bucket) and hands them to libass as
 * `fontsdir`.
 *
 * `buildAss` sizes everything in canvas pixels and the harness brand defaults were tuned on a 3840x2160
 * canvas, so the default brand scales them by the canvas' short edge: a 1080p or 9:16 render gets half.
 */
import { BrandProfileSchema, type BrandProfile, type Composition, type TextLook } from "@harness/contracts";
import { buildAss } from "../media/ass.js";

export const STUDIO_DEFAULT_FONT = "Arial";

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
      callout: { size_px: px(160) },
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
 */
export function studioOverlayAss(c: Composition): string | null {
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
  });
}
