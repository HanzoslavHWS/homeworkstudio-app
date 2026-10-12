import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_CUSTOMER_CATALOG_EXPORT_OPTIONS,
  buildCustomerCatalogDocument,
  type CustomerCatalogEntry,
  type CustomerCatalogExportOptions,
  type CustomerCatalogItemType,
} from "../domain/customerCatalog.ts";
import { buildCustomerCatalogPdf, pdfSafeText, renderCustomerCatalogPdf, type CustomerCatalogPdfImages } from "../lib/customerCatalogPdf.ts";
import fontkit from "@pdf-lib/fontkit";
import { NOTO_SANS_CZECH_REGULAR_BASE64 } from "../lib/fonts/graphicsProductionFont.ts";
import type { PdfDoc } from "../lib/pdf/czechFont.ts";

// 1x1 red PNG.
const TINY_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

function entry(id: string, itemType: CustomerCatalogItemType, name: string, overrides: Partial<CustomerCatalogEntry> = {}): CustomerCatalogEntry {
  return {
    id,
    itemType,
    name,
    abfCode: `A${id.toUpperCase()}`,
    internalCode: `INT-${id.toUpperCase()}`,
    category: itemType === "BOOTH" ? "Typovky" : itemType === "SERVICE" ? "T. služby" : "Nábytek",
    categoryLabel: itemType === "BOOTH" ? "Typovky" : itemType === "SERVICE" ? "Technické služby" : "Nábytek",
    unit: "ks",
    shortDescription: `Popis položky ${name}.`,
    dimensions: { widthMm: 600, depthMm: 400, heightMm: 750, hasDimensions: true },
    sortOrder: null,
    technicalParameters: itemType === "SERVICE" ? [{ key: "Výkon", value: "3 kW" }] : [],
    packageContents: itemType === "BOOTH" ? [{ childItemId: "c", name: "Pult", quantity: 1, unit: "ks" }, { childItemId: "d", name: "Židle", quantity: 2, unit: "ks" }] : [],
    price: { status: "fixed", amount: 1250, currency: "CZK" },
    ...overrides,
  };
}

const ENTRIES: readonly CustomerCatalogEntry[] = [
  entry("chair", "PRODUCT", "Židle konferenční", { imageUrl: "/photo.jpg" }),
  entry("table", "PRODUCT", "Stůl jednací"),
  entry("power", "SERVICE", "Elektrická přípojka"),
  entry("booth", "BOOTH", "Stánek E"),
];

function catalog(entries: readonly CustomerCatalogEntry[] = ENTRIES, options: Partial<CustomerCatalogExportOptions> = {}) {
  return buildCustomerCatalogDocument({
    entries,
    options: { ...DEFAULT_CUSTOMER_CATALOG_EXPORT_OPTIONS, ...options },
    currency: "CZK",
    event: { name: "FOR BEAUTY 2026", venue: "PVA EXPO PRAHA", eventFrom: "2026-10-16", eventTo: "2026-10-18" },
  });
}

/**
 * Records every drawing call. The real PDF embeds a subset font, so its text is stored as glyph
 * ids and cannot be searched — the renderer is therefore asserted against this recorder, and the
 * real jsPDF output separately for being a valid, correctly paginated PDF.
 */
function recordingDoc(options: Readonly<{ failAddImage?: boolean }> = {}) {
  const texts: string[] = [];
  const images: string[] = [];
  let pages = 1;
  const doc: PdfDoc = {
    setFont: () => undefined,
    setFontSize: () => 0,
    text: (text) => { texts.push(...(Array.isArray(text) ? text : [text])); },
    splitTextToSize: (text, maxWidth) => {
      const perLine = Math.max(8, Math.floor(maxWidth / 1.6));
      const lines: string[] = [];
      for (let start = 0; start < text.length; start += perLine) lines.push(text.slice(start, start + perLine));
      return lines.length > 0 ? lines : [""];
    },
    setDrawColor: () => undefined,
    setFillColor: () => undefined,
    setTextColor: () => undefined,
    setLineWidth: () => undefined,
    rect: () => undefined,
    circle: () => undefined,
    line: () => undefined,
    addImage: (imageData) => {
      if (options.failAddImage) throw new Error("unsupported image");
      images.push(imageData);
    },
    addPage: () => { pages += 1; },
    addFileToVFS: () => undefined,
    addFont: () => undefined,
    internal: { pageSize: { getWidth: () => 210, getHeight: () => 297 } },
    output: () => new ArrayBuffer(0),
  };
  return { doc, texts, images, pageCount: () => pages, allText: () => texts.join("\n") };
}

