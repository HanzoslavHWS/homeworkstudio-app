/**
 * Graphics Production Package v1 — human-readable manifest.pdf, generated programmatically via
 * jsPDF (the first document-generation dependency in this codebase; the app's only prior "PDF
 * export" was the browser's native print-to-PDF dialog, which can't be bundled into an automated
 * ZIP build). Deliberately simple/functional layout only (report section 30 — no visual
 * redesign): title, header metadata, one section per manifest surface. jsPDF is imported
 * dynamically so its ~200KB never lands in the app's initial bundle — only loaded when a user
 * actually builds a production package.
 *
 * Thumbnails are resolved OUTSIDE this function (the `thumbnails` map, keyed by printSurfaceId,
 * pre-resolved data URLs) so this layout code stays testable (magic-bytes/length assertions)
 * without network access — see lib/graphicsProductionPackage.ts for how the map gets built.
 */
import type { ArtworkPlacement } from "../domain/project.ts";
import type { GraphicsProductionManifest, GraphicsProductionManifestSurface } from "../domain/graphicsProduction.ts";
import { isRasterArtworkFile } from "./printArtworkOverlays.ts";
import { NOTO_SANS_CZECH_BOLD_BASE64, NOTO_SANS_CZECH_REGULAR_BASE64 } from "./fonts/graphicsProductionFont.ts";

const FONT_FAMILY = "NotoSansCzech";

const PAGE_MARGIN_MM = 15;
const THUMBNAIL_BOX_MM = 22;
const TEXT_START_X_MM = PAGE_MARGIN_MM + THUMBNAIL_BOX_MM + 6;
const LINE_HEIGHT_MM = 5.2;
const SECTION_GAP_MM = 6;

function formatArtworkPlacementSummary(placement: ArtworkPlacement | undefined): string {
  if (!placement) return "Stretch · 100 % · X 0 mm · Y 0 mm";
  const modeLabel = placement.mode === "stretch" ? "Stretch" : placement.mode === "fit" ? "Fit" : "Fill";
  return `${modeLabel} · ${Math.round(placement.scale * 100)} % · X ${placement.offsetXmm} mm · Y ${placement.offsetYmm} mm`;
}

function extensionUpper(fileName: string): string {
  const match = /\.([a-z0-9]+)$/iu.exec(fileName);
  return match ? match[1]!.toUpperCase() : "SOUBOR";
}

type PdfDoc = Readonly<{
  setFont: (name: string, style?: string) => void;
  setFontSize: (size: number) => number;
  text: (text: string | string[], x: number, y: number, options?: Readonly<{ align?: "left" | "center" | "right" }>) => void;
  setDrawColor: (r: number, g: number, b: number) => void;
  setLineWidth: (width: number) => void;
  rect: (x: number, y: number, w: number, h: number) => void;
  line: (x1: number, y1: number, x2: number, y2: number) => void;
  addImage: (imageData: string, format: string, x: number, y: number, w: number, h: number) => void;
  addPage: () => void;
  addFileToVFS: (fileName: string, base64: string) => void;
  addFont: (fileName: string, fontName: string, style: string) => void;
  internal: { pageSize: { getWidth: () => number; getHeight: () => number } };
  output: (type: "arraybuffer") => ArrayBuffer;
}>;

/**
 * jsPDF's built-in Helvetica/Times/Courier fonts only support WinAnsi encoding — no
 * č/ř/ě/ů/š/ž/etc. — which garbled every Czech line in this Czech-first document (confirmed by
 * generating and visually inspecting a real manifest.pdf during implementation). Embeds a real
 * Unicode font instead (see lib/fonts/graphicsProductionFont.ts for the subset/license details).
 */
