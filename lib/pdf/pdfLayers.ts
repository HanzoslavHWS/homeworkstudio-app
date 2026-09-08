"use client";

/**
 * Technické rastry — reads the real PDF Optional Content Groups (layers) a raster PDF may carry
 * (spec section 5). Never guesses/hardcodes layer names — if the PDF has no OCG structure at all,
 * `listPdfLayers` returns an empty array and the app must render normally (spec: "aplikace nesmí
 * spadnout").
 */
import type { PdfJsDocument, PdfJsOptionalContentConfig } from "./pdfDocumentLoader.ts";
import type { RasterLayer } from "../../domain/technicalRaster.ts";

export async function listPdfLayers(document: PdfJsDocument): Promise<readonly RasterLayer[]> {
  try {
    const config = await document.getOptionalContentConfig();
    const order = config.getOrder();
    if (!order || order.length === 0) return [];
    const layers: RasterLayer[] = [];
    for (const id of order) {
      const group = config.getGroup(id);
      if (!group) continue;
      layers.push({ id, name: group.name ?? id, defaultVisible: config.isVisible(id) });
    }
    return layers;
  } catch {
    // A PDF with no/unsupported OCG structure must never crash the raster step — see the module doc.
    return [];
  }
}

/** Builds an optionalContentConfigPromise pre-configured with the project's own effective layer visibility (domain/technicalRaster.ts's effectiveHiddenLayerIds) — passed into page.render() so pdf.js itself skips drawing hidden layers (never a raster/content-stream hack). */
export async function buildOptionalContentConfigForRender(
  document: PdfJsDocument,
  hiddenLayerIds: ReadonlySet<string>,
): Promise<PdfJsOptionalContentConfig | undefined> {
  try {
    const config = await document.getOptionalContentConfig();
    for (const layerId of hiddenLayerIds) config.setVisibility(layerId, false);
    return config;
  } catch {
    return undefined;
  }
}
