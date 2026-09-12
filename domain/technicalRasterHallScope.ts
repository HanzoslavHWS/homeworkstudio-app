/**
 * Technické rastry — corrective batch (multi-hall imports): the ONE central place that decides
 * whether an imported stand number is confidently OUTSIDE the current raster project's own hall,
 * confidently part of it, or genuinely impossible to tell — never scattered prefix checks across
 * parsers/components (spec: "I do not want one rule in electricity parser, another in catalog
 * parser, and a third in UI").
 *
 * REAL-WORLD PROBLEM this fixes: ABF sometimes exports ONE technical-service report that mixes rows
 * from several halls (e.g. an electricity report with 50 Hala 3 rows and 50 Hala 4 rows). Before
 * this module, every row unconditionally became a `TechnicalStand` and went through ordinary exact
 * matching — a Hala 4 stand number that (correctly) never matches the Hala 3 raster ended up
 * indistinguishable from a genuine typo/problem: same "unassigned" bucket, same "Nespárováno" pile,
 * same placement-work-queue noise, same export warning. Fifty legitimate foreign-hall rows looked
 * exactly like fifty unresolved errors.
 *
 * THE FIX is deliberately conservative (spec: "Do NOT hide real typos by blindly categorizing every
 * unknown stand as out-of-raster... Do not use fuzzy guessing"): this project's own real stand-number
 * convention already encodes hall identity as a LEADING DIGIT RUN (domain/technicalStandNumber.ts's
 * own `standNumberParts` already splits exactly this way for natural sort) — "3A01"/"3B10" both
 * start with "3", a different hall's "4A05" starts with "4". `classifyStandScope` derives the
 * CURRENT raster's own hall prefix ONLY when every one of its OWN detected stand labels agrees on
 * one — never hardcoded to "Hall 1/2/3/4", never inferred from a single ambiguous sample. When that
 * prefix cannot be derived reliably (no raster labels yet, labels don't share a digit prefix at all,
 * e.g. "A01"/"A02"), or the imported number itself has no leading digit run, this returns "unknown"
 * and the caller falls straight back to today's ordinary unmatched/ambiguous behavior — a real typo
 * within the current hall's own namespace (e.g. "3A99" against a "3A01/3A02" raster) is NEVER
 * reclassified as "outside" merely because it fails to match; it stays "currentRaster" scope here,
 * exactly the same as a stand that just hasn't been detected/placed yet.
 */
import { normalizeStandNumber } from "./technicalStandNumber.ts";

export type StandScopeClassification = "currentRaster" | "outsideCurrentRaster" | "unknown";

/** Structural, not the concrete `RasterStandLabel` type — avoids a circular import with domain/technicalRaster.ts while still accepting real `RasterStandLabel[]` values (or any other array of objects that carries this one field) directly. */
export type StandLabelLike = Readonly<{ normalizedStandNumber: string }>;

const LEADING_DIGIT_RUN = /^(\d+)/u;

/**
 * The current raster's own inferred "hall namespace" — the leading digit run shared by EVERY
 * detected raster stand label. Returns `undefined` (never a guess) when there are no labels yet, any
 * label has no leading digit run at all (e.g. "A01" — this project's own numbering doesn't always
 * encode hall identity this way), or the labels disagree with each other (which would mean the
 * raster itself mixes two different leading-digit conventions — never assumed, always treated as
 * "can't tell").
 */
export function inferCurrentHallPrefix(rasterStandLabels: readonly StandLabelLike[]): string | undefined {
  let prefix: string | undefined;
  for (const label of rasterStandLabels) {
    const match = LEADING_DIGIT_RUN.exec(label.normalizedStandNumber);
    if (!match) return undefined;
    if (prefix === undefined) prefix = match[1];
    else if (prefix !== match[1]) return undefined;
  }
  return prefix;
}

/**
 * Classifies ONE imported stand number's scope relative to the current raster's own (reliably
 * inferred) hall namespace — pure, synchronous, no matching against actual raster labels beyond
 * deriving the shared prefix (exact matching itself stays `domain/technicalRasterMatching.ts`'s own
 * job; this only ever answers "is this number even in the right hall to begin with").
 *
 *   "currentRaster"        — same leading digit run as the raster's own hall prefix (or the prefix
 *                             couldn't be derived reliably in the first place — see below).
 *   "outsideCurrentRaster" — the imported number's OWN leading digit run differs from a reliably
 *                             derived current-raster hall prefix.
 *   "unknown"               — the raster's hall prefix could not be derived at all, OR the imported
 *                             number itself carries no leading digit run to compare — never guessed,
 *                             the caller falls back to ordinary unmatched/ambiguous behavior.
 *
 * Deliberately reuses `normalizeStandNumber` (domain/technicalStandNumber.ts) — never a second,
 * subtly different normalization step for the same text.
 */
export function classifyStandScope(importedStandNumber: string, rasterStandLabels: readonly StandLabelLike[]): StandScopeClassification {
  const currentHallPrefix = inferCurrentHallPrefix(rasterStandLabels);
  if (currentHallPrefix === undefined) return "unknown";
  const importedMatch = LEADING_DIGIT_RUN.exec(normalizeStandNumber(importedStandNumber));
  if (!importedMatch) return "unknown";
  return importedMatch[1] === currentHallPrefix ? "currentRaster" : "outsideCurrentRaster";
}
