/**
 * ABF warehouse code matching — read-only analysis, no writes anywhere.
 *
 * Compares PRICELIST rows (private-imports/Ultimátní kalkulace V6.6.xlsm) against the ABF
 * warehouse export (private-imports/vyjezd abry sklad.xlsx) to find which real ABF internal
 * codes can SAFELY be attached to which PRICELIST items.
 *
 * Explicit non-goals (per instruction): no code generation, no fuzzy auto-merge. Fuzzy
 * scoring here only ever produces a ranked CANDIDATE list — never an assignment by itself.
 * A candidate becomes AUTO_ASSIGN only if it passes assessMatch()'s strict rule: same
 * meaning, identical numeric/dimensional specs (per spec KIND — see specsCompatible), and
 * no rival candidate carrying comparable evidence. Anything short of that is REVIEW;
 * nothing plausible is NO_MATCH. internalCode is never invented — only ever an ABF code
 * that actually exists in the warehouse export, or NULL.
 */

export type MatchStatus = "EXACT_SAFE" | "REVIEW" | "NO_MATCH";
export type MatchAction = "AUTO_ASSIGN" | "REVIEW" | "NO_MATCH";

export type AbfItem = Readonly<{
  code: string;
  name: string;
  spec: string | null;
  unit: string | null;
  shortName: string | null;
  spec2: string | null;
  foreignName: string | null;
}>;

export type MatchCandidate = Readonly<{
  abfCode: string;
  abfName: string;
  score: number;
  nameOverlap: number;
  specsMatch: boolean;
  reasons: readonly string[];
}>;

export type MatchAssessment = Readonly<{
  status: MatchStatus;
  action: MatchAction;
  proposedCode: string | null;
  proposedName: string | null;
  proposedForeignName: string | null;
  proposedUnit: string | null;
  confidence: number;
  matchReasons: readonly string[];
  conflictReasons: readonly string[];
  alternatives: readonly MatchCandidate[];
}>;

// ---------------------------------------------------------------------------------------
// Normalization — SAFE transforms only (section 2): case, whitespace, common punctuation,
// digit/unit spacing ("2KW"/"2 kW" -> "2kw"), "2X2"/"2x2" -> "2x2", "m²"/"m2" -> "m2",
// typographic quote/dash variants. Never strips a number, a dimension, an inch mark, or a
// meaning-bearing qualifier (barová/bílá/stojan/nástěnný stay exactly as written).
// ---------------------------------------------------------------------------------------

export function normalizeForMatching(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[""„“]/gu, '"')
    .replace(/['']/gu, "'")
    .replace(/[×]/gu, "x")
    .replace(/[–—]/gu, "-")
    .replace(/(\d)\s*[xX]\s*(\d)/gu, "$1x$2")
    .replace(/(\d)\s*[kK][wW]\b/gu, "$1kw")
    .replace(/(\d)\s*[vV]\b/gu, "$1v")
    .replace(/m\s*²/gu, "m2")
    .replace(/m\s*³/gu, "m3")
    .replace(/\s+/gu, " ")
    .trim()
    .toLocaleLowerCase("cs");
}

function stripDiacritics(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/gu, "");
}

// ---------------------------------------------------------------------------------------
// Spec extraction — grouped by KIND. Two items are only spec-compatible if every kind
// mentioned by the INPUT also appears in the candidate with an EQUAL value set (section 4:
// "2 kW ≠ 3 kW", "2×2 ≠ 3×2", "40\" ≠ 55\""). A kind the candidate carries but the input
// never mentions (e.g. ABF routinely adds "230V"/"400V" voltage the PRICELIST name never
// states) is NOT a conflict — voltage is deliberately excluded from the gate entirely,
// since the source workbook never states it for any item and it would make every
// electricity match impossible to ever confirm.
// ---------------------------------------------------------------------------------------

type SpecKind = "kw" | "dim" | "inch" | "cm" | "mm" | "m2" | "m3" | "l" | "w" | "boothcode";

