/**
 * Print Surfaces — PDF FINAL DESIGN (this phase). A REAL PDF artifact (Uint8Array, `%PDF-` magic
 * bytes), not the browser's print-to-PDF dialog — the ONLY PDF/preview path this module's caller
 * (PrintSurfaceExportPanel.tsx) offers now; the earlier browser-print HTML preview was retired in
 * this phase in favor of this single, consistent, professional A4 document (spec section 2/11).
 * Reuses this app's ONE existing PDF mechanism end to end: jsPDF + the shared embedded Czech font
 * (lib/pdf/czechFont.ts), the exact same dependency lib/presentationPdf.ts and
 * lib/graphicsProductionPdf.ts already use — never a second PDF library.
 *
 * Visual direction (spec section 2): a clean technical document, generous white space, bold-but-
 * simple typography, the event's own logo (never ABF/HomeworkStudio branding), large
 * visualizations, compact technical markers, and a well-structured table. Pricing is entirely
 * absent from this document in this phase (spec section 1) — the underlying view model still
 * carries showPrices/totalPrice (domain/printSurfaceExport.ts, untouched) for a future phase, this
 * module simply never reads them.
 *
 * Each view's photo carries the SAME A/B/C marker pins the editor shows — computed from
 * MarkerPlacement's xNormalized/yNormalized against the image rectangle actually drawn by jsPDF
 * (never the outer layout box — see lib/pdf/imageRect.ts's resolveContainRect/
 * mapNormalizedPointToRect, kept jsPDF-independent and unit-testable on purpose). Marker data comes
 * straight from the export view model's own PrintSurfaceExportImage.markers (already item-label-
 * resolved by domain/printSurfaceExport.ts) — this module never re-derives item/placement data
 * itself. All logo/image resolution (lib/pdf/prepareImageForPdf.ts) happens OUTSIDE this function, same
 * externalization principle as graphicsProductionPdf.ts's `thumbnails` map — this stays pure
 * layout code, testable without network access.
 */
import { FONT_FAMILY, registerCzechFont, type PdfDoc } from "./pdf/czechFont.ts";
import type { LoadedImageDataUrl } from "./pdf/loadImageDataUrl.ts";
import { mapNormalizedPointToRect, resolveContainRect, type Rect } from "./pdf/imageRect.ts";
import {
  PRINT_SURFACE_PDF_EVENT_LOGO_HEIGHT_MM,
  PRINT_SURFACE_PDF_EVENT_LOGO_WIDTH_MM,
  PRINT_SURFACE_PDF_TWO_VIEW_GAP_MM,
  resolvePrintSurfaceViewRenderBox,
} from "./pdf/printSurfaceViewLayout.ts";
import type { PrintSurfaceExportImage, PrintSurfaceExportRow, PrintSurfaceExportViewModel } from "../domain/printSurfaceExport.ts";

const PAGE_MARGIN_MM = 14;
const GRAY_TEXT_RGB: readonly [number, number, number] = [140, 142, 145];
const RULE_RGB: readonly [number, number, number] = [20, 20, 20];
/** Constant PDF-unit (mm) marker radius — deliberately independent of the source image's pixel size, so a marker stays a consistent, readable size on A4 regardless of how large/small the uploaded photo was. A technical pin, never a big UI button (spec section 7). */
const MARKER_RADIUS_MM = 2.5;
const MARKER_FILL_RGB: readonly [number, number, number] = [21, 21, 21];

export type PrintSurfacePdfBranding = Readonly<{
  /** The specific exhibition's logo — top-right when present; falls back to plain text (viewModel.eventBranding.displayName) when absent, never blocking the document. */
  eventLogoDataUrl?: string;
}>;

/** Keyed by PrintSurfaceExportImage.viewId — resolved outside this function, exactly like graphicsProductionPdf.ts's thumbnails map. A view with no entry here (image failed to load, or has none) renders as a bordered placeholder, never a hole in the layout. */
export type PrintSurfacePdfViewImages = ReadonlyMap<string, LoadedImageDataUrl>;

