/**
 * Visualization v2 — the customer-facing presentation PDF: one big render per page plus a
 * compact project/event/company header, deliberately excluding any pricing (that's the separate
 * customer calculation document). Reuses the EXACT SAME embedded Unicode Czech font as Graphics
 * Production Package v1's manifest.pdf (lib/pdf/czechFont.ts) — never a second font embed.
 */
import type { GraphicsProductionPreparedBy } from "../domain/graphicsProduction.ts";
import { FONT_FAMILY, registerCzechFont, type PdfDoc } from "./pdf/czechFont.ts";

const PAGE_MARGIN_MM = 15;
const HEADER_LINE_HEIGHT_MM = 5;
const CAPTION_HEIGHT_MM = 8;

export type PresentationPdfBranding = Readonly<{
  companyBrand?: string;
  /**
   * Pre-resolved data URL, EXTERNAL to this module — same externalization principle
   * graphicsProductionPdf.ts's `thumbnails` map already uses. Rendered only when present;
   * absent falls back to a clean text-only header, never a fabricated placeholder logo.
   */
  logoDataUrl?: string;
}>;

export type PresentationPdfMetadata = Readonly<{
  project: Readonly<{ name: string; company: string }>;
  event: Readonly<{ name: string; venue?: string; dateRange?: string }>;
  booth: Readonly<{ name: string; boothNumber?: string }>;
  branding?: PresentationPdfBranding;
  /** Reused verbatim from Graphics Production Package v1 — no user/auth system exists in this app, so this stays optional/manually-entered, never invented, never rendered as an empty block. */
  preparedBy?: GraphicsProductionPreparedBy;
  generatedAt: string;
  // Deliberately NO pricing-shaped field anywhere in this type graph — this document is
  // presentation-only (report section 20); the customer calculation is a separate document.
}>;

export type PresentationPdfRenderPage = Readonly<{
  visualizationId: string;
  name: string;
  imageDataUrl: string;
  widthPx: number;
  heightPx: number;
  format: "png" | "jpeg";
}>;

function imageFormatForRender(format: "png" | "jpeg"): string {
  return format === "png" ? "PNG" : "JPEG";
}

export type PresentationHeaderLines = Readonly<{
  brandTitle: string;
  eventLine: string;
  companyLine: string;
  boothLine: string;
  /** "<date>" or "<date> · Zpracoval: <name>" — the preparedBy segment is OMITTED ENTIRELY (never an empty "Zpracoval:" fragment) when preparedBy?.name is absent. */
  dateLine: string;
}>;

/**
 * Pure line-formatting extracted from the PDF drawing code so "preparedBy omitted when absent"
 * and the metadata-to-text mapping are directly unit-testable without parsing PDF binary output.
 */
export function buildPresentationHeaderLines(metadata: PresentationPdfMetadata): PresentationHeaderLines {
  const eventLine = [metadata.event.name, metadata.event.venue].filter(Boolean).join(" · ");
  const boothLine = [metadata.project.name, metadata.booth.name].filter(Boolean).join(" · ");
  const dateLabel = new Date(metadata.generatedAt).toLocaleDateString("cs-CZ");
  const preparedSegment = metadata.preparedBy?.name ? ` · Zpracoval: ${metadata.preparedBy.name}` : "";
  return {
    brandTitle: metadata.branding?.companyBrand || "HOMEWORK STUDIO",
    eventLine: `FOR ${eventLine || "—"}`,
    companyLine: metadata.project.company || "—",
    boothLine: boothLine || "—",
    dateLine: `${dateLabel}${preparedSegment}`,
  };
}

function drawHeader(doc: PdfDoc, metadata: PresentationPdfMetadata, pageWidth: number): number {
  let y = PAGE_MARGIN_MM;
  const hasLogo = Boolean(metadata.branding?.logoDataUrl);
  const textX = hasLogo ? PAGE_MARGIN_MM + 26 : PAGE_MARGIN_MM;
  const lines = buildPresentationHeaderLines(metadata);

  if (hasLogo) {
    try {
      doc.addImage(metadata.branding!.logoDataUrl!, "PNG", PAGE_MARGIN_MM, y, 22, 14);
    } catch {
      // A broken/unresolvable logo data URL never blocks the document — falls back to text-only.
    }
  }

  doc.setFont(FONT_FAMILY, "bold");
  doc.setFontSize(14);
  doc.text(lines.brandTitle, textX, y + 5);

  doc.setFont(FONT_FAMILY, "normal");
  doc.setFontSize(10);
  doc.text(lines.eventLine, textX, y + 11);
  doc.text(lines.companyLine, textX, y + 11 + HEADER_LINE_HEIGHT_MM);
  doc.text(lines.boothLine, textX, y + 11 + HEADER_LINE_HEIGHT_MM * 2);

  y += 11 + HEADER_LINE_HEIGHT_MM * 2 + 3;

  doc.setFontSize(8);
  doc.setDrawColor(120, 120, 120);
  doc.text(lines.dateLine, textX, y);
  y += 4;

  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.2);
  doc.line(PAGE_MARGIN_MM, y, pageWidth - PAGE_MARGIN_MM, y);
  return y + 6;
}

/**
 * Report sections 15-20: one page per selected render, in the caller's exact selection order
 * (never re-sorted here — the UI's ordered-array selection state IS the page order). Every image
 * is scaled to CONTAIN within the remaining page area, preserving aspect ratio — never
 * cropped/stretched/distorted for a customer-facing document.
 */
export async function buildPresentationPdf(
  pages: readonly PresentationPdfRenderPage[],
  metadata: PresentationPdfMetadata,
): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  // Landscape, not portrait: every customer render is landscape-oriented (a booth is always
  // wider than tall), and a portrait page leaves large empty vertical bands around a
  // contain-fitted landscape image — directly conflicting with "renders should not look small".
  // All layout math below reads pageWidth/pageHeight from the API rather than hardcoding either
  // orientation's dimensions, so this is the only line that needed to change.
  const doc = new jsPDF({ unit: "mm", format: "a4", orientation: "landscape" }) as unknown as PdfDoc;
  registerCzechFont(doc);
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  pages.forEach((page, index) => {
    if (index > 0) doc.addPage();
    const contentTop = drawHeader(doc, metadata, pageWidth);
    const availableWidth = pageWidth - PAGE_MARGIN_MM * 2;
    const availableHeight = pageHeight - contentTop - PAGE_MARGIN_MM - CAPTION_HEIGHT_MM;
    const imageAspect = page.widthPx / page.heightPx;
    const boxAspect = availableWidth / availableHeight;
    const { drawWidth, drawHeight } = imageAspect > boxAspect
      ? { drawWidth: availableWidth, drawHeight: availableWidth / imageAspect }
      : { drawWidth: availableHeight * imageAspect, drawHeight: availableHeight };
    const drawX = PAGE_MARGIN_MM + (availableWidth - drawWidth) / 2;
    const drawY = contentTop + (availableHeight - drawHeight) / 2;
    doc.addImage(page.imageDataUrl, imageFormatForRender(page.format), drawX, drawY, drawWidth, drawHeight);

    doc.setFont(FONT_FAMILY, "normal");
    doc.setFontSize(10);
    doc.text(page.name, pageWidth / 2, contentTop + availableHeight + CAPTION_HEIGHT_MM - 2, { align: "center" });
  });

  return new Uint8Array(doc.output("arraybuffer"));
}
