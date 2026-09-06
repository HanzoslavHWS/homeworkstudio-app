/**
 * Tiskové plochy — the expected SHAPE of one row from the future Excel import (realizačka, ID
 * plochy, název plochy, šířka mm, výška mm, poznámka), already parsed into typed fields. This is
 * only a DTO to map INTO once the real spreadsheet is available — it deliberately does not assume
 * anything about actual column names/order, and there is no XLSX parser here yet (spec section 10:
 * "Parsing XLSX uděláme až podle skutečného souboru").
 *
 * `realizationCompanyName` / `surfaceId` / `surfaceName` are carried as raw, as-imported text —
 * NOT yet resolved to our internal RealizationCompany.id / PrintSurfacePreset.id. That mapping
 * (matching an Excel row to our stable ids, deciding what happens on no-match, etc.) is a decision
 * for the real import step, not this phase.
 */
export type PrintSurfaceDimensionImportRow = Readonly<{
  realizationCompanyName: string;
  surfaceId: string;
  surfaceName: string;
  widthMm: number;
  heightMm: number;
  note?: string;
}>;