function registerCzechFont(doc: PdfDoc): void {
  doc.addFileToVFS("NotoSansCzech-Regular.ttf", NOTO_SANS_CZECH_REGULAR_BASE64);
  doc.addFont("NotoSansCzech-Regular.ttf", FONT_FAMILY, "normal");
  doc.addFileToVFS("NotoSansCzech-Bold.ttf", NOTO_SANS_CZECH_BOLD_BASE64);
  doc.addFont("NotoSansCzech-Bold.ttf", FONT_FAMILY, "bold");
}

function imageFormatForMimeType(mimeType: string): string | undefined {
  const type = mimeType.toLowerCase();
  if (type === "image/png") return "PNG";
  if (type === "image/jpeg" || type === "image/jpg") return "JPEG";
  if (type === "image/webp") return "WEBP";
  return undefined;
}

function drawThumbnailOrPlaceholder(doc: PdfDoc, surface: GraphicsProductionManifestSurface, x: number, y: number, thumbnailDataUrl: string | undefined): void {
  const isRaster = isRasterArtworkFile({ mimeType: surface.mimeType, name: surface.exportFileName });
  if (isRaster && thumbnailDataUrl) {
    const format = imageFormatForMimeType(surface.mimeType);
    if (format) {
      try {
        doc.addImage(thumbnailDataUrl, format, x, y, THUMBNAIL_BOX_MM, THUMBNAIL_BOX_MM);
        return;
      } catch {
        // Falls through to the placeholder box below — a thumbnail failure never breaks the PDF.
      }
    }
  }
  doc.setDrawColor(160, 160, 160);
  doc.setLineWidth(0.2);
  doc.rect(x, y, THUMBNAIL_BOX_MM, THUMBNAIL_BOX_MM);
  doc.setFontSize(8);
  doc.text(extensionUpper(surface.exportFileName), x + THUMBNAIL_BOX_MM / 2, y + THUMBNAIL_BOX_MM / 2, { align: "center" });
}

function headerLine(doc: PdfDoc, label: string, value: string, x: number, y: number): void {
  doc.setFont(FONT_FAMILY, "bold");
  doc.text(`${label}:`, x, y);
  doc.setFont(FONT_FAMILY, "normal");
  doc.text(value, x + 28, y);
}

/**
 * Report section 12: title, header block (Projekt/Firma/Akce/Realizace/Datum, + Revize/Zpracoval
 * only when present — never an empty "Zpracoval:" line), then one section per surface (filename,
 * production dims, canonical dims only when they differ from production — mirrors
 * GraphicsExportPanel.tsx's DimensionFigure hasAllowance check — bleed only when nonzero,
 * placement, thumbnail or a bordered extension placeholder for non-raster sources).
 */