function countPages(bytes: Uint8Array): number {
  return (new TextDecoder("latin1").decode(bytes).match(/\/Type\s*\/Page\b/gu) ?? []).length;
}

test("PDF: a real PDF is produced — cover page plus content", async () => {
  const bytes = await buildCustomerCatalogPdf(catalog());
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  assert.ok(countPages(bytes) >= 2);
});

test("PDF: contains exactly the selected items, grouped under their category headings", () => {
  const recorder = recordingDoc();
  renderCustomerCatalogPdf(recorder.doc, catalog(ENTRIES.filter((candidate) => candidate.id !== "table")));
  const text = recorder.allText();
  for (const name of ["Židle konferenční", "Elektrická přípojka", "Stánek E"]) assert.ok(text.includes(name), name);
  assert.ok(!text.includes("Stůl jednací"));
  for (const heading of ["NÁBYTEK", "TECHNICKÉ SLUŽBY", "TYPOVKY"]) assert.ok(recorder.texts.includes(heading), heading);
  assert.ok(recorder.texts.indexOf("NÁBYTEK") < recorder.texts.indexOf("TECHNICKÉ SLUŽBY"));
});

test("PDF: cover carries the title, the event and its date", () => {
  const recorder = recordingDoc();
  renderCustomerCatalogPdf(recorder.doc, catalog());
  const firstHeading = recorder.texts.indexOf("NÁBYTEK");
  const cover = recorder.texts.slice(0, firstHeading).join("\n");
  assert.match(cover, /Katalog vybavení a služeb/u);
  assert.match(cover, /FOR BEAUTY 2026/u);
  assert.match(cover, /2026.*PVA EXPO PRAHA/u);
  assert.match(cover, /HOMEWORK STUDIO/u);
});

test("PDF: every printed price is bez DPH; the booth shows the price of the whole and its contents", () => {
  const recorder = recordingDoc();
  renderCustomerCatalogPdf(recorder.doc, catalog());
  const priced = recorder.texts.filter((line) => /Kč/u.test(line));
  assert.ok(priced.length >= 4);
  for (const line of priced) assert.match(line, /bez DPH/u);
  assert.ok(recorder.texts.some((line) => line.startsWith("Cena celku: 1 250 Kč bez DPH")));
  assert.ok(recorder.texts.includes("Obsahuje:"));
  assert.ok(recorder.texts.some((line) => line.includes("2× Židle")));
  assert.ok(recorder.texts.includes("Výkon: 3 kW"));
});

test("PDF: hiding prices and ABF codes removes them from the output", () => {
  const recorder = recordingDoc();
  renderCustomerCatalogPdf(recorder.doc, catalog(ENTRIES, { showPrices: false, showAbfCode: false }));
  const text = recorder.allText();
  assert.doesNotMatch(text, /Kč|DPH|ABF/u);
  assert.match(text, /Jednotka: ks/u);
  assert.doesNotMatch(text, /INT-/u);
});

test("PDF: an item without a price is rendered without one — never as 0", () => {
  const recorder = recordingDoc();
  renderCustomerCatalogPdf(recorder.doc, catalog([entry("table", "PRODUCT", "Stůl jednací", { price: { status: "missing" } })]));
  const text = recorder.allText();
  assert.match(text, /Stůl jednací/u);
  assert.doesNotMatch(text, /Kč|není nastavena/u);
});

