/**
 * Print Surfaces V5 (spec section 13) — a REAL PDF artifact (Uint8Array, `%PDF-` magic bytes),
 * not the browser's print-to-PDF dialog. Reuses this app's ONE existing PDF mechanism end to end:
 * jsPDF + the shared embedded Czech font (lib/pdf/czechFont.ts), the exact same dependency
 * lib/presentationPdf.ts and lib/graphicsProductionPdf.ts already use — never a second PDF
 * library, never a hand-rolled binary format.
 *
 * This exists ALONGSIDE the existing browser print-preview HTML (PrintSurfaceExportPanel.tsx's
 * "PDF / Tiskový přehled" action, untouched by this module) rather than replacing it — that flow
 * is already verified working with full marker-overlay images and must not regress (spec section
 * 18). This module's job is narrower and specific: produce a real, uploadable, attachable FILE —
 * needed because a `mailto:` link (this app's only "Outlook" integration — see EmailsPage.tsx)
 * cannot carry attachments, so an email handoff needs a real downloadable artifact to point at.
 *
 * Each view's photo carries the SAME A/B/C marker pins the editor and the browser print-preview
 * HTML show — computed from MarkerPlacement's xNormalized/yNormalized against the image
 * rectangle actually drawn by jsPDF (never the outer layout box — see lib/pdf/imageRect.ts's
 * resolveContainRect/mapNormalizedPointToRect, kept jsPDF-independent and unit-testable on
 * purpose). Marker data comes straight from the export view model's own
 * PrintSurfaceExportImage.markers (already item-label-resolved by
 * domain/printSurfaceExport.ts) — this module never re-derives item/placement data itself. All
 * logo/image resolution (loadImageAsDataUrl) happens OUTSIDE this function, same externalization
 * principle as graphicsProductionPdf.ts's `thumbnails` map — this stays pure layout code, testable
 * without network access.
 *
 * Deliberately carries NO internal ABF/HomeworkStudio branding and NO "Pokyny pro přípravu
 * grafiky" block — this is a cleanup pass; the event's own branding (viewModel.eventBranding) is
 * the only branding this document shows. The instructions text still exists as a data model
 * (domain/graphicsInstructions.ts) for a future phase, it's just not rendered here.
 */
import { FONT_FAMILY, registerCzechFont, type PdfDoc } from "./pdf/czechFont.ts";
import type { LoadedImageDataUrl } from "./pdf/loadImageDataUrl.ts";
import { mapNormalizedPointToRect, resolveContainRect, type Rect } from "./pdf/imageRect.ts";
import type { PrintSurfaceExportImage, PrintSurfaceExportViewModel } from "../domain/printSurfaceExport.ts";

const PAGE_MARGIN_MM = 14;
const LINE_HEIGHT_MM = 5;
/** Constant PDF-unit (mm) marker radius — deliberately independent of the source image's pixel size, so a marker stays a consistent, readable size on A4 regardless of how large/small the uploaded photo was (spec section 3). */
const MARKER_RADIUS_MM = 2.6;
/** Matches the print-preview HTML's `.ps-marker` styling (app/globals.css) — same dark fill/white text/white border, so the PDF and the HTML preview look like the same document. */
const MARKER_FILL_RGB: readonly [number, number, number] = [21, 21, 21];

export type PrintSurfacePdfBranding = Readonly<{
  /** The specific exhibition's logo — spec section 1/2, top-right when present; falls back to plain text (viewModel.eventBranding.displayName) when absent, never blocking the document (spec section 3). */
  eventLogoDataUrl?: string;
}>;

/** Keyed by PrintSurfaceExportImage.viewId — resolved outside this function, exactly like graphicsProductionPdf.ts's thumbnails map. A view with no entry here (image failed to load, or has none) renders as a bordered placeholder, never a hole in the layout. */
export type PrintSurfacePdfViewImages = ReadonlyMap<string, LoadedImageDataUrl>;

function headerLine(doc: PdfDoc, label: string, value: string, x: number, y: number, labelWidth = 30): void {
  doc.setFont(FONT_FAMILY, "bold");
  doc.text(`${label}:`, x, y);
  doc.setFont(FONT_FAMILY, "normal");
  doc.text(value, x + labelWidth, y);
}

function drawHeader(doc: PdfDoc, viewModel: PrintSurfaceExportViewModel, branding: PrintSurfacePdfBranding, pageWidth: number): number {
  let y = PAGE_MARGIN_MM;
  const hasEventLogo = Boolean(branding.eventLogoDataUrl);
  const titleX = PAGE_MARGIN_MM;

  doc.setFont(FONT_FAMILY, "bold");
  doc.setFontSize(15);
  doc.text("EXPORT TISKOVÝCH PLOCH", titleX, y + 6);

  const eventLogoW = 30;
  const eventLogoH = 18;
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
    doc.setFontSize(12);
    doc.text(viewModel.eventBranding.displayName, pageWidth - PAGE_MARGIN_MM, y + 7, { align: "right" });
  }

  y += Math.max(12, hasEventLogo ? eventLogoH : 0) + 4;
  doc.setDrawColor(20, 20, 20);
  doc.setLineWidth(0.5);
  doc.line(PAGE_MARGIN_MM, y, pageWidth - PAGE_MARGIN_MM, y);
  y += 6;
  return y;
}

