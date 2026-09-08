"use client";

/**
 * Technické rastry — turns a loaded pdf.js document into this feature's own PdfTextItem[]
 * (domain/technicalReportTableParsing.ts), the ONLY translation this adapter does — all real
 * parsing/table-reconstruction logic lives in the pure domain layer, never here.
 */
import type { PdfJsDocument } from "./pdfDocumentLoader.ts";
import type { PdfTextItem } from "../../domain/technicalReportTableParsing.ts";

/** Extracts every text run on every page as page-coordinate-space items (pdf.js's own convention: origin bottom-left, y grows upward — see PdfTextItem's own doc). */
export async function extractPdfTextItems(document: PdfJsDocument): Promise<readonly PdfTextItem[]> {
  const items: PdfTextItem[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (!item.str.trim()) continue;
      items.push({
        str: item.str,
        page: pageNumber,
        x: item.transform[4],
        y: item.transform[5],
        width: item.width,
        height: item.height || Math.abs(item.transform[3]),
      });
    }
  }
  return items;
}

/** A page's own point dimensions (unscaled, scale: 1) — needed to normalize any x/y into the 0-1 space domain/technicalRaster.ts's RasterStandLabel/StandPlacement store (spec section 35: never raw CSS pixels). */
export type PdfPageSize = Readonly<{
  widthPt: number;
  heightPt: number;
  /** pdf.js's own viewport transform for this page at scale 1 — already encodes rotation (see PdfJsViewport's own doc); lib/pdf/rasterStandLabelDetection.ts uses this to keep a rotated page's stand-label positions correct. */
  transform: readonly [number, number, number, number, number, number];
}>;

export async function getPdfPageSizes(document: PdfJsDocument): Promise<ReadonlyMap<number, PdfPageSize>> {
  const sizes = new Map<number, PdfPageSize>();
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const page = await document.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1 });
    sizes.set(pageNumber, { widthPt: viewport.width, heightPt: viewport.height, transform: viewport.transform });
  }
  return sizes;
}
