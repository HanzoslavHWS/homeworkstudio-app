/**
 * Technické rastry — deterministic exact-match assignment engine (spec section 19). NO AI, no
 * fuzzy matching: a stand's normalizedStandNumber is looked up against the raster's detected
 * stand-number text labels via plain string equality only (normalizeStandNumber already handled
 * whitespace at detection time — see domain/technicalStandNumber.ts).
 *
 *   found exactly once  -> matched_auto
 *   found zero times    -> unassigned
 *   found more than once -> ambiguous (NEVER auto-pick one of the candidates)
 */
import type { RasterStandLabel } from "./technicalRaster.ts";

export type StandMatchResult =
  | Readonly<{ status: "matched_auto"; label: RasterStandLabel }>
  | Readonly<{ status: "unassigned" }>
  | Readonly<{ status: "ambiguous"; candidateLabels: readonly RasterStandLabel[] }>;

export function matchStandNumberToRasterLabels(standNumber: string, labels: readonly RasterStandLabel[]): StandMatchResult {
  const candidates = labels.filter((label) => label.normalizedStandNumber === standNumber);
  if (candidates.length === 0) return { status: "unassigned" };
  if (candidates.length === 1) return { status: "matched_auto", label: candidates[0]! };
  return { status: "ambiguous", candidateLabels: candidates };
}
