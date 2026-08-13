import type { ComponentDefinition } from "./models.ts";
import { catalogDisplayName, normalizeCatalogName } from "./catalog.ts";

export type MappingReason = "exact_name_match" | "shared_name_tokens" | "shared_spec_token";

export type CatalogMappingCandidate = Readonly<{
  catalogItemId: string;
  internalCode?: string;
  displayName: string;
  score: number;
  reasons: readonly MappingReason[];
}>;

const STOPWORDS = new Set(["a", "s", "do", "na", "za", "1", "-", "/"]);

/** Diacritic-insensitive tokenizer that also splits digit/letter boundaries so "2kW" and "2 kW" tokenize identically. */
function tokenize(value: string): readonly string[] {
  const normalized = value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .toLowerCase()
    .replace(/(\d)([a-z])/giu, "$1 $2")
    .replace(/([a-z])(\d)/giu, "$1 $2");
  return normalized
    .split(/[^a-z0-9]+/u)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

function jaccard(a: readonly string[], b: readonly string[]): number {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) if (setB.has(token)) intersection++;
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

const SPEC_UNIT_TOKEN = /^(kw|v|m|mm|cm)$/u;

/**
 * tokenize() deliberately splits "2kW" into adjacent tokens "2","kw" (so it lines up with
 * text that already has a space, e.g. "2 kW"), so the spec signal has to look at adjacent
 * number+unit token PAIRS rather than a single combined token.
 */
function specPairs(tokens: readonly string[]): ReadonlySet<string> {
  const pairs = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i++) {
    if (/^\d+$/u.test(tokens[i]!) && SPEC_UNIT_TOKEN.test(tokens[i + 1]!)) pairs.add(`${tokens[i]}${tokens[i + 1]}`);
  }
  return pairs;
}

/** Numeric+unit specs (e.g. "2 kw", "230 v") that make an otherwise-weak text match trustworthy. */
function sharedSpecTokens(a: readonly string[], b: readonly string[]): boolean {
  const pairsA = specPairs(a);
  for (const pair of specPairs(b)) if (pairsA.has(pair)) return true;
  return false;
}

const NAME_TOKEN_THRESHOLD = 0.4;

/**
 * Advisory-only: surfaces plausible existing catalog items for a human to confirm via
 * CatalogMapping. Never auto-assigns — exact normalized-name matches (matchCatalogItem)
 * already cover the "same string" case; this adds weaker, explainable signals for near
 * matches like "Židle čalouněná" (Excel) → M57 "Židle kovová čalouněná" (catalog).
 */
export function suggestCatalogMappingCandidates(
  input: Readonly<{ rawNameCz: string; rawNameEn?: string | null }>,
  catalogItems: readonly ComponentDefinition[],
): readonly CatalogMappingCandidate[] {
  const czTokens = tokenize(input.rawNameCz);
  const enTokens = input.rawNameEn ? tokenize(input.rawNameEn) : [];
  const normalizedRawName = normalizeCatalogName(input.rawNameCz);

  const candidates: CatalogMappingCandidate[] = [];
  for (const item of catalogItems) {
    const displayName = catalogDisplayName(item);
    const reasons: MappingReason[] = [];
    let score = 0;

    if (normalizeCatalogName(displayName) === normalizedRawName || normalizeCatalogName(item.officialName) === normalizedRawName) {
      reasons.push("exact_name_match");
      score = 1;
    } else {
      const displayTokens = tokenize(displayName);
      const officialTokens = item.officialName ? tokenize(item.officialName) : [];
      const nameScore = Math.max(jaccard(czTokens, displayTokens), jaccard(czTokens, officialTokens));
      if (nameScore >= NAME_TOKEN_THRESHOLD) {
        reasons.push("shared_name_tokens");
        score = Math.max(score, nameScore);
      }
      if (sharedSpecTokens(czTokens, displayTokens) || sharedSpecTokens(czTokens, officialTokens) || sharedSpecTokens(enTokens, officialTokens)) {
        reasons.push("shared_spec_token");
        score = Math.max(score, 0.5);
      }
    }

    if (reasons.length > 0) {
      candidates.push({ catalogItemId: item.id, internalCode: item.internalCode, displayName, score, reasons });
    }
  }

  return candidates.sort((a, b) => b.score - a.score);
}