function drawHeader(doc: PdfDoc, viewModel: PrintSurfaceExportViewModel, branding: PrintSurfacePdfBranding, pageWidth: number): number {
  let y = PAGE_MARGIN_MM;
  const hasEventLogo = Boolean(branding.eventLogoDataUrl);

  doc.setFont(FONT_FAMILY, "bold");
  doc.setFontSize(19);
  doc.text("EXPORT TISKOVÝCH PLOCH", PAGE_MARGIN_MM, y + 7);

  const eventLogoW = PRINT_SURFACE_PDF_EVENT_LOGO_WIDTH_MM;
  const eventLogoH = PRINT_SURFACE_PDF_EVENT_LOGO_HEIGHT_MM;
  const eventLogoX = pageWidth - PAGE_MARGIN_MM - eventLogoW;
  if (hasEventLogo) {
    try {
      doc.addImage(branding.eventLogoDataUrl!, "PNG", eventLogoX, y, eventLogoW, eventLogoH);
    } catch {
      // A broken/tainted-canvas logo never blocks the document — falls through to the text title below.
    }
  }
  if (!hasEventLogo && viewModel.eventBranding.displayName) {
    doc.setFont(FONT_FAMILY, "bold");
    doc.setFontSize(13);
    doc.text(viewModel.eventBranding.displayName, pageWidth - PAGE_MARGIN_MM, y + 9, { align: "right" });
  }

  y += Math.max(14, hasEventLogo ? eventLogoH : 0) + 5;
  doc.setDrawColor(...RULE_RGB);
  doc.setLineWidth(0.6);
  doc.line(PAGE_MARGIN_MM, y, pageWidth - PAGE_MARGIN_MM, y);
  return y + 9;
}

/**
 * Compact metadata GRID (spec section 3/4) — up to 3 columns of label/value pairs, never a long
 * vertical list, so the header block stays a small fraction of the A4 page and leaves the rest to
 * the visualizations/table (spec's stated priority: 1. images, 2. labels, 3. dimensions). Each
 * value is bold and visually dominant over its small uppercase gray label, matching the spec's own
 * "VYSTAVOVATEL / Beauty Brand s.r.o." example. A value too wide for its column is ellipsis-
 * truncated (metadata values are short business facts, not free-form text — the table below is
 * where real wrapping matters).
 *
 * Deliberately never shows "Realizační firma" or "Revize" (real-usage follow-up: internal-only
 * facts the customer doesn't need in their copy) — `fields` is a plain array laid out purely by
 * its own index (`row = index / columns`), so leaving those two out simply reflows the remaining
 * fields with no gap, never a blank cell where they used to be. viewModel.realizationCompanyName/
 * revision are UNCHANGED elsewhere (export-history revision tracking, email context, etc.) — only
 * this grid stopped rendering them.
 */
function drawMetadataGrid(doc: PdfDoc, viewModel: PrintSurfaceExportViewModel, x: number, y: number, pageWidth: number): number {
  const fields: Readonly<{ label: string; value: string }>[] = [
    { label: "VYSTAVOVATEL", value: viewModel.companyName || "—" },
    { label: "PROJEKT / STÁNEK", value: viewModel.projectName || "—" },
  ];
  const eventMeta = [viewModel.eventBranding.venue, viewModel.eventBranding.dateRange].filter(Boolean).join(" · ");
  if (eventMeta) fields.push({ label: "VELETRH", value: eventMeta });
  fields.push({ label: "DATUM EXPORTU", value: new Date(viewModel.generatedAt).toLocaleDateString("cs-CZ") });

  const columns = 3;
  const colWidth = (pageWidth - PAGE_MARGIN_MM * 2) / columns;
  const rowHeight = 13;
  const maxChars = Math.floor((colWidth - 2) / 1.9);

  fields.forEach((field, index) => {
    const col = index % columns;
    const row = Math.floor(index / columns);
    const fx = x + col * colWidth;
    const fy = y + row * rowHeight;
    doc.setFont(FONT_FAMILY, "normal");
    doc.setFontSize(7);
    doc.setTextColor(...GRAY_TEXT_RGB);
    doc.text(field.label, fx, fy);
    doc.setFont(FONT_FAMILY, "bold");
    doc.setFontSize(11);
    doc.setTextColor(0, 0, 0);
    const value = field.value.length > maxChars ? `${field.value.slice(0, Math.max(0, maxChars - 1))}…` : field.value;
    doc.text(value, fx, fy + 5.5);
  });

  const rowCount = Math.ceil(fields.length / columns);
  return y + rowCount * rowHeight + 3;
}

