/**
 * Technické rastry — corrective batch section 9/10: "realizační firma" (the construction/build
 * contractor working a given stand, parsed from a catalog report's own "R:" line — see section 8's
 * own doc for where that raw text ultimately comes from) grouped into a small, fixed set of
 * CANONICAL categories for this specific project, each with ONE central color — never scattered
 * hex literals or ad-hoc string comparisons across components (spec: "Barvy dej do central configu,
 * ne rozházené hardcode po komponentách" — the exact same discipline
 * domain/technicalRasterServicePresentation.ts already established for technical-symbol colors).
 *
 * Canonical groups (spec, this project's own real construction companies):
 *   GENDAI, CREATIV EXPO, MAC PRAHA — matched by alias, case/diacritic/legal-suffix insensitive.
 *   OSTATNÍ — every other real value (Elseya spol. s r.o., Agentura M-S-P, s.r.o., ...), an empty
 *   "R:" field, AND any future/unknown value this project hasn't seen yet — never a crash, never a
 *   5th silently-invented group.
 *
 * Deliberately NOT wired to any pricing/catalog product data (spec section 11: "ceny nepoužívat").
 */

export type TechnicalRealizationGroup = "gendai" | "creativExpo" | "macPraha" | "ostatni";

export type TechnicalRealizationGroupInfo = Readonly<{
  id: TechnicalRealizationGroup;
  label: string;
  /** Hex color — the ONE place any UI/export drawing code reads a realization color from. */
  color: string;
}>;

export const TECHNICAL_REALIZATION_GROUPS: readonly TechnicalRealizationGroupInfo[] = [
  { id: "gendai", label: "GENDAI", color: "#2f8f4e" },
  { id: "creativExpo", label: "CREATIV EXPO", color: "#d97a1f" },
  { id: "macPraha", label: "MAC PRAHA", color: "#2361c2" },
  { id: "ostatni", label: "OSTATNÍ", color: "#b3261e" },
];

export function technicalRealizationGroupInfo(group: TechnicalRealizationGroup): TechnicalRealizationGroupInfo {
  return TECHNICAL_REALIZATION_GROUPS.find((entry) => entry.id === group)!;
}

/** Strips diacritics/legal-form suffixes/punctuation/whitespace variance so "CREATIV EXPO, s.r.o." and "Creative Expo s.r.o." (spec's own two example spellings) normalize to the SAME comparable key — never a fragile exact-string match. */
function normalizeForMatching(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/\bs\.?\s*r\.?\s*o\.?\b/gu, "") // s.r.o. / s r o / spol s r o's trailing "s r o"
    .replace(/\bspol\.?\b/gu, "")
    .replace(/[^a-z0-9]+/gu, "");
}

/**
 * Alias lists deliberately spelled out (spec's own two "CREATIV EXPO" variants: "CREATIV EXPO,
 * s.r.o." and "Creative Expo s.r.o.", both normalizing to "creativexpo"/"creativeexpo" — kept as
 * TWO explicit aliases rather than a fuzzy-match heuristic, since a fuzzy match risks silently
 * merging two UNRELATED real companies, which is far worse than missing one spelling variant this
 * app hasn't seen yet — a genuinely new spelling still safely falls into OSTATNÍ, never crashes,
 * never guesses).
 */
const GENDAI_ALIASES = ["gendai"].map(normalizeForMatching);
const CREATIV_EXPO_ALIASES = ["creativ expo", "creative expo"].map(normalizeForMatching);
const MAC_PRAHA_ALIASES = ["mac praha"].map(normalizeForMatching);

/**
 * Resolves ANY real "R:" value (or its absence) to exactly one of the four canonical groups above
 * (spec section 9: "OSTATNÍ zahrnuje: Elseya spol. s r.o., Agentura M-S-P, s.r.o., prázdné R:,
 * neznámé další realization values" — i.e. genuinely everything not GENDAI/CREATIV EXPO/MAC PRAHA).
 * Never throws, never returns a 5th value — an unrecognized/empty/whitespace-only input is always
 * OSTATNÍ, exactly like `resolveTechnicalServicePresentation`'s own "never guess, always resolve to
 * something" discipline.
 */
export function resolveTechnicalRealizationGroup(rawRealizationCompany: string | undefined): TechnicalRealizationGroup {
  const trimmed = (rawRealizationCompany ?? "").trim();
  if (!trimmed) return "ostatni";
  const normalized = normalizeForMatching(trimmed);
  if (GENDAI_ALIASES.some((alias) => normalized === alias)) return "gendai";
  if (CREATIV_EXPO_ALIASES.some((alias) => normalized === alias)) return "creativExpo";
  if (MAC_PRAHA_ALIASES.some((alias) => normalized === alias)) return "macPraha";
  return "ostatni";
}

// ============================================================================
// Display gating (corrective batch — realization domain model fix). Deliberately layered ON TOP
// of resolveTechnicalRealizationGroup above, never inside it: the color/grouping resolver stays
// exactly as-is (already correct, already working per real R: values — untouched by this batch).
// What changes is WHETHER a realization indicator is drawn at all, which depends on a fact the
// resolver itself has no way to know: whether this stand has a REAL confirmed ABF catalog build
// record (domain/technicalRaster.ts's own TechnicalStand.hasCatalogBuildRecord) — never inferred
// from realizationCompany being present/absent alone. See TechnicalStand.hasCatalogBuildRecord's
// own doc for the full three-state rationale (known group / OSTATNÍ / no indicator at all).
// ============================================================================

export type RealizationDisplayState =
  | Readonly<{ shouldShow: false }>
  | Readonly<{ shouldShow: true; group: TechnicalRealizationGroup }>;

/**
 * The ONE place editor/export overlay-building code decides "does this stand get a realization
 * indicator, and if so which color" — never re-derived ad hoc at each call site. `hasCatalogBuildRecord`
 * falsy (including undefined, e.g. a stand that only ever appeared in a primary technical-service
 * report and was never mentioned by the supplemental catalog) always means `shouldShow: false`,
 * regardless of whatever `realizationCompanyRaw` happens to hold.
 */
export function resolveRealizationDisplayState(hasCatalogBuildRecord: boolean | undefined, realizationCompanyRaw: string | undefined): RealizationDisplayState {
  if (!hasCatalogBuildRecord) return { shouldShow: false };
  return { shouldShow: true, group: resolveTechnicalRealizationGroup(realizationCompanyRaw) };
}
