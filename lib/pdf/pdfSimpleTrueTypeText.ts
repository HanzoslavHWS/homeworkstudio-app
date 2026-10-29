/**
 * Real, editable PDF TEXT for generator-added labels (HOTFIX-02, phase 5) — as a SIMPLE TrueType
 * font, deliberately NOT pdf-lib's `embedFont()`/`page.drawText()`.
 *
 * Why not pdf-lib's own text: `embedFont()` always produces a Type0 composite font (`/Identity-H`,
 * `CIDFontType2` descendant). CorelDRAW 2018 dropped exactly those labels on import (see
 * lib/technicalRasterVectorPdf.ts — that is why the labels were converted to vector outlines in the
 * first place). A simple `/Subtype /TrueType` font with a single-byte encoding is the oldest, most
 * widely supported way to put text into a PDF: every importer that reads text at all reads it.
 *
 * How it works:
 *   - the embedded font program (NotoSans-Bold, SIL OFL) is written ONCE as `/FontFile2`, in full
 *     (no subsetting — the glyphs for an edit like "5 kW" -> "9 kW" stay available in the file);
 *   - codes 32–126 are plain ASCII (`/BaseEncoding /WinAnsiEncoding`); every other character used
 *     (č, ř, ů, ³, –, …) is given a free code 128–255 through `/Differences` with its standard
 *     Adobe glyph name, which a viewer maps to Unicode and then to the glyph via the font's own
 *     (3,1) cmap — the standard lookup for a non-symbolic TrueType font;
 *   - a `/ToUnicode` CMap makes the text searchable/copyable with the right Czech characters;
 *   - when more than 128 distinct non-ASCII characters are used, a second font resource is created
 *     (same font program), so any amount of text still works.
 * Text is shown with plain `BT /Fn size Tf … Td <hex> Tj ET` — no Type3, no images, no outlines.
 * Characters the font has no glyph for are replaced by "?" (never silently dropped).
 *
 * Font dictionaries are only complete once every label is known: call `finalize()` before
 * `PDFDocument.save()`.
 */
import { PDFDict, PDFName, PDFRef, type PDFDocument, type PDFPage } from "pdf-lib";
import type fontkit from "@pdf-lib/fontkit";

type FontkitFont = ReturnType<typeof fontkit.create>;

export type PdfRgb = Readonly<{ red: number; green: number; blue: number }>;

/** Adobe Glyph List names for U+00A0–U+017F (Latin-1 Supplement + Latin Extended-A — all Czech/Slovak/German/Polish letters). */
const LATIN_1_SUPPLEMENT_NAMES = "uni00A0 exclamdown cent sterling currency yen brokenbar section dieresis copyright ordfeminine guillemotleft logicalnot uni00AD registered macron degree plusminus twosuperior threesuperior acute mu paragraph periodcentered cedilla onesuperior ordmasculine guillemotright onequarter onehalf threequarters questiondown Agrave Aacute Acircumflex Atilde Adieresis Aring AE Ccedilla Egrave Eacute Ecircumflex Edieresis Igrave Iacute Icircumflex Idieresis Eth Ntilde Ograve Oacute Ocircumflex Otilde Odieresis multiply Oslash Ugrave Uacute Ucircumflex Udieresis Yacute Thorn germandbls agrave aacute acircumflex atilde adieresis aring ae ccedilla egrave eacute ecircumflex edieresis igrave iacute icircumflex idieresis eth ntilde ograve oacute ocircumflex otilde odieresis divide oslash ugrave uacute ucircumflex udieresis yacute thorn ydieresis".split(" ");
const LATIN_EXTENDED_A_NAMES = "Amacron amacron Abreve abreve Aogonek aogonek Cacute cacute Ccircumflex ccircumflex Cdotaccent cdotaccent Ccaron ccaron Dcaron dcaron Dcroat dcroat Emacron emacron Ebreve ebreve Edotaccent edotaccent Eogonek eogonek Ecaron ecaron Gcircumflex gcircumflex Gbreve gbreve Gdotaccent gdotaccent Gcommaaccent gcommaaccent Hcircumflex hcircumflex Hbar hbar Itilde itilde Imacron imacron Ibreve ibreve Iogonek iogonek Idotaccent dotlessi IJ ij Jcircumflex jcircumflex Kcommaaccent kcommaaccent kgreenlandic Lacute lacute Lcommaaccent lcommaaccent Lcaron lcaron Ldot ldot Lslash lslash Nacute nacute Ncommaaccent ncommaaccent Ncaron ncaron napostrophe Eng eng Omacron omacron Obreve obreve Ohungarumlaut ohungarumlaut OE oe Racute racute Rcommaaccent rcommaaccent Rcaron rcaron Sacute sacute Scircumflex scircumflex Scedilla scedilla Scaron scaron Tcommaaccent tcommaaccent Tcaron tcaron Tbar tbar Utilde utilde Umacron umacron Ubreve ubreve Uring uring Uhungarumlaut uhungarumlaut Uogonek uogonek Wcircumflex wcircumflex Ycircumflex ycircumflex Ydieresis Zacute zacute Zdotaccent zdotaccent Zcaron zcaron longs".split(" ");
const OTHER_GLYPH_NAMES: Readonly<Record<number, string>> = {
  0x2013: "endash", 0x2014: "emdash", 0x2018: "quoteleft", 0x2019: "quoteright", 0x201a: "quotesinglbase",
  0x201c: "quotedblleft", 0x201d: "quotedblright", 0x201e: "quotedblbase", 0x2022: "bullet", 0x2026: "ellipsis",
  0x20ac: "Euro", 0x2122: "trademark",
};