function drawMetadata(doc: PdfDoc, viewModel: PrintSurfaceExportViewModel, x: number, y: number): number {
  doc.setFontSize(9);
  headerLine(doc, "Vystavovatel", viewModel.companyName || "—", x, y, 32); y += LINE_HEIGHT_MM;
  headerLine(doc, "Projekt / stánek", viewModel.projectName || "—", x, y, 32); y += LINE_HEIGHT_MM;
  if (viewModel.realizationCompanyName) { headerLine(doc, "Realizační firma", viewModel.realizationCompanyName, x, y, 32); y += LINE_HEIGHT_MM; }
  const eventMeta = [viewModel.eventBranding.venue, viewModel.eventBranding.dateRange].filter(Boolean).join(" · ");
  if (eventMeta) { headerLine(doc, "Veletrh", eventMeta, x, y, 32); y += LINE_HEIGHT_MM; }
  headerLine(doc, "Datum exportu", new Date(viewModel.generatedAt).toLocaleDateString("cs-CZ"), x, y, 32); y += LINE_HEIGHT_MM;
  headerLine(doc, "Revize", `R${viewModel.revision}`, x, y, 32); y += LINE_HEIGHT_MM;
  return y + 3;
}

function drawSummary(doc: PdfDoc, viewModel: PrintSurfaceExportViewModel, x: number, y: number, pageWidth: number): number {
  const parts = [`Celkem ploch: ${viewModel.summary.total}`, ...viewModel.summary.groups.map((group) => `${group.labelCz}: ${group.count}`)];
  doc.setFont(FONT_FAMILY, "normal");
  doc.setFontSize(8.5);
  doc.setDrawColor(120, 120, 120);
  doc.text(parts.join("   ·   "), x, y);
  y += 5;
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.2);
  doc.line(x, y, pageWidth - PAGE_MARGIN_MM, y);
  return y + 6;
}

/**
 * Draws the view's photo (or a bordered placeholder) and returns BOTH the bottom-y for layout
 * continuation AND the exact rendered image rect — the latter is what markers must be mapped
 * against (spec section 6: never the outer box). `rect` is undefined whenever no image was
 * actually drawn (missing/broken), in which case the caller draws no markers for that view either
 * (a marker pinned to a photo that isn't there has nowhere meaningful to sit).
 */