/**
 * "1 m²" / "1 bm" / "1 m" is this workbook's own PRICING-UNIT notation ("price per m²/bm"),
 * not a physical quantity of exactly one — every Stavba/Grafika row uses it. Requiring an
 * exact "1m2" match against the ABF side would demand ABF also literally write "1 m2" in its
 * name, which it doesn't (it just carries "m2" as a unit) — so a real match (e.g. "KOBEREC
 * ŠEDÝ") would lose to an unrelated item purely because neither side "matched" a fake
 * quantity. cm/mm/m2/m3/l are per-unit kinds here; kw/dim/inch/w are always genuine physical
 * specs in this data (nobody prices "1 kW" as a unit) and are never subject to this rule.
 */
const PER_UNIT_PRICING_KINDS: ReadonlySet<SpecKind> = new Set(["cm", "mm", "m2", "m3", "l"]);

function extractSpecsByKind(text: string): ReadonlyMap<SpecKind, ReadonlySet<string>> {
  const normalized = normalizeForMatching(text);
  const map = new Map<SpecKind, Set<string>>();
  const add = (kind: SpecKind, value: string, quantity?: string) => {
    if (PER_UNIT_PRICING_KINDS.has(kind) && quantity === "1") return;
    if (!map.has(kind)) map.set(kind, new Set());
    map.get(kind)!.add(value.replace(/\s+/gu, ""));
  };
  for (const m of normalized.matchAll(/\d+(?:[.,]\d+)?kw/gu)) add("kw", m[0]);
  for (const m of normalized.matchAll(/\d+x\d+/gu)) add("dim", m[0]);
  for (const m of normalized.matchAll(/\d+\s*"/gu)) add("inch", m[0]);
  for (const m of normalized.matchAll(/(\d+(?:[.,]\d+)?)\s*cm\b/gu)) add("cm", m[0], m[1]);
  for (const m of normalized.matchAll(/(\d+(?:[.,]\d+)?)\s*mm\b/gu)) add("mm", m[0], m[1]);
  for (const m of normalized.matchAll(/(\d+(?:[.,]\d+)?)\s*m2\b/gu)) add("m2", m[0], m[1]);
  for (const m of normalized.matchAll(/(\d+(?:[.,]\d+)?)\s*m3\b/gu)) add("m3", m[0], m[1]);
  for (const m of normalized.matchAll(/(\d+(?:[.,]\d+)?)\s*l\b/gu)) add("l", m[0], m[1]);
  for (const m of normalized.matchAll(/\d+(?:[.,]\d+)?\s*w\b(?!att)/gu)) add("w", m[0]);
  // Section 5: "T4"/"T04"/"T6"/"T06"... — PRICELIST's typové stánky and ABF's T-series booth
  // codes both encode the same identity as a trailing number after "T"; leading zeros differ
  // ("T4" vs "T04") so the value is normalized by stripping them before comparing.
  for (const m of normalized.matchAll(/\bt0*(\d{1,2})\b/gu)) add("boothcode", m[1]!);
  return map;
}

/** Flat set (all kinds) — used only for display/debugging, never for the compatibility gate. */
export function extractSpecs(text: string): ReadonlySet<string> {
  const out = new Set<string>();
  for (const values of extractSpecsByKind(text).values()) for (const v of values) out.add(v);
  return out;
}

function setsEqual<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

/** True iff every spec KIND the input mentions is also present in the candidate with an equal value set. */
function specsCompatible(inputSpecs: ReadonlyMap<SpecKind, ReadonlySet<string>>, candidateSpecs: ReadonlyMap<SpecKind, ReadonlySet<string>>): boolean {
  for (const [kind, values] of inputSpecs) {
    if (values.size === 0) continue;
    const candidateValues = candidateSpecs.get(kind);
    if (!candidateValues || candidateValues.size === 0) return false;
    if (!setsEqual(values, candidateValues)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------------------
// Core-word tokenizer + a tiny, explicit abbreviation bridge — NOT general fuzzy stemming.
// "el." is the one abbreviation this specific source workbook actually uses
// ("Přípojka el. energie") for a word ABF always spells out in full ("elektrická"); expanding
// it is a targeted, auditable fix, not a general prefix-matching floodgate.
// ---------------------------------------------------------------------------------------

// "zapůjčení"/"pronájem" (rental/lease) are procedural qualifiers present on many unrelated
// items (furniture, electronics, switchboards) — they don't identify WHAT the item is, only
// that it's a rental line, so they carry no discriminating identity signal here.
const STOPWORDS = new Set(["a", "s", "z", "do", "na", "za", "pro", "-", "/", "the", "for", "with", "and", "of", "vc", "vč", "zapujceni", "pronajem"]);
// Narrow, explicit, individually-justified equivalences ONLY — never generic stemming.
// "el." is this workbook's own abbreviation for "elektrická"; ABF separately uses the short
// form "elektro" for the same adjective (see L97 "ELEKTRO - NON-STOP PŘÍPLATEK" vs L02..L21's
// "ELEKTRICKÁ ENERGIE..."). Both canonicalize to the same token so they compare equal — but
// "elektrorozvaděč" (switchboard) is a different word entirely and is deliberately NOT in
// this table, so it never gets pulled in by this equivalence (a length-based root-stem
// heuristic was tried and rejected here specifically because it collapsed those two together).
const SYNONYMS: Readonly<Record<string, string>> = { el: "elektricka", elektro: "elektricka" };

function coreTokens(text: string): readonly string[] {
  const normalized = stripDiacritics(normalizeForMatching(text));
  return normalized
    .split(/[^a-z0-9]+/u)
    .map((token) => SYNONYMS[token] ?? token)
    .filter((token) => token.length > 0 && !STOPWORDS.has(token))
    // Bare small numbers (e.g. "1." in "1. připojení" vs "další připojení") stay as core
    // tokens — they carry real ordinal/sequence identity here. Only numbers already folded
    // into a recognized unit spec (2kw, 40", 2x2, ...) are excluded, since those are compared
    // strictly via extractSpecsByKind instead.
    .filter((token) => !/^\d+(kw|v|cm|mm|m2|m3|l|w|x\d+)$/u.test(token));
}

/** Exact match, or a >=3-char prefix relationship (Czech case-suffix variation, e.g. "stojanu"/"stojan", "elektrorozvaděče"/"elektrorozvaděč"). */
function tokensMatch(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a))) return true;
  return false;
}

/**
 * Section 4: a single missing/extra word can matter far more than overall coverage % lets
 * on ("2 kW ≠ 3 kW" is the numeric version of this; this is the categorical version —
 * "uzamykatelná" (lockable), "s mrazákem" (with freezer) etc. are never incidental). A
 * PRICELIST row with 3/4 words covered can still be the WRONG item if the missing word is
 * one of these — generic coverage cannot tell a filler word from a defining feature, so
 * these are checked explicitly: present on one side and absent on the other always blocks
 * EXACT_SAFE, regardless of how high the overall coverage score is.
 */
const CRITICAL_QUALIFIERS = new Set([
  "uzamykatelny", "uzamykatelne", "uzamykatelna", "uzamceny", "lockable",
  "mrazak", "mrazakem", "freezer",
  "jednostranny", "jednostranne", "jednostranna", "oboustranny", "oboustranne", "oboustranna",
  "stojanovy", "stojanova", "stojanove", "stenovy", "stenova", "stenove", "wall", "stand",
]);

function qualifierTokens(tokens: readonly string[]): ReadonlySet<string> {
  return new Set(tokens.filter((token) => CRITICAL_QUALIFIERS.has(token)));
}

function qualifiersConflict(inputTokens: readonly string[], candidateTokens: readonly string[]): boolean {
  const inputQualifiers = qualifierTokens(inputTokens);
  const candidateQualifiers = qualifierTokens(candidateTokens);
  for (const q of inputQualifiers) if (!candidateQualifiers.has(q)) return true;
  for (const q of candidateQualifiers) if (!inputQualifiers.has(q)) return true;
  return false;
}

/** Asymmetric: fraction of INPUT tokens found (exactly or by prefix) among the candidate's tokens. */
function coverage(inputTokens: readonly string[], candidateTokens: readonly string[]): number {
  if (inputTokens.length === 0) return 0;
  const covered = inputTokens.filter((token) => candidateTokens.some((candidate) => tokensMatch(token, candidate)));
  return covered.length / inputTokens.length;
}

export type MatchInput = Readonly<{
  nameCz: string;
  nameEn?: string | null;
  unit?: string | null;
}>;

/** Ranks every ABF item as a raw candidate — a candidate list only, never an assignment. */
export function rankAbfCandidates(input: MatchInput, catalog: readonly AbfItem[]): readonly MatchCandidate[] {
  const czTokens = coreTokens([input.nameCz, input.unit ?? ""].join(" "));
  const enTokens = input.nameEn ? coreTokens(input.nameEn) : [];
  const inputSpecs = extractSpecsByKind([input.nameCz, input.nameEn ?? ""].join(" "));

  const candidates: MatchCandidate[] = [];
  for (const item of catalog) {
    const abfNameTokens = coreTokens([item.name, item.unit ?? ""].join(" "));
    const abfShortTokens = item.shortName ? coreTokens(item.shortName) : [];
    const abfForeignTokens = item.foreignName ? coreTokens(item.foreignName) : [];
    const abfSpecFields = [item.name, item.spec, item.spec2, item.foreignName].filter((v): v is string => Boolean(v)).join(" ");
    const abfSpecs = extractSpecsByKind(abfSpecFields);

    const czCoverage = coverage(czTokens, [...abfNameTokens, ...abfShortTokens]);
    const enCoverage = enTokens.length ? coverage(enTokens, abfForeignTokens) : 0;
    const nameOverlap = Math.max(czCoverage, enCoverage);
    const hasInputSpec = [...inputSpecs.values()].some((v) => v.size > 0);
    if (nameOverlap === 0 && !hasInputSpec) continue;

    const specsMatch = specsCompatible(inputSpecs, abfSpecs);
    const qualifierConflict = qualifiersConflict(czTokens, [...abfNameTokens, ...abfShortTokens]) || qualifiersConflict(enTokens, abfForeignTokens);
    const compatible = specsMatch && !qualifierConflict;
    const exactNameCz = normalizeForMatching(input.nameCz) === normalizeForMatching(item.name);
    const exactNameEn = Boolean(input.nameEn && item.foreignName && normalizeForMatching(input.nameEn) === normalizeForMatching(item.foreignName));

    const reasons: string[] = [];
    if (exactNameCz) reasons.push("exact_name_match_cz");
    if (exactNameEn) reasons.push("exact_name_match_en");
    if (nameOverlap > 0) reasons.push(`name_token_coverage:${nameOverlap.toFixed(2)}`);
    if (hasInputSpec && specsMatch) reasons.push(`specs_match:${[...extractSpecs([input.nameCz, input.nameEn ?? ""].join(" "))].join(",")}`);
    if (hasInputSpec && !specsMatch) reasons.push(`specs_differ: input=[${[...extractSpecs([input.nameCz, input.nameEn ?? ""].join(" "))].join(",")}] abf=[${[...extractSpecs(abfSpecFields)].join(",")}]`);
    if (qualifierConflict) reasons.push("qualifier_conflict: klíčové rozlišující slovo (např. uzamykatelný/mrazák/jednostranný) je jen na jedné straně");

    const nameScore = (exactNameCz || exactNameEn) && !qualifierConflict ? 1 : nameOverlap;
    const score = nameScore * (compatible ? 1 : 0.4);
    if (score <= 0) continue;
    candidates.push({ abfCode: item.code, abfName: item.name, score, nameOverlap, specsMatch: compatible, reasons });
  }
  return candidates.sort((a, b) => b.score - a.score);
}

/**
 * Section 3/4: the strict acceptance rule. AUTO_ASSIGN requires ALL of:
 *  - the top candidate has an exact (safely-normalized) name match in CZ or EN, OR a high
 *    core-token coverage (>= 0.6),
 *  - every spec kind the input mentions matches exactly on the candidate (specsCompatible),
 *  - no second candidate is a real rival (score within 0.15 of the top one) — an ambiguous
 *    field (chairs, TVs, wattage families) always demotes to REVIEW instead.
 * Anything with a plausible but non-conclusive candidate is REVIEW. No candidate at all is
 * NO_MATCH. internalCode is only ever set on AUTO_ASSIGN.
 */
export function assessMatch(input: MatchInput, catalog: readonly AbfItem[]): MatchAssessment {
  const candidates = rankAbfCandidates(input, catalog);
  if (candidates.length === 0) {
    return { status: "NO_MATCH", action: "NO_MATCH", proposedCode: null, proposedName: null, proposedForeignName: null, proposedUnit: null, confidence: 0, matchReasons: [], conflictReasons: ["Žádný ABF kandidát nesdílí význam ani specifikaci."], alternatives: [] };
  }

  const top = candidates[0]!;
  const rivals = candidates.slice(1).filter((c) => top.score - c.score < 0.15);
  const exactName = top.reasons.includes("exact_name_match_cz") || top.reasons.includes("exact_name_match_en");
  const strongCoverage = top.nameOverlap >= 0.6;
  const conflictReasons: string[] = [];
  if (!top.specsMatch) conflictReasons.push("Specifikace (výkon/rozměr/palce) se neshodují — viz reasons.");
  if (rivals.length > 0) conflictReasons.push(`${rivals.length} konkurenční kandidát(y) se srovnatelným skóre: ${rivals.map((r) => r.abfCode).join(", ")}.`);
  if (!exactName && !strongCoverage) conflictReasons.push("Shoda názvu není dostatečně silná pro automatické přiřazení.");

  const abfItem = catalog.find((item) => item.code === top.abfCode)!;
  const isSafe = (exactName || strongCoverage) && top.specsMatch && rivals.length === 0;

  if (isSafe) {
    return {
      status: "EXACT_SAFE",
      action: "AUTO_ASSIGN",
      proposedCode: top.abfCode,
      proposedName: abfItem.name,
      proposedForeignName: abfItem.foreignName,
      proposedUnit: abfItem.unit,
      confidence: exactName ? 1 : top.nameOverlap,
      matchReasons: top.reasons,
      conflictReasons: [],
      alternatives: candidates.slice(1, 4),
    };
  }

  if (top.score >= 0.35) {
    return {
      status: "REVIEW",
      action: "REVIEW",
      proposedCode: top.abfCode,
      proposedName: abfItem.name,
      proposedForeignName: abfItem.foreignName,
      proposedUnit: abfItem.unit,
      confidence: top.nameOverlap,
      matchReasons: top.reasons,
      conflictReasons: conflictReasons.length ? conflictReasons : ["Pravděpodobný kandidát, ale bez jistoty potřebné pro AUTO_ASSIGN."],
      alternatives: candidates.slice(1, 4),
    };
  }

  return {
    status: "NO_MATCH",
    action: "NO_MATCH",
    proposedCode: null,
    proposedName: null,
    proposedForeignName: null,
    proposedUnit: null,
    confidence: 0,
    matchReasons: [],
    conflictReasons: ["Nejlepší kandidát je příliš slabý na to, aby byl bezpečný i jako REVIEW návrh."],
    alternatives: candidates.slice(0, 3),
  };
}