/** Standard glyph name for a non-ASCII code point (AGL name, else "uniXXXX"/"uXXXXX"). */
export function glyphNameForCodePoint(codePoint: number): string {
  if (codePoint >= 0xa0 && codePoint <= 0xff) return LATIN_1_SUPPLEMENT_NAMES[codePoint - 0xa0]!;
  if (codePoint >= 0x100 && codePoint <= 0x17f) return LATIN_EXTENDED_A_NAMES[codePoint - 0x100]!;
  if (OTHER_GLYPH_NAMES[codePoint]) return OTHER_GLYPH_NAMES[codePoint]!;
  const hex = codePoint.toString(16).toUpperCase();
  return codePoint <= 0xffff ? `uni${hex.padStart(4, "0")}` : `u${hex.padStart(5, "0")}`;
}

const FIRST_ASCII_CODE = 32;
const LAST_ASCII_CODE = 126;
const FIRST_EXTRA_CODE = 128;
const LAST_EXTRA_CODE = 255;

type FontSlot = {
  readonly ref: PDFRef;
  readonly resourceKeyPrefix: string;
  /** code -> code point, for codes 128–255 only. */
  readonly extraCodes: Map<number, number>;
  /** code point -> code, for codes 128–255 only. */
  readonly codeByCodePoint: Map<number, number>;
};

function formatNumber(value: number): string {
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? "0" : String(rounded);
}

function hexByte(code: number): string {
  return code.toString(16).toUpperCase().padStart(2, "0");
}

export type SimpleTrueTypeTextFont = Readonly<{
  /** Characters that will actually be drawn (missing glyphs -> "?"). */
  normalize(text: string): string;
  /** Advance width of `text` at `fontSizePt`, in points — exactly the width `draw` produces (no kerning, like Tj). */
  measure(text: string, fontSizePt: number): number;
  /** Appends real text to `page` with its baseline-left origin at (x, y). Returns the content-stream operators (already appended through `append`). */
  textOperators(page: PDFPage, x: number, y: number, text: string, fontSizePt: number, color: PdfRgb): string;
  /** Writes the font dictionaries (widths, encoding, ToUnicode). Must run once, before save. */
  finalize(): void;
  /** The PostScript name every font resource uses (BaseFont). */
  readonly baseFontName: string;
}>;

/**
 * One embedded font program for the whole document, exposed as one or more simple TrueType font
 * resources (see module doc). `fontBytes` and `font` must be the same font file.
 */
