import assert from "node:assert/strict";
import test from "node:test";
import fontkit from "@pdf-lib/fontkit";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { NOTO_SANS_CZECH_BOLD_BASE64 } from "../lib/fonts/graphicsProductionFont.ts";
import { appendRawContentChunk } from "../lib/pdf/pdfPageContentAppend.ts";
import { createSimpleTrueTypeTextFont, glyphNameForCodePoint } from "../lib/pdf/pdfSimpleTrueTypeText.ts";

// =========================================================================================
// HOTFIX-02 (phase 5) — real, editable PDF text in a SIMPLE TrueType font (lib/pdf/pdfSimpleTrueTypeText.ts).
// =========================================================================================

const fontBytes = Uint8Array.from(atob(NOTO_SANS_CZECH_BOLD_BASE64), (char) => char.charCodeAt(0));
const BLACK = { red: 0, green: 0, blue: 0 };

async function textOf(bytes: Uint8Array): Promise<string[]> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(bytes) }).promise;
  const content = await (await doc.getPage(1)).getTextContent();
  return (content.items as { str: string }[]).map((item) => item.str);
}

async function draw(lines: readonly string[]) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([600, 800]);
  const font = createSimpleTrueTypeTextFont(doc, fontBytes, fontkit.create(fontBytes));
  lines.forEach((line, index) => appendRawContentChunk(doc.context, page, font.textOperators(page, 20, 760 - index * 14, line, 10, BLACK)));
  font.finalize();
  return { bytes: await doc.save(), font };
}

test("glyph names: Adobe standard names for Czech letters and ³, uniXXXX otherwise", () => {
  assert.deepEqual(["ě", "š", "č", "ř", "ž", "ý", "á", "í", "é", "ů", "ú", "ť", "ď", "ň", "Ř", "³", "–", "×"].map((char) => glyphNameForCodePoint(char.codePointAt(0)!)), [
    "ecaron", "scaron", "ccaron", "rcaron", "zcaron", "yacute", "aacute", "iacute", "eacute", "uring", "uacute", "tcaron", "dcaron", "ncaron", "Rcaron", "threesuperior", "endash", "multiply",
  ]);
  assert.equal(glyphNameForCodePoint(0x2192), "uni2192");
});

test("Czech text round-trips through a viewer exactly (ToUnicode + encoding), as ordinary text items", async () => {
  const lines = ["Přívod elektřiny ze stropu", "El.rozvaděč", "3 m³", "Napuš.Bazén", "ŽLUŤOUČKÝ KŮŇ ÚPĚL ĎÁBELSKÉ ÓDY"];
  const { bytes } = await draw(lines);
  assert.deepEqual(await textOf(bytes), lines);
});

test("structure: ONE embedded font program, simple /TrueType font dicts (never /Type0), widths for every used code", async () => {
  const { bytes } = await draw(["5 kW", "Vrch. Přívod"]);
  const doc = await PDFDocument.load(bytes);
  const fonts = (doc.getPage(0).node.lookup(PDFName.of("Resources")) as PDFDict).lookup(PDFName.of("Font")) as PDFDict;
  const font = fonts.lookup(fonts.keys()[0]!) as PDFDict;
  assert.equal(font.lookup(PDFName.of("Subtype"))?.toString(), "/TrueType");
  assert.equal(font.lookup(PDFName.of("FirstChar"))?.toString(), "32");
  const widths = font.lookup(PDFName.of("Widths")) as PDFArray;
  const lastChar = Number(font.lookup(PDFName.of("LastChar"))!.toString());
  assert.equal(widths.size(), lastChar - 32 + 1);
  const descriptor = font.lookup(PDFName.of("FontDescriptor")) as PDFDict;
  const fontFile = descriptor.lookup(PDFName.of("FontFile2")) as PDFRawStream;
  assert.equal(decodePDFRawStream(fontFile).decode().length, fontBytes.length, "the whole font program is embedded (not a subset) — any digit/letter stays editable");
});

test("more than 128 distinct non-ASCII characters: a second font resource is created automatically, every character still correct", async () => {
  const many = Array.from({ length: 0x17f - 0xc0 + 1 }, (_, index) => String.fromCodePoint(0xc0 + index)).filter((char) => fontkit.create(fontBytes).glyphForCodePoint(char.codePointAt(0)!).id !== 0);
  assert.ok(many.length > 128, `fixture uses ${many.length} distinct characters`);
  const lines = [many.slice(0, 70).join(""), many.slice(70, 140).join(""), many.slice(140).join("")];
  const { bytes } = await draw(lines);
  const doc = await PDFDocument.load(bytes);
  const fonts = (doc.getPage(0).node.lookup(PDFName.of("Resources")) as PDFDict).lookup(PDFName.of("Font")) as PDFDict;
  assert.ok(fonts.keys().length >= 2, "a second simple font resource");
  assert.equal((await textOf(bytes)).join(""), lines.join(""));
});

test("a character the font has no glyph for becomes '?', never a silent gap; measure() matches what is drawn", async () => {
  const doc = await PDFDocument.create();
  const font = createSimpleTrueTypeTextFont(doc, fontBytes, fontkit.create(fontBytes));
  assert.equal(font.normalize("A😀B"), "A?B");
  assert.equal(font.measure("A😀B", 10), font.measure("A?B", 10));
  assert.ok(Math.abs(font.measure("kW", 10) - (font.measure("k", 10) + font.measure("W", 10))) < 1e-9, "no kerning — exactly like Tj");
});