export async function buildGraphicsProductionManifestPdf(
  manifest: GraphicsProductionManifest,
  thumbnails: ReadonlyMap<string, string> = new Map(),
): Promise<Uint8Array> {
  const { jsPDF } = await import("jspdf");
  const doc = new jsPDF({ unit: "mm", format: "a4" }) as unknown as PdfDoc;
  registerCzechFont(doc);
  const pageWidth = doc.internal.pageSize.getWidth();
  const pageHeight = doc.internal.pageSize.getHeight();

  let y = PAGE_MARGIN_MM;
  doc.setFont(FONT_FAMILY, "bold");
  doc.setFontSize(18);
  doc.text("PRODUKČNÍ DATA GRAFIKY", PAGE_MARGIN_MM, y);
  y += 8;
  doc.setDrawColor(0, 0, 0);
  doc.setLineWidth(0.4);
  doc.line(PAGE_MARGIN_MM, y, pageWidth - PAGE_MARGIN_MM, y);
  y += 7;

  doc.setFontSize(10);
  headerLine(doc, "Projekt", manifest.project.name || "—", PAGE_MARGIN_MM, y); y += LINE_HEIGHT_MM;
  headerLine(doc, "Firma", manifest.project.company || "—", PAGE_MARGIN_MM, y); y += LINE_HEIGHT_MM;
  headerLine(doc, "Akce", manifest.event.name || "—", PAGE_MARGIN_MM, y); y += LINE_HEIGHT_MM;
  headerLine(doc, "Realizace", manifest.realization.label || "—", PAGE_MARGIN_MM, y); y += LINE_HEIGHT_MM;
  headerLine(doc, "Datum", new Date(manifest.generatedAt).toLocaleDateString("cs-CZ"), PAGE_MARGIN_MM, y); y += LINE_HEIGHT_MM;
  if (manifest.revision !== undefined && manifest.revision !== "") {
    headerLine(doc, "Revize", String(manifest.revision), PAGE_MARGIN_MM, y); y += LINE_HEIGHT_MM;
  }
  if (manifest.preparedBy?.name) {
    const contact = [manifest.preparedBy.email, manifest.preparedBy.phone].filter(Boolean).join(" · ");
    headerLine(doc, "Zpracoval", contact ? `${manifest.preparedBy.name} (${contact})` : manifest.preparedBy.name, PAGE_MARGIN_MM, y); y += LINE_HEIGHT_MM;
  }

  y += 2;
  doc.setDrawColor(200, 200, 200);
  doc.setLineWidth(0.2);
  doc.line(PAGE_MARGIN_MM, y, pageWidth - PAGE_MARGIN_MM, y);
  y += SECTION_GAP_MM;

  for (const surface of manifest.surfaces) {
    const hasAllowance = surface.productionWidthMm !== surface.canonicalWidthMm || surface.productionHeightMm !== surface.canonicalHeightMm;
    const hasBleed = surface.bleedLeftMm || surface.bleedRightMm || surface.bleedTopMm || surface.bleedBottomMm;
    const lineCount = 2 + (hasAllowance ? 1 : 0) + (hasBleed ? 1 : 0) + 1; // filename + production dims (+canonical) (+bleed) + placement
    const sectionHeight = Math.max(THUMBNAIL_BOX_MM, lineCount * LINE_HEIGHT_MM) + SECTION_GAP_MM;
    if (y + sectionHeight > pageHeight - PAGE_MARGIN_MM) {
      doc.addPage();
      y = PAGE_MARGIN_MM;
    }

    drawThumbnailOrPlaceholder(doc, surface, PAGE_MARGIN_MM, y, thumbnails.get(surface.printSurfaceId));

    let textY = y + 4;
    doc.setFontSize(11);
    doc.setFont(FONT_FAMILY, "bold");
    doc.text(surface.displayName, TEXT_START_X_MM, textY);
    textY += LINE_HEIGHT_MM;

    doc.setFontSize(9);
    doc.setFont(FONT_FAMILY, "normal");
    doc.text(`Soubor: ${surface.exportFileName}`, TEXT_START_X_MM, textY); textY += LINE_HEIGHT_MM;
    doc.text(`Data dodat (výrobní rozměr): ${surface.productionWidthMm} × ${surface.productionHeightMm} mm`, TEXT_START_X_MM, textY); textY += LINE_HEIGHT_MM;
    if (hasAllowance) {
      doc.text(`Pohledová plocha: ${surface.canonicalWidthMm} × ${surface.canonicalHeightMm} mm`, TEXT_START_X_MM, textY); textY += LINE_HEIGHT_MM;
    }
    if (hasBleed) {
      doc.text(`Přesahy: L${surface.bleedLeftMm} / P${surface.bleedRightMm} / H${surface.bleedTopMm} / D${surface.bleedBottomMm} mm`, TEXT_START_X_MM, textY); textY += LINE_HEIGHT_MM;
    }
    doc.text(`Umístění (referenční): ${formatArtworkPlacementSummary(surface.artworkPlacement)}`, TEXT_START_X_MM, textY); textY += LINE_HEIGHT_MM;

    y += sectionHeight;
  }

  return new Uint8Array(doc.output("arraybuffer"));
}