/** One compact summary line — never a sidebar (spec section 5: it must not shrink the visualizations). */
function drawSummary(doc: PdfDoc, viewModel: PrintSurfaceExportViewModel, x: number, y: number, pageWidth: number): number {
  const parts = [`Celkem ploch: ${viewModel.summary.total}`, ...viewModel.summary.groups.map((group) => `${group.labelCz}: ${group.count}`)];
  doc.setFont(FONT_FAMILY, "normal");
  doc.setFontSize(9);
  doc.setTextColor(60, 60, 60);
  doc.text(parts.join("   ·   "), x, y);
  doc.setTextColor(0, 0, 0);
  y += 4;
  doc.setDrawColor(215, 216, 218);
  doc.setLineWidth(0.2);
  doc.line(x, y, pageWidth - PAGE_MARGIN_MM, y);
  return y + 7;
}

/**
 * Draws the view's photo (or a bordered placeholder) and returns BOTH the bottom-y for layout
 * continuation AND the exact rendered image rect — the latter is what markers must be mapped
 * against (never the outer box). `rect` is undefined whenever no image was actually drawn
 * (missing/broken), in which case the caller draws no markers for that view either.
 */
function drawViewImage(doc: PdfDoc, x: number, y: number, boxWidth: number, boxHeight: number, label: string, image: LoadedImageDataUrl | undefined): Readonly<{ bottom: number; rect: Rect | undefined }> {
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.2);
  let rect: Rect | undefined;
  if (image) {
    rect = resolveContainRect({ x, y, width: boxWidth, height: boxHeight }, image.widthPx, image.heightPx);
    try {
      doc.addImage(image.dataUrl, image.format ?? "PNG", rect.x, rect.y, rect.width, rect.height);
    } catch {
      doc.rect(x, y, boxWidth, boxHeight);
      rect = undefined;
    }
  } else {
    doc.rect(x, y, boxWidth, boxHeight);
    doc.setFont(FONT_FAMILY, "normal");
    doc.setFontSize(8);
    doc.text("Obrázek není k dispozici", x + boxWidth / 2, y + boxHeight / 2, { align: "center" });
  }
  doc.setFont(FONT_FAMILY, "normal");
  doc.setFontSize(8.5);
  doc.setTextColor(90, 92, 95);
  doc.text(label, x, y + boxHeight + 5);
  doc.setTextColor(0, 0, 0);
  return { bottom: y + boxHeight + 9, rect };
}

/** A compact, print-safe marker pin — constant radius regardless of source image size, dark fill + white bordered edge + white label. Deliberately small/technical, never a large UI button (spec section 7). */
function drawMarker(doc: PdfDoc, x: number, y: number, label: string): void {
  doc.setFillColor(...MARKER_FILL_RGB);
  doc.setDrawColor(255, 255, 255);
  doc.setLineWidth(0.35);
  doc.circle(x, y, MARKER_RADIUS_MM, "FD");
  doc.setFont(FONT_FAMILY, "bold");
  doc.setFontSize(6);
  doc.setTextColor(255, 255, 255);
  doc.text(label, x, y + 1.1, { align: "center" });
  doc.setTextColor(0, 0, 0);
}

/** Draws every marker for one view's already-resolved image rect — a marker whose view has no drawn image (missing/broken photo) is simply skipped, never placed at a meaningless (0,0). Never draws a Pohled-1 marker onto Pohled 2 — each PrintSurfaceExportImage only ever carries its OWN placements' markers (domain/printSurfaceExport.ts). */
function drawViewMarkers(doc: PdfDoc, image: PrintSurfaceExportImage, rect: Rect | undefined): void {
  if (!rect) return;
  for (const marker of image.markers) {
    const point = mapNormalizedPointToRect(marker.xNormalized, marker.yNormalized, rect);
    drawMarker(doc, point.x, point.y, marker.label);
  }
}

/**
 * Lays out 1 or 2 views (spec section 6). One view: dominant, near-full page width. Two views:
 * side-by-side columns by default; switches to a full-width STACKED layout only when both
 * resolved images are portrait-oriented (taller than wide) — a side-by-side half-width column
 * would otherwise waste most of a portrait photo's height budget for no reason. Either way, the
 * actual rendered rect always comes from resolveContainRect, so an image is NEVER distorted/
 * stretched regardless of which layout branch is chosen.
 */
