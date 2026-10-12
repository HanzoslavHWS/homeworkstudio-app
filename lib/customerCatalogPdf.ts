/**
 * Zákaznický katalog — the A4 portrait PDF: a cover page, then one section per category with a
 * visual card grid (PRODUCT image cards two per row, SERVICE text cards two per row, BOOTH as a
 * large full-width block). An offer for a client, not a technical report.
 *
 * Reuses this app's ONE PDF mechanism: jsPDF + the shared embedded Czech font
 * (lib/pdf/czechFont.ts) + the contain-fit math of lib/pdf/imageRect.ts — the same stack
 * lib/printSurfacePdf.ts and lib/presentationPdf.ts are built on. Pure layout: every image is
 * resolved OUTSIDE (see CustomerCatalogPage.tsx, via lib/pdf/prepareImageForPdf.ts), so this runs
 * and is tested without network access. A card whose image is absent or unusable gets a quiet
 * placeholder — never a broken URL, never a failed export.
 *
 * Draws exactly the CustomerCatalogDocument (domain/customerCatalog.ts): which fields a card
 * shows was already decided there, so this module never looks at an export option itself.
 */
import {
  CUSTOMER_CATALOG_PRICE_NOTE,
  catalogCardCodeLine,
  catalogCardPriceLine,
  type CustomerCatalogCard,
  type CustomerCatalogCardLayout,
  type CustomerCatalogDocument,
} from "../domain/customerCatalog.ts";
import { FONT_FAMILY, registerCzechFont, type PdfDoc } from "./pdf/czechFont.ts";
import { resolveContainRect, type Rect } from "./pdf/imageRect.ts";
import type { LoadedImageDataUrl } from "./pdf/loadImageDataUrl.ts";

type Rgb = readonly [number, number, number];

const PAGE_MARGIN_MM = 14;
const COLUMN_GAP_MM = 6;
const CONTENT_TOP_MM = 21;
const CONTENT_BOTTOM_MARGIN_MM = 17;
const ROW_GAP_MM = 6;
const SECTION_HEADING_HEIGHT_MM = 13;
const SECTION_GAP_MM = 5;
const MM_PER_PT = 0.3528;
const LINE_HEIGHT = 1.3;

const INK: Rgb = [21, 21, 21];
const BODY: Rgb = [70, 72, 75];
const MUTED: Rgb = [140, 142, 145];
const CARD_BORDER: Rgb = [222, 224, 226];
const IMAGE_BACKGROUND: Rgb = [246, 246, 245];

const PRODUCT_IMAGE_HEIGHT_MM = 46;
const IMAGE_INSET_MM = 3;
const SERVICE_THUMBNAIL_MM = 22;
const BOOTH_IMAGE_WIDTH_MM = 84;
const BOOTH_IMAGE_HEIGHT_MM = 62;
const COLUMN_WIDTH_MM = (210 - PAGE_MARGIN_MM * 2 - COLUMN_GAP_MM) / 2;

/**
 * The box (mm) an image of each card layout is contain-fitted into — exported so the caller
 * downsizes each photo to what the page actually shows (lib/pdf/prepareImageForPdf.ts) instead of
 * embedding originals.
 */
export const CUSTOMER_CATALOG_PDF_IMAGE_BOX_MM: Readonly<Record<CustomerCatalogCardLayout, Readonly<{ widthMm: number; heightMm: number }>>> = {
  product: { widthMm: COLUMN_WIDTH_MM - IMAGE_INSET_MM * 2, heightMm: PRODUCT_IMAGE_HEIGHT_MM - IMAGE_INSET_MM * 2 },
  service: { widthMm: SERVICE_THUMBNAIL_MM, heightMm: SERVICE_THUMBNAIL_MM },
  booth: { widthMm: BOOTH_IMAGE_WIDTH_MM - IMAGE_INSET_MM * 2, heightMm: BOOTH_IMAGE_HEIGHT_MM - IMAGE_INSET_MM * 2 },
};
export const CUSTOMER_CATALOG_PDF_LOGO_BOX_MM = { widthMm: 80, heightMm: 36 } as const;