export function createSimpleTrueTypeTextFont(doc: PDFDocument, fontBytes: Uint8Array, font: FontkitFont): SimpleTrueTypeTextFont {
  const ctx = doc.context;
  const unitsPerEm = font.unitsPerEm;
  const baseFontName = (font.postscriptName || "EmbeddedFont").replace(/[^A-Za-z0-9-]/gu, "");
  const fontFileRef = ctx.register(ctx.flateStream(fontBytes, { Length1: fontBytes.length }));
  const bbox = font.bbox;
  const toPdfUnits = (value: number) => Math.round((value * 1000) / unitsPerEm);
  const descriptorRef = ctx.register(ctx.obj({
    Type: "FontDescriptor",
    FontName: baseFontName,
    // 32 = Nonsymbolic: the font's own Latin character set, codes resolved through the encoding.
    Flags: 32,
    FontBBox: [toPdfUnits(bbox.minX), toPdfUnits(bbox.minY), toPdfUnits(bbox.maxX), toPdfUnits(bbox.maxY)],
    ItalicAngle: 0,
    Ascent: toPdfUnits(font.ascent),
    Descent: toPdfUnits(font.descent),
    CapHeight: toPdfUnits(font.capHeight || font.ascent),
    StemV: 120,
    FontFile2: fontFileRef,
  }));

  const slots: FontSlot[] = [];
  const glyphCache = new Map<number, { id: number; advance: number }>();

  function glyphOf(codePoint: number): { id: number; advance: number } {
    let cached = glyphCache.get(codePoint);
    if (!cached) {
      const glyph = font.glyphForCodePoint(codePoint);
      cached = { id: glyph?.id ?? 0, advance: glyph?.advanceWidth ?? 0 };
      glyphCache.set(codePoint, cached);
    }
    return cached;
  }

  function newSlot(): FontSlot {
    const slot: FontSlot = { ref: ctx.nextRef(), resourceKeyPrefix: `GenText${slots.length + 1}`, extraCodes: new Map(), codeByCodePoint: new Map() };
    slots.push(slot);
    return slot;
  }

  function normalize(text: string): string {
    let result = "";
    for (const char of text) {
      const codePoint = char.codePointAt(0)!;
      if (codePoint < FIRST_ASCII_CODE) { result += " "; continue; }
      result += glyphOf(codePoint).id === 0 ? "?" : char;
    }
    return result;
  }

  function measure(text: string, fontSizePt: number): number {
    let width = 0;
    for (const char of normalize(text)) width += glyphOf(char.codePointAt(0)!).advance;
    return (width / unitsPerEm) * fontSizePt;
  }

  /** Splits normalized text into runs, each fully encodable in ONE font slot (allocating codes as needed). */
  function encodeRuns(text: string): readonly Readonly<{ slot: FontSlot; codes: number[] }>[] {
    const runs: { slot: FontSlot; codes: number[] }[] = [];
    for (const char of normalize(text)) {
      const codePoint = char.codePointAt(0)!;
      const isAscii = codePoint >= FIRST_ASCII_CODE && codePoint <= LAST_ASCII_CODE;
      let slot = runs.at(-1)?.slot ?? slots[0] ?? newSlot();
      let code: number | undefined = isAscii ? codePoint : slot.codeByCodePoint.get(codePoint);
      if (code === undefined) {
        // Reuse any slot that already has it, else the first slot with a free code, else a new slot.
        const holder = slots.find((candidate) => candidate.codeByCodePoint.has(codePoint));
        slot = holder ?? slots.find((candidate) => candidate.extraCodes.size < LAST_EXTRA_CODE - FIRST_EXTRA_CODE + 1) ?? newSlot();
        code = slot.codeByCodePoint.get(codePoint);
        if (code === undefined) {
          code = FIRST_EXTRA_CODE + slot.extraCodes.size;
          slot.extraCodes.set(code, codePoint);
          slot.codeByCodePoint.set(codePoint, code);
        }
      }
      const last = runs.at(-1);
      if (last && last.slot === slot) last.codes.push(code);
      else runs.push({ slot, codes: [code] });
    }
    return runs;
  }

  function resourceNameOnPage(page: PDFPage, slot: FontSlot): string {
    const resources = page.node.Resources() ?? (() => { const fresh = ctx.obj({}); page.node.set(PDFName.of("Resources"), fresh); return fresh; })();
    let fonts = resources.lookup(PDFName.of("Font"));
    if (!(fonts instanceof PDFDict)) {
      fonts = ctx.obj({});
      resources.set(PDFName.of("Font"), fonts as PDFDict);
    }
    const fontDict = fonts as PDFDict;
    const existing = fontDict.keys().find((key) => fontDict.get(key)?.toString() === slot.ref.toString());
    if (existing) return existing.decodeText();
    const key = fontDict.uniqueKey(slot.resourceKeyPrefix);
    fontDict.set(key, slot.ref);
    return key.decodeText();
  }

  function textOperators(page: PDFPage, x: number, y: number, text: string, fontSizePt: number, color: PdfRgb): string {
    const runs = encodeRuns(text);
    if (runs.length === 0) return "";
    const parts = [`q BT ${formatNumber(color.red)} ${formatNumber(color.green)} ${formatNumber(color.blue)} rg ${formatNumber(x)} ${formatNumber(y)} Td`];
    for (const run of runs) {
      parts.push(`/${resourceNameOnPage(page, run.slot)} ${formatNumber(fontSizePt)} Tf <${run.codes.map(hexByte).join("")}> Tj`);
    }
    parts.push("ET Q");
    return parts.join(" ");
  }

  function toUnicodeCMap(slot: FontSlot): string {
    const entries: string[] = [];
    for (let code = FIRST_ASCII_CODE; code <= LAST_ASCII_CODE; code += 1) entries.push(`<${hexByte(code)}> <${code.toString(16).toUpperCase().padStart(4, "0")}>`);
    for (const [code, codePoint] of slot.extraCodes) {
      const utf16 = String.fromCodePoint(codePoint).split("").map((unit) => unit.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")).join("");
      entries.push(`<${hexByte(code)}> <${utf16}>`);
    }
    const blocks: string[] = [];
    for (let index = 0; index < entries.length; index += 100) {
      const chunk = entries.slice(index, index + 100);
      blocks.push(`${chunk.length} beginbfchar\n${chunk.join("\n")}\nendbfchar`);
    }
    return [
      "/CIDInit /ProcSet findresource begin",
      "12 dict begin",
      "begincmap",
      "/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def",
      "/CMapName /Adobe-Identity-UCS def",
      "/CMapType 2 def",
      "1 begincodespacerange",
      "<00> <FF>",
      "endcodespacerange",
      ...blocks,
      "endcmap",
      "CMapName currentdict /CMap defineresource pop",
      "end",
      "end",
    ].join("\n");
  }

  function finalize(): void {
    for (const slot of slots) {
      const lastChar = slot.extraCodes.size > 0 ? FIRST_EXTRA_CODE + slot.extraCodes.size - 1 : LAST_ASCII_CODE;
      const widths: number[] = [];
      for (let code = FIRST_ASCII_CODE; code <= lastChar; code += 1) {
        const codePoint = code <= LAST_ASCII_CODE ? code : slot.extraCodes.get(code);
        widths.push(codePoint === undefined ? 0 : toPdfUnits(glyphOf(codePoint).advance));
      }
      const differences: (number | string)[] = [];
      if (slot.extraCodes.size > 0) {
        differences.push(FIRST_EXTRA_CODE);
        for (const codePoint of slot.extraCodes.values()) differences.push(glyphNameForCodePoint(codePoint));
      }
      const encoding = ctx.obj({
        Type: "Encoding",
        BaseEncoding: "WinAnsiEncoding",
        ...(differences.length > 0 ? { Differences: differences.map((entry) => (typeof entry === "number" ? entry : PDFName.of(entry))) } : {}),
      });
      const toUnicodeRef = ctx.register(ctx.flateStream(toUnicodeCMap(slot)));
      ctx.assign(slot.ref, ctx.obj({
        Type: "Font",
        Subtype: "TrueType",
        BaseFont: baseFontName,
        FirstChar: FIRST_ASCII_CODE,
        LastChar: lastChar,
        Widths: widths,
        Encoding: encoding,
        FontDescriptor: descriptorRef,
        ToUnicode: toUnicodeRef,
      }));
    }
  }

  return { normalize, measure, textOperators, finalize, baseFontName };
}