function drawViews(doc: PdfDoc, viewModel: PrintSurfaceExportViewModel, viewImages: PrintSurfacePdfViewImages, x: number, y: number): number {
  const images = viewModel.images;
  if (images.length === 0) return y;

  if (images.length === 1) {
    const image = images[0]!;
    const box = resolvePrintSurfaceViewRenderBox(1, false);
    const { bottom, rect } = drawViewImage(doc, x, y, box.widthMm, box.heightMm, image.viewLabel, viewImages.get(image.viewId));
    drawViewMarkers(doc, image, rect);
    return bottom;
  }

  const isPortrait = (img: LoadedImageDataUrl | undefined) => Boolean(img) && img!.heightPx > img!.widthPx;
  const bothPortrait = images.every((image) => isPortrait(viewImages.get(image.viewId)));
  const box = resolvePrintSurfaceViewRenderBox(2, bothPortrait);

  if (bothPortrait) {
    let rowY = y;
    for (const image of images) {
      const { bottom, rect } = drawViewImage(doc, x, rowY, box.widthMm, box.heightMm, image.viewLabel, viewImages.get(image.viewId));
      drawViewMarkers(doc, image, rect);
      rowY = bottom;
    }
    return rowY;
  }

  let bottom = y;
  images.forEach((image, index) => {
    const colX = x + index * (box.widthMm + PRINT_SURFACE_PDF_TWO_VIEW_GAP_MM);
    const drawn = drawViewImage(doc, colX, y, box.widthMm, box.heightMm, image.viewLabel, viewImages.get(image.viewId));
    drawViewMarkers(doc, image, drawn.rect);
    bottom = Math.max(bottom, drawn.bottom);
  });
  return bottom;
}

const TABLE_LINE_HEIGHT_MM = 3.7;
const TABLE_ROW_TOP_PAD_MM = 4.6;
const TABLE_ROW_BOTTOM_PAD_MM = 2;
const TABLE_HEADER_HEIGHT_MM = 8;

type TableColumn = Readonly<{
  header: string;
  width: number;
  wrap: boolean;
  value: (row: PrintSurfaceExportRow) => string;
}>;

function buildTableColumns(viewModel: PrintSurfaceExportViewModel, pageWidth: number): readonly TableColumn[] {
  const usableWidth = pageWidth - PAGE_MARGIN_MM * 2;
  const labelW = 13;
  const typeW = 27;
  const dimensionW = 28;
  const qtyW = 9;
  const viewW = viewModel.showViewColumn ? 20 : 0;
  const nameW = 46;
  const noteW = Math.max(24, usableWidth - labelW - typeW - dimensionW - qtyW - viewW - nameW);

  const columns: TableColumn[] = [
    { header: "Označ.", width: labelW, wrap: false, value: (row) => row.label },
    { header: "Typ", width: typeW, wrap: false, value: (row) => row.typeLabel },
    { header: "Název plochy", width: nameW, wrap: true, value: (row) => row.surfaceName },
    { header: "Rozměr", width: dimensionW, wrap: false, value: (row) => row.dimensionLabel },
    { header: "Ks", width: qtyW, wrap: false, value: (row) => String(row.quantity) },
  ];
  if (viewModel.showViewColumn) columns.push({ header: "Pohled", width: viewW, wrap: false, value: (row) => row.viewLabel });
  columns.push({ header: "Poznámka", width: noteW, wrap: true, value: (row) => row.note || "—" });
  return columns;
}

/**
 * Professional, wrapping-aware table (spec section 8). "Název plochy"/"Poznámka" wrap onto extra
 * lines (doc.splitTextToSize) rather than ever being cut off early; every other column keeps a
 * generous fixed width so it stays on one line in practice, with a last-resort ellipsis only if a
 * value is truly wider than its column. Row height is computed PER ROW from the tallest wrapped
 * cell, so pagination never splits a row's text across a page boundary. The header row is
 * redrawn on every new page (spec: "header tabulky opakovat na nové stránce").
 */