/** Keyed by CustomerCatalogCard.id. A card with no entry renders its placeholder. */
export type CustomerCatalogPdfImages = ReadonlyMap<string, LoadedImageDataUrl>;

export type CustomerCatalogPdfBranding = Readonly<{
  /** The exhibition's own logo for the cover; absent = text-only cover. */
  eventLogo?: LoadedImageDataUrl;
  companyBrand?: string;
}>;

const DEFAULT_COMPANY_BRAND = "HOMEWORK STUDIO";

type TextBlock = Readonly<{ lines: readonly string[]; style: "normal" | "bold"; sizePt: number; color: Rgb; gapBeforeMm: number }>;

function lineHeightMm(sizePt: number): number {
  return sizePt * MM_PER_PT * LINE_HEIGHT;
}

function blocksHeight(blocks: readonly TextBlock[]): number {
  return blocks.reduce((sum, block) => sum + block.gapBeforeMm + block.lines.length * lineHeightMm(block.sizePt), 0);
}

const PDF_SAFE_REPLACEMENTS: readonly (readonly [RegExp, string])[] = [
  [/[\u2012\u2014\u2015]/gu, "\u2013"],
  [/[\u2018\u2019\u201a]/gu, "'"],
  [/[\u201c\u201d\u201e]/gu, '"'],
  [/\u2026/gu, "..."],
  [/\u2022/gu, "\u00b7"],
  [/\u20ac/gu, "EUR"],
  [/\u2212/gu, "-"],
  [/[\u2007\u2009\u202f]/gu, "\u00a0"],
];

/**
 * The embedded font is a subset (Latin + Latin-1 + Latin Extended-A + en dash — see
 * lib/fonts/graphicsProductionFont.ts); a character outside it would silently vanish from the
 * page. Typographic characters an admin may type into a name or description are mapped to their
 * nearest covered equivalent instead.
 */
export function pdfSafeText(text: string): string {
  return PDF_SAFE_REPLACEMENTS.reduce((result, [pattern, replacement]) => result.replace(pattern, replacement), text);
}

