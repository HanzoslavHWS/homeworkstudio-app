/**
 * Technické rastry — CORRECTIVE BATCH (real production, H3/H4 tolerant stand-number matching). Real
 * evidence: Hala 3's own raster labels read "3A1"/"3B7" (no leading zero on the numeric segment),
 * while imported technical-service/catalog rows for the SAME physical stands read "3A01"/"3B07"
 * (Corel's own export convention pads the numeric segment). A byte-exact comparison
 * (domain/technicalStandNumber.ts's `normalizeStandNumber`, whitespace-only) treats these as two
 * DIFFERENT stands — the real root cause of technical-service/realization overlays silently
 * disappearing from an H3 export.
 *
 * This module adds exactly ONE new concept — a canonical IDENTITY two differently-formatted stand
 * numbers must produce identically to be considered "the same stand" — deliberately narrow (leading-
 * zero equivalence on numeric segments only, per real evidence) rather than a broad fuzzy matcher:
 *
 *   3A01 == 3A1 == 3A001   (same integer once parsed)
 *   1B02b == 1B2b          (letter suffix compared as exact text, never touched)
 *   1a11 != 1A11           (case is NEVER touched here — exact-match's own pinned case-sensitivity
 *                            guarantee, domain/technicalRasterMatching.ts, is completely unaffected)
 *
 * The RAW imported text is NEVER discarded or rewritten anywhere this is used — see
 * domain/technicalRasterMatching.ts's own `matchMethod: "tolerant_normalized"` for how a caller
 * audits "this was normalized, not an exact match" without ever losing the original string.
 */

import { normalizeStandNumber } from "./technicalStandNumber.ts";

export type StandNumberIdentityPart = Readonly<{ kind: "digits"; value: number } | { kind: "text"; value: string }>;

/**
 * Splits an already-whitespace-normalized stand number into alternating digit-run / non-digit-run
 * parts, each digit run parsed as its actual NUMERIC value — so "01", "1", and "001" all become the
 * identical `{kind:"digits", value:1}` part. This is the ONE deliberate place a stand number's
 * leading zeros are treated as cosmetic rather than meaningful (per the real H3 production
 * evidence in this module's own doc above). Never touches letter-run casing/spelling at all.
 *
 * "3A01" -> [{digits:3}, {text:"A"}, {digits:1}]
 * "1B02b" -> [{digits:1}, {text:"B"}, {digits:2}, {text:"b"}]
 */
export function parseStandNumberIdentityParts(normalized: string): readonly StandNumberIdentityPart[] {
  const matches = normalized.match(/\d+|\D+/gu) ?? [];
  return matches.map((part): StandNumberIdentityPart => (/^\d+$/u.test(part) ? { kind: "digits", value: Number(part) } : { kind: "text", value: part }));
}

/**
 * The ONE canonical identity string two differently-formatted stand numbers must produce
 * identically to be considered "the same stand" for TOLERANT matching (see this module's own doc
 * for the exact, deliberately narrow scope — leading-zero equivalence only). Never used for
 * display anywhere — the raw imported text is always preserved separately by every caller.
 *
 * A `#`/`$` type tag on every part (rather than a bare join) prevents an accidental collision
 * between a numeric part and a letter part that happens to render the same way (e.g. a stand
 * number that were ever JUST "1" vs one whose only part happens to stringify to "1") — defensive,
 * since real stand numbers always alternate digit/letter runs, but cheap to guarantee outright.
 */
export function computeStandNumberCanonicalIdentity(rawText: string): string {
  const parts = parseStandNumberIdentityParts(normalizeStandNumber(rawText));
  return parts.map((part) => (part.kind === "digits" ? `#${part.value}` : `$${part.value}`)).join("|");
}

/** Whether two RAW stand-number strings refer to the same physical stand under the tolerant canonical identity (leading-zero equivalence only — see this module's own doc). Never case-insensitive, never suffix-insensitive. */
export function standNumbersShareCanonicalIdentity(a: string, b: string): boolean {
  return computeStandNumberCanonicalIdentity(a) === computeStandNumberCanonicalIdentity(b);
}
