/**
 * The exact box each view's photo is drawn into inside the A4 "Tiskový přehled" PDF (spec: 1 view
 * dominant, 2 landscape/mixed views side-by-side, 2 portrait views stacked full-width) — pure
 * geometry, no jsPDF/DOM dependency, so it's shared by lib/printSurfacePdf.ts (which draws the
 * image at this size) and PrintSurfaceExportPanel.tsx's image-optimization step (which sizes/
 * compresses the embedded JPEG to match exactly what will actually be rendered — never more, never
 * less). Kept in ONE place so the two can never quietly disagree about how large a view's image
 * ends up on the page — see lib/printSurfacePdf.ts's own PAGE_MARGIN_MM (14mm), which this mirrors.
 */

/** A4 portrait page width in mm — this module (and the PDF it describes) is A4-only. */
export const PRINT_SURFACE_PDF_PAGE_WIDTH_MM = 210;
/** Must match lib/printSurfacePdf.ts's own PAGE_MARGIN_MM constant. */
export const PRINT_SURFACE_PDF_PAGE_MARGIN_MM = 14;
export const PRINT_SURFACE_PDF_USABLE_WIDTH_MM = PRINT_SURFACE_PDF_PAGE_WIDTH_MM - PRINT_SURFACE_PDF_PAGE_MARGIN_MM * 2;
/** Horizontal gap between the two side-by-side columns when 2 non-portrait views are laid out. */
export const PRINT_SURFACE_PDF_TWO_VIEW_GAP_MM = 8;

export type PrintSurfaceViewRenderBox = Readonly<{ widthMm: number; heightMm: number }>;

/**
 * viewCount <= 1: one dominant box, near-full page width, 108mm tall.
 * viewCount 2, both portrait (by ORIGINAL aspect ratio — unaffected by later downscaling, which
 * always preserves aspect ratio, so this decision is safe to make before or after resizing):
 * stacked, full width, 78mm tall each.
 * viewCount 2, otherwise: side-by-side half-width columns, 82mm tall each.
 */
export function resolvePrintSurfaceViewRenderBox(viewCount: number, bothPortrait: boolean): PrintSurfaceViewRenderBox {
  if (viewCount <= 1) return { widthMm: PRINT_SURFACE_PDF_USABLE_WIDTH_MM, heightMm: 108 };
  if (bothPortrait) return { widthMm: PRINT_SURFACE_PDF_USABLE_WIDTH_MM, heightMm: 78 };
  return { widthMm: (PRINT_SURFACE_PDF_USABLE_WIDTH_MM - PRINT_SURFACE_PDF_TWO_VIEW_GAP_MM) / 2, heightMm: 82 };
}

/**
 * The header's event-logo box (lib/printSurfacePdf.ts's drawHeader draws the logo at exactly this
 * size, regardless of the source image's own aspect ratio — jsPDF's addImage always stretches to
 * the given w/h). Shared with the image-optimization step (PrintSurfaceExportPanel.tsx) so a
 * downscaled logo is always sized to exactly what actually gets drawn, never more.
 */
export const PRINT_SURFACE_PDF_EVENT_LOGO_WIDTH_MM = 34;
export const PRINT_SURFACE_PDF_EVENT_LOGO_HEIGHT_MM = 20;
