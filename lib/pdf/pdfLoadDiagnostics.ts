/**
 * Technické rastry — structured diagnostic logging for a failed PDF raster load (spec batch 5, UI
 * section 17/18). The user-facing message must NEVER be the raw browser/pdf.js error string (spec
 * section 23 — a bare "Failed to fetch" reached the canvas UI directly, because the loading
 * effect's catch block did `loadError instanceof Error ? loadError.message : "…"`, which passes a
 * genuine network TypeError's own message straight through) — every caller that catches a PDF load
 * failure now shows a fixed Czech message and routes the real technical details through here
 * instead, into the normal server/dev console log, never the UI.
 */

export type PdfLoadPhase =
  /** TechnicalRasterCanvas.tsx's own document-loading effect — covers both a fresh mount (initial load / reopen project) and any later pdfUrl change (e.g. after a retry), since the effect body itself can't distinguish those without extra bookkeeping the caller can already provide via the OTHER, more specific phases below. */
  | "canvas_load"
  /** The owning page resolving project.sourceRasterAsset -> a download URL, BEFORE it ever reaches the canvas (e.g. TechnicalRasterEditorPage.tsx's own effect). */
  | "asset_url_resolve"
  /** A single, deliberate retry after a canvas_load failure: a fresh download URL was resolved and handed back to the canvas. */
  | "retry_after_url_refresh"
  /** Uploading/parsing a brand-new raster PDF to replace the project's current one. */
  | "replace_raster";

export type PdfLoadFailureInfo = Readonly<{
  url?: string;
  errorName: string;
  errorMessage: string;
}>;

/** Presigned download URLs carry their signature/token in the query string (see lib/storage/cloudflareR2.server.ts) — logging must never include it. Strips everything but origin+pathname. */
export function sanitizeUrlForLogging(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "(unparsable url)";
  }
}

export function toPdfLoadFailureInfo(error: unknown, url?: string): PdfLoadFailureInfo {
  return {
    url,
    errorName: error instanceof Error ? error.name : typeof error,
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

/**
 * `assetReference` is whatever the caller has on hand to identify the asset (StoredAsset.id, or a
 * storageKey) — optional because the canvas itself doesn't always know it (see
 * TechnicalRasterCanvas.tsx's own `assetReference` prop, threaded down from the page that owns the
 * project's sourceRasterAsset).
 */
export function logPdfLoadFailure(context: Readonly<{
  phase: PdfLoadPhase;
  assetReference?: string;
  url?: string;
  error: unknown;
}>): void {
  const info = toPdfLoadFailureInfo(context.error, context.url ? sanitizeUrlForLogging(context.url) : undefined);
  console.error("Technical raster PDF load failed", {
    operation: "loadPdfDocument",
    phase: context.phase,
    assetReference: context.assetReference,
    url: info.url,
    errorName: info.errorName,
    errorMessage: info.errorMessage,
  });
}
