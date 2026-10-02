/**
 * The Canva PDF of a thumbnail: one page the thumbnail's size, the picture behind, each line of words as a real text
 * object in the embedded bold font (filled and outlined, or on a band), placed where the JPEG has it.
 */
import { inflateSync } from "node:zlib";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFRawStream } from "pdf-lib";
import type { ThumbnailStyle } from "@harness/contracts";
import { thumbnailFontFile, thumbnailPdf } from "../src/canva-pdf.js";

/** Enough of a JPEG for a PDF to embed (SOI + a baseline SOF0 header): the PDF never decodes it. */
function jpegHeader(width: number, height: number): Buffer {
  const sof = Buffer.from([0xff, 0xc0, 0, 17, 8, height >> 8, height & 255, width >> 8, width & 255, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), sof, Buffer.from([0xff, 0xd9])]);
}

const font = thumbnailFontFile();
const style: ThumbnailStyle = { position: "bottom", size: "l", text_color: "#FFFF00", outline_color: "#000000", box_color: null, uppercase: true };

async function content(pdf: Buffer): Promise<{ doc: PDFDocument; ops: string }> {
  const doc = await PDFDocument.load(pdf);
  const contents = doc.getPage(0).node.Contents();
  const streams = contents && "asArray" in contents ? contents.asArray().map((r) => doc.context.lookup(r)) : [contents];
  const ops = streams.map((s) => {
    const raw = s as PDFRawStream;
    const bytes = Buffer.from(raw.contents);
    return raw.dict.toString().includes("FlateDecode") ? inflateSync(bytes).toString("latin1") : bytes.toString("latin1");
  }).join("\n");
  return { doc, ops };
}

describe.skipIf(!font)("thumbnail PDF for Canva", () => {
  it("draws each line as outlined text over the picture, on a page the thumbnail's size", async () => {
    const pdf = await thumbnailPdf({
      background: jpegHeader(1280, 720), width: 1280, height: 720, lines: ["PHỞ SÁNG", "HÀ NỘI"], style, font: readFileSync(font!), title: "Tập 1",
    });
    const { doc, ops } = await content(pdf);
    expect(doc.getPageCount()).toBe(1);
    expect(doc.getPage(0).getSize()).toEqual({ width: 1280, height: 720 });
    expect(doc.getTitle()).toBe("Tập 1");
    expect(ops.match(/ Tj/g)).toHaveLength(2);
    expect(ops).toContain("2 Tr");
    expect(ops).toContain("/Image");
    // the font is embedded (subset) with a ToUnicode map, so Canva reads the Vietnamese words back as text
    const objects = doc.context.enumerateIndirectObjects().map(([, o]) => (o instanceof PDFRawStream ? o.dict.toString() : o.toString())).join("\n");
    expect(objects).toContain("/FontFile2");
    expect(objects).toContain("/ToUnicode");
  });

  it("puts a band behind each line instead of an outline when the style has a box colour", async () => {
    const pdf = await thumbnailPdf({
      background: jpegHeader(720, 1280), width: 720, height: 1280, lines: ["MỘT"], style: { ...style, box_color: "#E63946", position: "top" },
      font: readFileSync(font!),
    });
    const { doc, ops } = await content(pdf);
    expect(doc.getPage(0).getSize()).toEqual({ width: 720, height: 1280 });
    expect(ops).toContain("0 Tr");
    expect(ops).toMatch(/0\.9\d* 0\.2\d* 0\.2\d* rg/);
  });
});