function drawViewImage(doc: PdfDoc, x: number, y: number, boxWidth: number, boxHeight: number, label: string, image: LoadedImageDataUrl | undefined): Readonly<{ bottom: number; rect: Rect | undefined }> {
  doc.setDrawColor(220, 220, 220);
  doc.setLineWidth(0.2);
  let rect: Rect | undefined;
  if (image) {
    rect = resolveContainRect({ x, y, width: boxWidth, height: boxHeight }, image.widthPx, image.heightPx);
    try {
      doc.addImage(image.dataUrl, "PNG", rect.x, rect.y, rect.width, rect.height);
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
  doc.setFontSize(8);
  doc.text(label, x, y + boxHeight + 4);
  return { bottom: y + boxHeight + 8, rect };
}

/** A compact, print-safe marker pin — constant radius regardless of source image size (spec section 3), dark fill + white bordered edge + white label, matching the print-preview HTML's `.ps-marker` look exactly. */
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

/** Draws every marker for one view's already-resolved image rect — a marker whose view has no drawn image (missing/broken photo) is simply skipped, never placed at a meaningless (0,0). */
function drawViewMarkers(doc: PdfDoc, image: PrintSurfaceExportImage, rect: Rect | undefined): void {
  if (!rect) return;
  for (const marker of image.markers) {
    const point = mapNormalizedPointToRect(marker.xNormalized, marker.yNormalized, rect);
    drawMarker(doc, point.x, point.y, marker.label);
  }
}

const BASE_COLUMNS_WIDTH_MM = 12 + 24 + 38 + 26 + 10; // Označ. + Typ + Název plochy + Rozměr + Ks

function drawTable(doc: PdfDoc, viewModel: PrintSurfaceExportViewModel, x: number, startY: number, pageWidth: number, pageHeight: number): void {
  const viewColWidth = viewModel.showViewColumn ? 18 : 0;
  const priceColWidth = viewModel.showPrices ? 22 : 0;
  const usedWidth = BASE_COLUMNS_WIDTH_MM + viewColWidth + priceColWidth;
  const noteWidth = Math.max(20, pageWidth - PAGE_MARGIN_MM * 2 - usedWidth);

  const columns: readonly Readonly<{ header: string; width: number; value: (row: PrintSurfaceExportViewModel["rows"][number]) => string }>[] = [
    { header: "Označ.", width: 12, value: (row) => row.label },
    { header: "Typ", width: 24, value: (row) => row.typeLabel },
    { header: "Název plochy", width: 38, value: (row) => row.surfaceName },
    { header: "Rozměr", width: 26, value: (row) => row.dimensionLabel },
    { header: "Ks", width: 10, value: (row) => String(row.quantity) },
    ...(viewModel.showViewColumn ? [{ header: "Pohled", width: viewColWidth, value: (row: PrintSurfaceExportViewModel["rows"][number]) => row.viewLabel }] : []),
    { header: "Poznámka", width: noteWidth, value: (row) => row.note },
    ...(viewModel.showPrices ? [{ header: "Cena", width: priceColWidth, value: (row: PrintSurfaceExportViewModel["rows"][number]) => row.priceLabel ?? "—" }] : []),
  ];

  let y = startY;
  const rowHeight = 6.5;

  function drawHeaderRow() {
    doc.setFillColor(244, 245, 246);
    doc.rect(x, y - 4.2, columns.reduce((sum, col) => sum + col.width, 0), rowHeight, "F");
    doc.setFont(FONT_FAMILY, "bold");
    doc.setFontSize(7.5);
    let colX = x;
    for (const column of columns) {
      doc.text(column.header, colX + 1, y);
      colX += column.width;
    }
    y += rowHeight;
  }

  drawHeaderRow();

  doc.setFont(FONT_FAMILY, "normal");
  doc.setFontSize(8);
  viewModel.rows.forEach((row, index) => {
    if (y + rowHeight > pageHeight - PAGE_MARGIN_MM) {
      doc.addPage();
      y = PAGE_MARGIN_MM;
      drawHeaderRow();
      doc.setFont(FONT_FAMILY, "normal");
      doc.setFontSize(8);
    }
    if (index % 2 === 1) {
      doc.setFillColor(250, 250, 250);
      doc.rect(x, y - 4.2, columns.reduce((sum, col) => sum + col.width, 0), rowHeight, "F");
    }
    let colX = x;
    for (const column of columns) {
      const text = column.value(row);
      const maxChars = Math.floor(column.width / 1.7);
      doc.text(text.length > maxChars ? `${text.slice(0, Math.max(0, maxChars - 1))}…` : text, colX + 1, y);
      colX += column.width;
    }
    y += rowHeight;
  });

  if (viewModel.showPrices) {
    y += 3;
    doc.setFont(FONT_FAMILY, "bold");
    doc.setFontSize(9);
    doc.text(`Cena tiskových ploch celkem: ${viewModel.totalPrice.toLocaleString("cs-CZ")} Kč`, x, y);
  }
}

/**
 * Header → metadata → summary → view images WITH marker pins (see module doc) → data table
 * (with a page break per overflowing row block, header re-drawn on each new page) → optional
 * price footer. A4 portrait, matching the existing print-preview HTML's orientation (this is
 * meant to look like the same document, just a real binary artifact). Never appends a page beyond
 * what the table itself needed — no trailing blank/instructions page.
 */
export async function buildPrintSurfacePdf(
  viewModel: PrintSurfaceExportViewModel,
  branding: PrintSurfacePdfBranding = {},
  viewImages: PrintSurfacePdfViewImages = new Map(),
): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait" }) as unknown as PdfDoc;
  registerCzechFont(doc);
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  let y = drawHeader(doc, viewModel, branding, pageWidth);
  y = drawMetadata(doc, viewModel, PAGE_MARGIN_MM, y);
  y = drawSummary(doc, viewModel, PAGE_MARGIN_MM, y, pageWidth);

  const imageBoxWidth = viewModel.images.length > 1 ? (pageWidth - PAGE_MARGIN_MM * 2 - 8) / 2 : pageWidth - PAGE_MARGIN_MM * 2;
  const imageBoxHeight = 55;
  let imageX = PAGE_MARGIN_MM;
  let rowBottom = y;
  viewModel.images.forEach((image, index) => {
    const { bottom, rect } = drawViewImage(doc, imageX, y, imageBoxWidth, imageBoxHeight, image.viewLabel, viewImages.get(image.viewId));
    drawViewMarkers(doc, image, rect);
    rowBottom = Math.max(rowBottom, bottom);
    imageX += imageBoxWidth + 8;
    if (viewModel.images.length > 1 && index % 2 === 1) {
      y = rowBottom;
      imageX = PAGE_MARGIN_MM;
    }
  });
  y = rowBottom + 2;

  if (y > pageHeight - PAGE_MARGIN_MM - 40) {
    doc.addPage();
    y = PAGE_MARGIN_MM;
  }

  drawTable(doc, viewModel, PAGE_MARGIN_MM, y + 5, pageWidth, pageHeight - 30);

  return new Uint8Array(doc.output("arraybuffer"));
}