/** Wraps to `widthMm`; text beyond `maxLines` is cut with "..." (the font subset has no ellipsis glyph). */
function wrap(doc: PdfDoc, text: string, style: "normal" | "bold", sizePt: number, widthMm: number, maxLines: number): readonly string[] {
  doc.setFont(FONT_FAMILY, style);
  doc.setFontSize(sizePt);
  const all = doc.splitTextToSize(pdfSafeText(text), widthMm);
  if (all.length <= maxLines) return all;
  const kept = all.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/\s+\S*$/u, "")}...`;
  return kept;
}

function block(doc: PdfDoc, text: string | undefined, style: "normal" | "bold", sizePt: number, color: Rgb, widthMm: number, maxLines: number, gapBeforeMm = 0): TextBlock[] {
  if (!text) return [];
  return [{ lines: wrap(doc, text, style, sizePt, widthMm, maxLines), style, sizePt, color, gapBeforeMm }];
}

function drawBlocks(doc: PdfDoc, blocks: readonly TextBlock[], x: number, top: number): number {
  let y = top;
  for (const entry of blocks) {
    y += entry.gapBeforeMm;
    doc.setFont(FONT_FAMILY, entry.style);
    doc.setFontSize(entry.sizePt);
    doc.setTextColor(...entry.color);
    for (const line of entry.lines) {
      doc.text(line, x, y + entry.sizePt * MM_PER_PT);
      y += lineHeightMm(entry.sizePt);
    }
  }
  doc.setTextColor(0, 0, 0);
  return y;
}

function drawPlaceholderLabel(doc: PdfDoc, box: Rect, label: string): void {
  doc.setFont(FONT_FAMILY, "normal");
  doc.setFontSize(7);
  doc.setTextColor(...MUTED);
  doc.text(label, box.x + box.width / 2, box.y + box.height / 2 + 1, { align: "center" });
  doc.setTextColor(0, 0, 0);
}

/** Contain-fits the image centred in `box` on a soft background; a missing or undrawable image leaves the background with a small label. */
function drawImageBox(doc: PdfDoc, box: Rect, image: LoadedImageDataUrl | undefined, placeholder: string): void {
  doc.setFillColor(...IMAGE_BACKGROUND);
  doc.rect(box.x, box.y, box.width, box.height, "F");
  if (image) {
    const inner = { x: box.x + IMAGE_INSET_MM, y: box.y + IMAGE_INSET_MM, width: box.width - IMAGE_INSET_MM * 2, height: box.height - IMAGE_INSET_MM * 2 };
    const fitted = resolveContainRect(inner, image.widthPx, image.heightPx);
    if (fitted.width > 0 && fitted.height > 0) {
      try {
        doc.addImage(image.dataUrl, image.format ?? "PNG", fitted.x, inner.y + (inner.height - fitted.height) / 2, fitted.width, fitted.height);
        return;
      } catch {
        // falls through to the placeholder — one bad image never fails the catalog
      }
    }
  }
  drawPlaceholderLabel(doc, box, placeholder);
}

type CardLayout = Readonly<{ heightMm: number; draw: (x: number, y: number, heightMm: number) => void }>;

function cardFrame(doc: PdfDoc, x: number, y: number, widthMm: number, heightMm: number): void {
  doc.setDrawColor(...CARD_BORDER);
  doc.setLineWidth(0.25);
  doc.rect(x, y, widthMm, heightMm, "S");
}

function detailBlocks(doc: PdfDoc, card: CustomerCatalogCard, widthMm: number, descriptionLines: number): TextBlock[] {
  return [
    ...block(doc, catalogCardCodeLine(card), "normal", 7.5, MUTED, widthMm, 1, 0.8),
    ...block(doc, card.description, "normal", 8, BODY, widthMm, descriptionLines, 1.6),
    ...block(doc, card.dimensionsLabel ? `Rozměry: ${card.dimensionsLabel}` : undefined, "normal", 8, BODY, widthMm, 1, 1.6),
    ...card.parameters.slice(0, 8).flatMap((parameter, index) => block(doc, `${parameter.key}: ${parameter.value}`, "normal", 8, BODY, widthMm, 2, index === 0 ? 1.6 : 0.3)),
  ];
}

function priceBlock(doc: PdfDoc, card: CustomerCatalogCard, widthMm: number): TextBlock[] {
  const line = catalogCardPriceLine(card);
  return card.priceLabel ? block(doc, line, "bold", 10.5, INK, widthMm, 2) : block(doc, line, "normal", 8, BODY, widthMm, 1);
}

function layoutProductCard(doc: PdfDoc, card: CustomerCatalogCard, images: CustomerCatalogPdfImages, widthMm: number): CardLayout {
  const padding = 4;
  const textWidth = widthMm - padding * 2;
  const blocks = [...block(doc, card.name, "bold", 10.5, INK, textWidth, 3), ...detailBlocks(doc, card, textWidth, 5)];
  const price = priceBlock(doc, card, textWidth);
  const priceHeight = price.length > 0 ? blocksHeight(price) + 3 : 0;
  return {
    heightMm: PRODUCT_IMAGE_HEIGHT_MM + padding + blocksHeight(blocks) + priceHeight + padding,
    draw: (x, y, heightMm) => {
      drawImageBox(doc, { x, y, width: widthMm, height: PRODUCT_IMAGE_HEIGHT_MM }, images.get(card.id), "Bez fotografie");
      drawBlocks(doc, blocks, x + padding, y + PRODUCT_IMAGE_HEIGHT_MM + padding);
      if (price.length > 0) drawBlocks(doc, price, x + padding, y + heightMm - padding - blocksHeight(price));
      cardFrame(doc, x, y, widthMm, heightMm);
    },
  };
}

/** No image area unless the service actually has an image — then a small thumbnail beside the text. */
function layoutServiceCard(doc: PdfDoc, card: CustomerCatalogCard, images: CustomerCatalogPdfImages, widthMm: number): CardLayout {
  const padding = 4;
  const accent = 1.2;
  const image = card.hasImage ? images.get(card.id) : undefined;
  const thumbnailSpace = image ? SERVICE_THUMBNAIL_MM + 4 : 0;
  const textWidth = widthMm - accent - padding * 2 - thumbnailSpace;
  const blocks = [...block(doc, card.name, "bold", 10.5, INK, textWidth, 3), ...detailBlocks(doc, card, textWidth, 5)];
  const price = priceBlock(doc, card, textWidth);
  const priceHeight = price.length > 0 ? blocksHeight(price) + 3 : 0;
  return {
    heightMm: Math.max(padding * 2 + blocksHeight(blocks) + priceHeight, image ? SERVICE_THUMBNAIL_MM + padding * 2 : 0),
    draw: (x, y, heightMm) => {
      doc.setFillColor(...INK);
      doc.rect(x, y, accent, heightMm, "F");
      const textX = x + accent + padding;
      if (image) {
        const fitted = resolveContainRect({ x: x + widthMm - padding - SERVICE_THUMBNAIL_MM, y: y + padding, width: SERVICE_THUMBNAIL_MM, height: SERVICE_THUMBNAIL_MM }, image.widthPx, image.heightPx);
        try {
          if (fitted.width > 0) doc.addImage(image.dataUrl, image.format ?? "PNG", fitted.x, fitted.y, fitted.width, fitted.height);
        } catch {
          // a service card is complete without its thumbnail
        }
      }
      drawBlocks(doc, blocks, textX, y + padding);
      if (price.length > 0) drawBlocks(doc, price, textX, y + heightMm - padding - blocksHeight(price));
      cardFrame(doc, x, y, widthMm, heightMm);
    },
  };
}

const BOOTH_CONTENT_LINES_MAX = 12;

function layoutBoothCard(doc: PdfDoc, card: CustomerCatalogCard, images: CustomerCatalogPdfImages, widthMm: number): CardLayout {
  const padding = 5;
  const textX = BOOTH_IMAGE_WIDTH_MM + 7;
  const textWidth = widthMm - textX - padding;
  const shownContents = card.contents.slice(0, BOOTH_CONTENT_LINES_MAX);
  const hiddenContents = card.contents.length - shownContents.length;
  const blocks = [
    ...block(doc, card.name, "bold", 15, INK, textWidth, 3),
    ...block(doc, catalogCardCodeLine(card), "normal", 8, MUTED, textWidth, 1, 0.8),
    ...block(doc, card.dimensionsLabel ? `Rozměr: ${card.dimensionsLabel}` : undefined, "bold", 9, BODY, textWidth, 1, 2),
    ...block(doc, card.description, "normal", 8.5, BODY, textWidth, 6, 2),
    ...(shownContents.length > 0 ? block(doc, "Obsahuje:", "bold", 8.5, INK, textWidth, 1, 2.5) : []),
    ...shownContents.flatMap((line) => block(doc, `–  ${line}`, "normal", 8.5, BODY, textWidth, 2, 0.3)),
    ...(hiddenContents > 0 ? block(doc, `a další položky (${hiddenContents})`, "normal", 8, MUTED, textWidth, 1, 0.3) : []),
    ...card.parameters.slice(0, 6).flatMap((parameter, index) => block(doc, `${parameter.key}: ${parameter.value}`, "normal", 8, BODY, textWidth, 2, index === 0 ? 2 : 0.3)),
  ];
  const priceText = catalogCardPriceLine(card);
  const price = card.priceLabel ? block(doc, `Cena celku: ${priceText}`, "bold", 12.5, INK, textWidth, 2) : priceBlock(doc, card, textWidth);
  const priceHeight = price.length > 0 ? blocksHeight(price) + 4 : 0;
  return {
    heightMm: Math.max(BOOTH_IMAGE_HEIGHT_MM, padding * 2 + blocksHeight(blocks) + priceHeight),
    draw: (x, y, heightMm) => {
      drawImageBox(doc, { x, y, width: BOOTH_IMAGE_WIDTH_MM, height: heightMm }, images.get(card.id), "Vizualizace není k dispozici");
      drawBlocks(doc, blocks, x + textX, y + padding);
      if (price.length > 0) drawBlocks(doc, price, x + textX, y + heightMm - padding - blocksHeight(price));
      cardFrame(doc, x, y, widthMm, heightMm);
      doc.setFillColor(...INK);
      doc.rect(x, y, widthMm, 0.9, "F");
    },
  };
}

type Row = Readonly<{ heightMm: number; draw: (y: number) => void }>;

/** BOOTH takes a full row; consecutive PRODUCT (or consecutive SERVICE) cards pair up two per row, equal height. */
function buildRows(doc: PdfDoc, cards: readonly CustomerCatalogCard[], images: CustomerCatalogPdfImages, contentWidth: number): readonly Row[] {
  const rows: Row[] = [];
  for (let index = 0; index < cards.length; index += 1) {
    const card = cards[index]!;
    if (card.layout === "booth") {
      const layout = layoutBoothCard(doc, card, images, contentWidth);
      rows.push({ heightMm: layout.heightMm, draw: (y) => layout.draw(PAGE_MARGIN_MM, y, layout.heightMm) });
      continue;
    }
    const layoutCard = card.layout === "product" ? layoutProductCard : layoutServiceCard;
    const next = cards[index + 1];
    const pair = next && next.layout === card.layout ? [card, next] : [card];
    if (pair.length === 2) index += 1;
    const layouts = pair.map((entry) => layoutCard(doc, entry, images, COLUMN_WIDTH_MM));
    const heightMm = Math.max(...layouts.map((layout) => layout.heightMm));
    rows.push({ heightMm, draw: (y) => layouts.forEach((layout, column) => layout.draw(PAGE_MARGIN_MM + column * (COLUMN_WIDTH_MM + COLUMN_GAP_MM), y, heightMm)) });
  }
  return rows;
}

function drawCover(doc: PdfDoc, catalog: CustomerCatalogDocument, branding: CustomerCatalogPdfBranding, pageWidth: number, pageHeight: number): void {
  const contentWidth = pageWidth - PAGE_MARGIN_MM * 2;
  const logo = branding.eventLogo;
  if (logo) {
    const fitted = resolveContainRect({ x: PAGE_MARGIN_MM, y: 30, width: CUSTOMER_CATALOG_PDF_LOGO_BOX_MM.widthMm, height: CUSTOMER_CATALOG_PDF_LOGO_BOX_MM.heightMm }, logo.widthPx, logo.heightPx);
    try {
      if (fitted.width > 0) doc.addImage(logo.dataUrl, logo.format ?? "PNG", PAGE_MARGIN_MM, 30, fitted.width, fitted.height);
    } catch {
      // text-only cover
    }
  }

  doc.setFillColor(...INK);
  doc.rect(PAGE_MARGIN_MM, 118, 28, 1.4, "F");
  let y = drawBlocks(doc, block(doc, catalog.title, "bold", 30, INK, contentWidth, 4), PAGE_MARGIN_MM, 128);
  y = drawBlocks(doc, block(doc, catalog.eventName, "bold", 17, INK, contentWidth, 3, 7), PAGE_MARGIN_MM, y);
  drawBlocks(doc, block(doc, [catalog.eventDateRange, catalog.eventVenue].filter(Boolean).join("  ·  ") || undefined, "normal", 11, MUTED, contentWidth, 2, 3), PAGE_MARGIN_MM, y);

  const footerY = pageHeight - 24;
  doc.setDrawColor(...INK);
  doc.setLineWidth(0.5);
  doc.line(PAGE_MARGIN_MM, footerY, pageWidth - PAGE_MARGIN_MM, footerY);
  doc.setFont(FONT_FAMILY, "bold");
  doc.setFontSize(9);
  doc.text(pdfSafeText(branding.companyBrand || DEFAULT_COMPANY_BRAND), PAGE_MARGIN_MM, footerY + 7);
  if (catalog.showPrices) {
    doc.setFont(FONT_FAMILY, "normal");
    doc.setTextColor(...MUTED);
    doc.text(`Ceny v ${catalog.currency} bez DPH`, pageWidth - PAGE_MARGIN_MM, footerY + 7, { align: "right" });
    doc.setTextColor(0, 0, 0);
  }
}

function startContentPage(doc: PdfDoc, catalog: CustomerCatalogDocument, pageNumber: number, pageWidth: number, pageHeight: number): number {
  doc.addPage();
  doc.setFont(FONT_FAMILY, "normal");
  doc.setFontSize(7.5);
  doc.setTextColor(...MUTED);
  if (catalog.eventName) doc.text(pdfSafeText(catalog.eventName), PAGE_MARGIN_MM, 11);
  doc.text(pdfSafeText(catalog.title), pageWidth - PAGE_MARGIN_MM, 11, { align: "right" });
  if (catalog.showPrices) doc.text(CUSTOMER_CATALOG_PRICE_NOTE, PAGE_MARGIN_MM, pageHeight - 9);
  doc.text(String(pageNumber), pageWidth - PAGE_MARGIN_MM, pageHeight - 9, { align: "right" });
  doc.setTextColor(0, 0, 0);
  doc.setDrawColor(...CARD_BORDER);
  doc.setLineWidth(0.25);
  doc.line(PAGE_MARGIN_MM, 14, pageWidth - PAGE_MARGIN_MM, 14);
  return CONTENT_TOP_MM;
}

function drawSectionHeading(doc: PdfDoc, title: string, y: number, pageWidth: number): number {
  doc.setFont(FONT_FAMILY, "bold");
  doc.setFontSize(13);
  doc.setTextColor(...INK);
  doc.text(pdfSafeText(title).toLocaleUpperCase("cs"), PAGE_MARGIN_MM, y + 5);
  doc.setTextColor(0, 0, 0);
  doc.setDrawColor(...INK);
  doc.setLineWidth(0.5);
  doc.line(PAGE_MARGIN_MM, y + 8, pageWidth - PAGE_MARGIN_MM, y + 8);
  return y + SECTION_HEADING_HEIGHT_MM;
}

/**
 * Draws the whole catalog onto an already-created A4 portrait document whose first page is blank
 * (the cover). Split out from buildCustomerCatalogPdf so the layout is testable against a
 * recording PdfDoc: the embedded font encodes text as glyph ids, which makes the real PDF's
 * content streams unreadable for a "does it contain this item" assertion.
 */
export function renderCustomerCatalogPdf(
  doc: PdfDoc,
  catalog: CustomerCatalogDocument,
  images: CustomerCatalogPdfImages = new Map(),
  branding: CustomerCatalogPdfBranding = {},
): void {
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();
  const contentWidth = pageWidth - PAGE_MARGIN_MM * 2;
  const bottom = pageHeight - CONTENT_BOTTOM_MARGIN_MM;

  drawCover(doc, catalog, branding, pageWidth, pageHeight);

  let pageNumber = 1;
  let y = Number.POSITIVE_INFINITY; // forces the first section onto a fresh page after the cover
  for (const section of catalog.sections) {
    const rows = buildRows(doc, section.cards, images, contentWidth);
    if (rows.length === 0) continue;
    // A heading never stays alone at the bottom of a page.
    if (y + SECTION_HEADING_HEIGHT_MM + rows[0]!.heightMm > bottom) {
      pageNumber += 1;
      y = startContentPage(doc, catalog, pageNumber, pageWidth, pageHeight);
    }
    y = drawSectionHeading(doc, section.title, y, pageWidth);
    for (const row of rows) {
      if (y + row.heightMm > bottom && y > CONTENT_TOP_MM) {
        pageNumber += 1;
        y = startContentPage(doc, catalog, pageNumber, pageWidth, pageHeight);
      }
      row.draw(y);
      y += row.heightMm + ROW_GAP_MM;
    }
    y += SECTION_GAP_MM;
  }
}

export async function buildCustomerCatalogPdf(
  catalog: CustomerCatalogDocument,
  images: CustomerCatalogPdfImages = new Map(),
  branding: CustomerCatalogPdfBranding = {},
): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" }) as unknown as PdfDoc;
  registerCzechFont(doc);
  renderCustomerCatalogPdf(doc, catalog, images, branding);
  return new Uint8Array(doc.output("arraybuffer"));
}
