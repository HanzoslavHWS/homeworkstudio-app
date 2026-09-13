/**
 * Technické rastry — deterministic assignment engine (spec section 19; extended by the CORRECTIVE
 * BATCH below). Still NO AI, no broad fuzzy matching: a stand's normalizedStandNumber is looked up
 * against the raster's detected stand-number text labels via plain string equality FIRST — exact
 * match always wins, exactly as before this batch. Only once an EXACT match finds zero candidates
 * does a second, narrow, deliberate TOLERANT pass run (leading-zero equivalence only — see
 * domain/technicalStandNumberIdentity.ts's own doc for the exact scope and why it exists: real H3
 * production evidence where raster labels read "3A1" but imported rows read "3A01").
 *
 * Precedence (spec section 5, "matching precedence must remain conservative"):
 *   1. exact normalized textual match (found exactly once)      -> matched_auto, matchMethod "exact"
 *   2. exact match found MORE than once                          -> ambiguous (never falls through
 *      to the tolerant pass — an exact ambiguity is never "resolved" by a looser comparison)
 *   3. exact match found zero times, tolerant canonical match
 *      found exactly once                                        -> matched_auto, matchMethod
 *                                                                    "tolerant_normalized"
 *   4. tolerant canonical match found MORE than once              -> ambiguous (never guess which
 *      raster candidate the imported number "really" means)
 *   5. found zero times either way                                -> unassigned (the caller may
 *      still reclassify this as outsideCurrentRaster — that check happens entirely OUTSIDE this
 *      function, unaffected by this batch)
 */
import type { RasterStandLabel } from "./technicalRaster.ts";
import { standNumbersShareCanonicalIdentity } from "./technicalStandNumberIdentity.ts";

export type StandMatchMethod = "exact" | "tolerant_normalized";

export type StandMatchResult =
  | Readonly<{ status: "matched_auto"; label: RasterStandLabel; matchMethod: StandMatchMethod }>
  | Readonly<{ status: "unassigned" }>
  | Readonly<{ status: "ambiguous"; candidateLabels: readonly RasterStandLabel[] }>;

export function matchStandNumberToRasterLabels(standNumber: string, labels: readonly RasterStandLabel[]): StandMatchResult {
  const exactCandidates = labels.filter((label) => label.normalizedStandNumber === standNumber);
  if (exactCandidates.length === 1) return { status: "matched_auto", label: exactCandidates[0]!, matchMethod: "exact" };
  if (exactCandidates.length > 1) return { status: "ambiguous", candidateLabels: exactCandidates };

  // CORRECTIVE BATCH (real production, tolerant stand-number matching) — exact match found nothing;
  // try the narrow leading-zero-tolerant canonical identity before giving up. Deliberately a SEPARATE
  // pass (never merged into the exact filter above) so an exact match — however many candidates it
  // finds — always wins outright, per spec's own explicit precedence.
  const tolerantCandidates = labels.filter((label) => standNumbersShareCanonicalIdentity(label.normalizedStandNumber, standNumber));
  if (tolerantCandidates.length === 1) return { status: "matched_auto", label: tolerantCandidates[0]!, matchMethod: "tolerant_normalized" };
  if (tolerantCandidates.length > 1) return { status: "ambiguous", candidateLabels: tolerantCandidates };

  return { status: "unassigned" };
}
