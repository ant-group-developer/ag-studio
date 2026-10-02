/**
 * A thumbnail as a one-page PDF for Canva's design import: the clean picture as the background and the words as
 * real text (the bold thumbnail font embedded), placed where the JPEG has them, so they stay editable in Canva.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as fontkitNs from "@pdf-lib/fontkit";
import {
  beginText, endText, LineJoinStyle, PDFDocument, popGraphicsState, pushGraphicsState, rgb, setFillingRgbColor, setFontAndSize,
  setLineJoin, setLineWidth, setStrokingRgbColor, setTextRenderingMode, showText, moveText, TextRenderingMode,
} from "pdf-lib";
import type { ThumbnailStyle } from "@harness/contracts";
import { thumbnailTextLayout } from "@harness/core";

// the UMD bundle comes in as `default` under Node's ESM loader, as named exports elsewhere
const fontkit = (fontkitNs as unknown as { default?: typeof fontkitNs }).default ?? fontkitNs;

let fontFile: string | null | undefined;

/**
 * The bold font the words are drawn with: Arial Bold in `STUDIO_FONTS_DIR` or the Windows fonts, else the file
 * fontconfig gives for Arial bold (Liberation Sans Bold in the image). Null when there is none.
 */
export function thumbnailFontFile(): string | null {
  if (fontFile !== undefined) return fontFile;
  const dirs = [process.env.STUDIO_FONTS_DIR, process.platform === "win32" ? "C:\\Windows\\Fonts" : undefined].filter((d): d is string => !!d);
  for (const dir of dirs) {
    const hit = existsSync(dir) ? readdirSync(dir).find((f) => /^arial\s*(bd|bold)\.ttf$/i.test(f)) : undefined;
    if (hit) return (fontFile = join(dir, hit));
  }
  const fc = spawnSync("fc-match", ["-f", "%{file}", "Arial:bold"], { encoding: "utf8", windowsHide: true });
  const path = fc.status === 0 ? fc.stdout.trim() : "";
  return (fontFile = path && /\.(ttf|otf)$/i.test(path) && existsSync(path) ? path : null);
}

function color(hex: string) {
  const n = parseInt(hex.slice(1), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/** The PDF (`width`×`height` points, one point per pixel of the thumbnail). */
export async function thumbnailPdf(p: {
  background: Buffer; width: number; height: number; lines: string[]; style: ThumbnailStyle; font: Buffer; title?: string;
}): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);
  if (p.title) pdf.setTitle(p.title);
  // fresh copies: pdf-lib reads the whole ArrayBuffer under a view, and a Node Buffer may sit at an offset in a pooled one
  const font = await pdf.embedFont(new Uint8Array(p.font), { subset: true });
  const page = pdf.addPage([p.width, p.height]);
  page.drawImage(await pdf.embedJpg(new Uint8Array(p.background)), { x: 0, y: 0, width: p.width, height: p.height });

  const layout = thumbnailTextLayout({ width: p.width, height: p.height, lines: p.lines, style: p.style, measure: (t, s) => font.widthOfTextAtSize(t, s) });
  const box = p.style.box_color;
  const outline = box ? 0 : Math.max(2, Math.round(layout.size * 0.1));
  const pad = Math.max(4, Math.round(layout.size * 0.2));
  const fill = color(p.style.text_color);
  const stroke = color(p.style.outline_color);
  const key = page.node.newFontDictionary(font.name, font.ref);
  for (const line of layout.lines) {
    if (box) {
      // the band libass draws behind each line (BorderStyle 3)
      const b = color(box);
      page.drawRectangle({
        x: line.x - pad, y: p.height - line.baseline - layout.size * 0.212 - pad,
        width: line.width + 2 * pad, height: layout.size * 1.117 + 2 * pad, color: rgb(b.r, b.g, b.b),
      });
    }
    // one text object per line, filled and outlined, so Canva keeps it as editable text
    page.pushOperators(
      pushGraphicsState(),
      setFillingRgbColor(fill.r, fill.g, fill.b),
      setStrokingRgbColor(stroke.r, stroke.g, stroke.b),
      setLineWidth(outline),
      setLineJoin(LineJoinStyle.Round),
      beginText(),
      setFontAndSize(key, layout.size),
      setTextRenderingMode(outline ? TextRenderingMode.FillAndOutline : TextRenderingMode.Fill),
      moveText(line.x, p.height - line.baseline),
      showText(font.encodeText(line.text)),
      endText(),
      popGraphicsState(),
    );
  }
  return Buffer.from(await pdf.save());
}