function drawTable(doc: PdfDoc, viewModel: PrintSurfaceExportViewModel, x: number, startY: number, pageWidth: number, pageHeight: number): void {
  const columns = buildTableColumns(viewModel, pageWidth);
  const tableWidth = columns.reduce((sum, col) => sum + col.width, 0);

  let y = startY;

  function drawHeaderRow() {
    doc.setFillColor(244, 245, 246);
    doc.rect(x, y, tableWidth, TABLE_HEADER_HEIGHT_MM, "F");
    doc.setFont(FONT_FAMILY, "bold");
    doc.setFontSize(7.5);
    doc.setTextColor(70, 72, 75);
    let colX = x;
    for (const column of columns) {
      doc.text(column.header, colX + 1.5, y + 5.4);
      colX += column.width;
    }
    doc.setTextColor(0, 0, 0);
    y += TABLE_HEADER_HEIGHT_MM;
  }

  drawHeaderRow();

  viewModel.rows.forEach((row, index) => {
    doc.setFont(FONT_FAMILY, "normal");
    doc.setFontSize(8);
    const cellLines = columns.map((column) => {
      const text = column.value(row);
      if (!column.wrap) return [text];
      return doc.splitTextToSize(text, column.width - 3);
    });
    const lineCount = Math.max(1, ...cellLines.map((lines) => lines.length));
    const rowHeight = TABLE_ROW_TOP_PAD_MM + (lineCount - 1) * TABLE_LINE_HEIGHT_MM + TABLE_ROW_BOTTOM_PAD_MM;

    if (y + rowHeight > pageHeight - PAGE_MARGIN_MM) {
      doc.addPage();
      y = PAGE_MARGIN_MM;
      drawHeaderRow();
      doc.setFont(FONT_FAMILY, "normal");
      doc.setFontSize(8);
    }

    if (index % 2 === 1) {
      doc.setFillColor(250, 250, 251);
      doc.rect(x, y, tableWidth, rowHeight, "F");
    }

    let colX = x;
    columns.forEach((column, colIndex) => {
      const lines = cellLines[colIndex]!;
      if (column.wrap) {
        lines.forEach((line, lineIndex) => {
          doc.text(line, colX + 1.5, y + TABLE_ROW_TOP_PAD_MM + lineIndex * TABLE_LINE_HEIGHT_MM);
        });
      } else {
        const maxChars = Math.floor((column.width - 2) / 1.7);
        const text = lines[0]!;
        const truncated = text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text;
        doc.text(truncated, colX + 1.5, y + TABLE_ROW_TOP_PAD_MM);
      }
      colX += column.width;
    });

    doc.setDrawColor(226, 227, 229);
    doc.setLineWidth(0.15);
    doc.line(x, y + rowHeight, x + tableWidth, y + rowHeight);

    y += rowHeight;
  });
}

/**
 * Header → compact metadata grid → summary line → view images WITH marker pins → data table (no
 * price columns/footer in this phase — see module doc). A4 portrait. Never appends a page beyond
 * what the table itself needed — no trailing blank/instructions page.
 */
export async function buildPrintSurfacePdf(
  viewModel: PrintSurfaceExportViewModel,
  branding: PrintSurfacePdfBranding = {},
  viewImages: PrintSurfacePdfViewImages = new Map(),
): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  // compress: true (jsPDF's content-stream Deflate compression) was investigated and NOT enabled
  // — confirmed it was not previously set anywhere in this app, and prototyping it confirmed the
  // user's own expectation (spec: "nečekej od toho hlavní úsporu JPEG dat") — the saving is small
  // (only affects text/vector drawing commands and the embedded font, not the already-compressed
  // JPEG/PNG image data, which dominates this document's size). The real cost outweighs that small
  // gain: it makes every content stream binary/Deflate-compressed, which broke all 11 of this
  // module's existing structural regression tests (tests/printSurfacePdf.test.ts) that verify
  // marker-overlay position/count and table pagination by reading the RAW PDF content-stream
  // operators as plain text — this repo has no PDF parser/decompression test infrastructure, and
  // building one just to keep a marginal, non-image optimization was not a good trade for the
  // correctness coverage lost (a wrong marker position is a real production defect).
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" }) as unknown as PdfDoc;
  registerCzechFont(doc);
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  let y = drawHeader(doc, viewModel, branding, pageWidth);
  y = drawMetadataGrid(doc, viewModel, PAGE_MARGIN_MM, y, pageWidth);
  y = drawSummary(doc, viewModel, PAGE_MARGIN_MM, y, pageWidth);
  y = drawViews(doc, viewModel, viewImages, PAGE_MARGIN_MM, y) + 3;

  if (y > pageHeight - PAGE_MARGIN_MM - 40) {
    doc.addPage();
    y = PAGE_MARGIN_MM;
  }

  drawTable(doc, viewModel, PAGE_MARGIN_MM, y + 4, pageWidth, pageHeight);

  return new Uint8Array(doc.output("arraybuffer"));
}
