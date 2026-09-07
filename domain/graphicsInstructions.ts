/**
 * Print Surfaces V5 (spec section 7) — "Pokyny pro přípravu grafiky" block. Deliberately NOT a
 * new column on RealizationCompany (domain/realizationCompany.ts): that entity is fully replaced
 * on every catalog Excel re-import (see replaceAll in domain/printSurfaceExcelImport.ts's
 * caller) — bolting hand-curated long-form text onto a row that gets wiped on the next import
 * would silently lose it. Instead this is a resolver function, structured so a future per-company
 * lookup (graphicsInstructions/graphicsInstructionsEn/graphicsGuideFile — spec's own suggested
 * field names) can replace the constant fallback below without any call site changing: every
 * caller already passes the realizationCompany in, they just don't get anything company-specific
 * back yet, exactly as the spec allows ("nemusíš teď naplňovat fiktivní texty pro všechny
 * realizačky").
 */
import type { RealizationCompany } from "./realizationCompany.ts";

export type GraphicsInstructions = Readonly<{
  cs: string;
  en: string;
}>;

const GENERIC_GRAPHICS_INSTRUCTIONS: GraphicsInstructions = {
  cs: "Uvedené rozměry jsou VÝROBNÍ rozměry tiskové plochy — grafiku připravujte přesně na tento rozměr, včetně bezpečného odstupu textů a log minimálně 20 mm od každého okraje. Konkrétní technické podmínky (formát souboru, barevný profil, spadávka) se řídí požadavky zvolené realizační firmy.",
  en: "The listed dimensions are the PRODUCTION dimensions of the print surface — prepare artwork exactly to this size, keeping text and logos at least 20 mm from every edge as a safety margin. Exact technical requirements (file format, color profile, bleed) follow the selected realization company's specification.",
};

/**
 * Always returns the safe generic text today, regardless of which company is passed — see the
 * module doc. Kept as a real function (not an inline constant in the export/panel code) so the
 * export view model and any future admin UI read from exactly one place.
 */
export function resolveGraphicsInstructions(
  _realizationCompany: Pick<RealizationCompany, "id" | "name"> | undefined,
): GraphicsInstructions {
  return GENERIC_GRAPHICS_INSTRUCTIONS;
}
