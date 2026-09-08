/**
 * Technické rastry — the ONE central place stand-number text is normalized and compared. Used by
 * every layer that touches a stand number: raster label detection, technical-report row parsing,
 * exact matching, and manual search — never re-implemented ad hoc elsewhere (spec section 26).
 *
 * Deliberately conservative: only strips surrounding/internal whitespace, never guesses, corrects
 * typos, or touches the letter suffix ("1A11b" stays "1A11b", never becomes "1A11B" or "1A11").
 * No fuzzy matching anywhere in this module — v1 is exact-match only (spec section 29).
 */

/** "1A21" -> "1A21", " 1A21 " -> "1A21", "1 A 21" -> "1A21". Never changes case, never touches the letter suffix, never fuzzy-corrects. */
export function normalizeStandNumber(rawText: string): string {
  return rawText.replace(/\s+/gu, "").trim();
}

/**
 * Splits a normalized stand number into its natural-sort parts: a leading digit run, then any
 * further alternating letter/digit runs (e.g. "1A11b" -> ["1","A","11","b"]). Used only by
 * compareStandNumbersNatural below — never used to re-derive or validate a stand number's meaning.
 */
function standNumberParts(value: string): readonly (string | number)[] {
  const matches = value.match(/\d+|\D+/gu) ?? [];
  return matches.map((part) => (/^\d+$/u.test(part) ? Number(part) : part));
}

/**
 * Natural comparator for stand numbers (spec section 17/37B): "1A09" < "1A10" < "1A11" <
 * "1A11b" < "1A12" — never plain lexicographic string sort, which would put "1A10" before "1A2".
 * Compares part-by-part (letters vs letters as strings, digit runs as numbers); a shorter value
 * that's a strict prefix of a longer one sorts first (so "1A11" sorts before "1A11b").
 */
export function compareStandNumbersNatural(a: string, b: string): number {
  const partsA = standNumberParts(a);
  const partsB = standNumberParts(b);
  const length = Math.max(partsA.length, partsB.length);
  for (let index = 0; index < length; index += 1) {
    const partA = partsA[index];
    const partB = partsB[index];
    if (partA === undefined) return -1;
    if (partB === undefined) return 1;
    if (typeof partA === "number" && typeof partB === "number") {
      if (partA !== partB) return partA - partB;
      continue;
    }
    const stringA = String(partA);
    const stringB = String(partB);
    if (stringA !== stringB) return stringA < stringB ? -1 : 1;
  }
  return 0;
}

export function sortStandNumbersNatural<T>(items: readonly T[], getStandNumber: (item: T) => string): readonly T[] {
  return [...items].sort((a, b) => compareStandNumbersNatural(getStandNumber(a), getStandNumber(b)));
}
