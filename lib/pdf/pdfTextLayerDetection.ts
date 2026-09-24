"use client";

/**
 * Technické rastry — PRODUCTION BATCH, PART A: browser-only pdf.js adapter for
 * domain/technicalRasterTextLayerDetection.ts's own pure algorithm. Reads every page's real
 * operator list (the SAME read-only `page.getOperatorList()` mechanism lib/pdf/technicalRasterWhiteRender.ts
 * already uses for a completely different analysis) and unions which OCG (marked-content group) ids
 * contain at least one real text-showing operator, across the WHOLE document — a raster's own OCG
 * definitions apply document-wide, so a layer whose only text happens to sit on page 2 must still be
 * offered the text-scale control.
 */
import type { PdfJsDocument } from "./pdfDocumentLoader.ts";
import { detectOcgIdsContainingText, type TextLayerDetectionOpCodes } from "../../domain/technicalRasterTextLayerDetection.ts";

let opCodesPromise: Promise<TextLayerDetectionOpCodes> | undefined;

async function getTextLayerDetectionOpCodes(): Promise<TextLayerDetectionOpCodes> {
  opCodesPromise ??= import("pdfjs-dist").then((pdfjsModule) => {
    const OPS = (pdfjsModule as unknown as { OPS: Record<string, number> }).OPS;
    // pdf.js exposes more than one text-showing op depending on how the source PDF encodes spacing
    // (`Tj` vs `TJ`) — every one found in this pinned version's own OPS table is included; a future
    // pdfjs-dist upgrade that renames/removes one simply drops out of the Set, never a crash.
    const showTextOps = [OPS.showText, OPS.showSpacedText].filter((code): code is number => typeof code === "number");
    return {
      beginMarkedContentProps: OPS.beginMarkedContentProps,
      beginMarkedContent: OPS.beginMarkedContent,
      endMarkedContent: OPS.endMarkedContent,
      showTextOps: new Set(showTextOps),
    } satisfies TextLayerDetectionOpCodes;
  });
  return opCodesPromise;
}

/** Returns every OCG (marked-content group) id, across ALL pages of `document`, that contains at least one real PDF text-showing operator — never throws (a page whose operator list can't be read for any reason simply contributes nothing, same "never crash the raster step" discipline as lib/pdf/pdfLayers.ts's own listPdfLayers). */
export async function detectPdfLayersWithText(document: PdfJsDocument): Promise<ReadonlySet<string>> {
  const opCodes = await getTextLayerDetectionOpCodes();
  const result = new Set<string>();
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    try {
      const page = await document.getPage(pageNumber);
      const operatorList = await page.getOperatorList({ intent: "display" });
      for (const id of detectOcgIdsContainingText(operatorList, opCodes)) result.add(id);
    } catch {
      // A single unreadable page must never abort text-layer detection for the whole document.
      continue;
    }
  }
  return result;
}