test("PDF: items without images get a placeholder; a provided image is embedded", () => {
  const withoutImages = recordingDoc();
  renderCustomerCatalogPdf(withoutImages.doc, catalog());
  assert.equal(withoutImages.images.length, 0);
  assert.ok(withoutImages.texts.includes("Bez fotografie"));
  assert.ok(withoutImages.texts.includes("Vizualizace není k dispozici"));

  const images: CustomerCatalogPdfImages = new Map([["chair", { dataUrl: TINY_PNG, widthPx: 800, heightPx: 600, format: "PNG" as const }]]);
  const withImage = recordingDoc();
  renderCustomerCatalogPdf(withImage.doc, catalog(), images, { eventLogo: { dataUrl: TINY_PNG, widthPx: 400, heightPx: 200, format: "PNG" } });
  assert.equal(withImage.images.length, 2);
});

test("PDF: an image jsPDF cannot draw falls back to the placeholder instead of failing the export", async () => {
  const images: CustomerCatalogPdfImages = new Map([["chair", { dataUrl: TINY_PNG, widthPx: 800, heightPx: 600, format: "PNG" as const }]]);
  const recorder = recordingDoc({ failAddImage: true });
  assert.doesNotThrow(() => renderCustomerCatalogPdf(recorder.doc, catalog(), images, { eventLogo: { dataUrl: TINY_PNG, widthPx: 1, heightPx: 1 } }));
  assert.ok(recorder.allText().includes("Židle konferenční"));

  const broken: CustomerCatalogPdfImages = new Map([["chair", { dataUrl: "data:image/png;base64,not-an-image", widthPx: 10, heightPx: 10, format: "PNG" as const }]]);
  const bytes = await buildCustomerCatalogPdf(catalog(), broken);
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
});

test("PDF: a large catalog paginates and a section heading is never left alone at a page end", async () => {
  const many = Array.from({ length: 41 }, (_, index) => entry(`p${index}`, "PRODUCT", `Produkt ${String(index).padStart(2, "0")}`));
  const bytes = await buildCustomerCatalogPdf(catalog([...many, entry("booth", "BOOTH", "Stánek E"), entry("power", "SERVICE", "Elektrická přípojka")]));
  assert.ok(countPages(bytes) >= 6);

  const recorder = recordingDoc();
  const pageOfText: number[] = [];
  const originalText = recorder.doc.text;
  const tracking: PdfDoc = { ...recorder.doc, text: (text, x, y, options) => { pageOfText.push(recorder.pageCount()); originalText(text, x, y, options); } };
  renderCustomerCatalogPdf(tracking, catalog([...many, entry("booth", "BOOTH", "Stánek E")]));
  const headingIndex = recorder.texts.indexOf("TYPOVKY");
  const boothIndex = recorder.texts.indexOf("Stánek E");
  assert.ok(headingIndex >= 0 && boothIndex > headingIndex);
  assert.equal(pageOfText[headingIndex], pageOfText[boothIndex]);
});

test("PDF: an empty selection still yields a valid single-page document", async () => {
  const bytes = await buildCustomerCatalogPdf(catalog([]));
  assert.equal(new TextDecoder().decode(bytes.slice(0, 5)), "%PDF-");
  assert.equal(countPages(bytes), 1);
});

test("PDF: characters missing from the embedded font are replaced, never silently dropped", () => {
  assert.equal(pdfSafeText("Internet \u2014 pevná \u201epřípojka\u201c\u2026 \u20ac 52"), 'Internet \u2013 pevná "přípojka"... EUR 52');
  const recorder = recordingDoc();
  renderCustomerCatalogPdf(recorder.doc, catalog([entry("net", "SERVICE", "Internet \u2014 pevná přípojka", { price: { status: "fixed", amount: 52, currency: "EUR" } })]));
  const font = fontkit.create(Buffer.from(NOTO_SANS_CZECH_REGULAR_BASE64, "base64"));
  for (const line of recorder.texts) {
    for (const character of line) assert.ok(font.hasGlyphForCodePoint(character.codePointAt(0)!), `"${character}" in "${line}" has no glyph`);
  }
  assert.ok(recorder.texts.includes("EUR 52 bez DPH / ks"));
});
