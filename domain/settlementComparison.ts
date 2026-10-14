/**
 * Kontrola vyúčtování — the deterministic comparison engine (batch 1). Pure, no I/O, no AI.
 *
 *  1. Stands are paired by settlementStandKey (the user's manual assignment of a sheet wins).
 *  2. Every line is resolved to a catalog component:
 *       ABF line    -> ABF code in the item text ("T18 - …"), else its name against the catalog's
 *                      ABF names (official name + alternative ABF names). The real ABF export cuts
 *                      names at ~40 characters, so a name that is the unique beginning of exactly
 *                      one catalog ABF name is accepted too — and reported as such.
 *       vendor line -> ONLY a CONFIRMED dictionary entry of that realization company. A suggested
 *                      or unclear entry never produces a match.
 *  3. Quantities are compared only when both sides use one and the same canonical unit.
 *  4. difference = billed − ordered.
 *
 * Nothing that could not be resolved, has no unit, or mixes units is ever reported as a match.
 * Every row keeps the ids of the original lines it was built from and says how it was matched.
 *
 * Rules: the engine applies exactly ONE rule type, `out_of_scope` ("this company never bills this
 * item"), and only when it is active. Every other rule type is stored (domain/settlementRules.ts)
 * but not evaluated yet — where one would be needed the row says "Vyžaduje pravidlo".
 */
import { compareStandNumbersNatural } from "./technicalStandNumber.ts";
import {
  canonicalUnit,
  countProblems,
  emptyRowCounts,
  normalizeSettlementText,
  roundQuantity,
  type SettlementMappingStatus,
  type SettlementResultStatus,
  type SettlementRunSummary,
} from "./settlementCheck.ts";

/** Shortest ABF order name that may be treated as a truncated catalog name. */
export const TRUNCATED_NAME_MIN_LENGTH = 30;

export type ComparisonCatalogItem = Readonly<{
  id: string;
  abfCode: string | null;
  displayName: string;
  /** Every ABF name of the card: official name + alternative ABF names. */
  abfNames: readonly string[];
}>;

export type ComparisonAbfLine = Readonly<{
  id: string;
  standKey: string | null;
  standLabel: string;
  exhibitorName: string | null;
  rawName: string;
  abfCode: string | null;
  quantity: number | null;
  quantityIssue: string | null;
  unitRaw: string | null;
}>;

export type ComparisonVendorLine = Readonly<{
  id: string;
  /** Effective key (manual assignment applied). null = unassigned sheet, never compared. */
  standKey: string | null;
  standLabel: string;
  exhibitorName: string | null;
  rawName: string;
  quantity: number | null;
  quantityIssue: string | null;
  unit: string | null;
}>;

export type ComparisonVendorMapping = Readonly<{
  normalizedText: string;
  catalogItemId: string | null;
  unit: string | null;
  status: SettlementMappingStatus;
}>;

export type ComparisonOutOfScopeRule = Readonly<{
  id: string;
  name: string;
  catalogItemId: string | null;
  /** For an ABF line with no catalog card yet. */
  abfNormalizedName: string | null;
}>;

export type AbfMatchMethod = "abf_code" | "abf_name" | "abf_name_truncated";

export type ComparisonRowExplanation = Readonly<{
  /** How the ABF lines were tied to the component. Empty when no ABF line is on the row. */
  abfMatch: readonly AbfMatchMethod[];
  /** True when the vendor lines were tied through a confirmed dictionary entry. */
  vendorMappingConfirmed: boolean;
  /** Czech sentences explaining the status — shown to the user verbatim. */
  reasons: readonly string[];
  ruleIds: readonly string[];
  /** Catalog cards an ambiguous ABF name could mean. */
  candidateCatalogItemIds: readonly string[];
}>;

export type ComparisonRow = Readonly<{
  /** Stable across re-runs: `item:<catalogItemId>`, `abf:<normalized name>`, `vendor:<normalized name>`. Manual decisions are keyed by it. */
  rowKey: string;
  status: SettlementResultStatus;
  label: string;
  catalogItemId: string | null;
  abfCode: string | null;
  abfQuantity: number | null;
  abfUnit: string | null;
  vendorQuantity: number | null;
  vendorUnit: string | null;
  /** billed − ordered; null whenever the two are not comparable. */
  difference: number | null;
  abfLineIds: readonly string[];
  vendorLineIds: readonly string[];
  explanation: ComparisonRowExplanation;
}>;

export type StandMatchState = "matched" | "abf_only" | "vendor_only";

export type StandComparison = Readonly<{
  standKey: string;
  /** Stand number as ABF writes it when ABF has the stand, else the vendor's. */
  displayNumber: string;
  matchState: StandMatchState;
  abfExhibitorName: string | null;
  vendorExhibitorName: string | null;
  rows: readonly ComparisonRow[];
  counts: Readonly<Record<SettlementResultStatus, number>>;
  problemCount: number;
}>;

export type ComparisonInput = Readonly<{
  catalog: readonly ComparisonCatalogItem[];
  abfLines: readonly ComparisonAbfLine[];
  vendorLines: readonly ComparisonVendorLine[];
  mappings: readonly ComparisonVendorMapping[];
  outOfScopeRules?: readonly ComparisonOutOfScopeRule[];
  /** Stand keys known on each side even when they carry no line (an ordered stand with no items, a filled-in sheet with nothing billed). */
  abfStandKeys?: readonly Readonly<{ standKey: string; label: string; exhibitorName: string | null }>[];
  vendorStandKeys?: readonly Readonly<{ standKey: string; label: string; exhibitorName: string | null }>[];
}>;

export type ComparisonResult = Readonly<{
  stands: readonly StandComparison[];
  summary: Omit<SettlementRunSummary, "unassignedVendorSheetCount" | "unassignedAbfStandCount">;
}>;

type AbfResolution =
  | Readonly<{ kind: "resolved"; catalogItemId: string; method: AbfMatchMethod }>
  | Readonly<{ kind: "ambiguous"; candidates: readonly string[] }>
  | Readonly<{ kind: "unresolved" }>;

type CatalogIndex = Readonly<{
  byId: ReadonlyMap<string, ComparisonCatalogItem>;
  byCode: ReadonlyMap<string, string>;
  byName: ReadonlyMap<string, ReadonlySet<string>>;
}>;

function buildCatalogIndex(catalog: readonly ComparisonCatalogItem[]): CatalogIndex {
  const byId = new Map<string, ComparisonCatalogItem>();
  const byCode = new Map<string, string>();
  const byName = new Map<string, Set<string>>();
  for (const item of catalog) {
    byId.set(item.id, item);
    if (item.abfCode) byCode.set(item.abfCode.trim().toLocaleUpperCase("cs"), item.id);
    for (const name of item.abfNames) {
      const normalized = normalizeSettlementText(name);
      if (!normalized) continue;
      if (!byName.has(normalized)) byName.set(normalized, new Set());
      byName.get(normalized)!.add(item.id);
    }
  }
  return { byId, byCode, byName };
}

/** "T18 - TYPOVÝ STÁNEK 6X3 m (STAVBA)" -> "TYPOVÝ STÁNEK 6X3 m (STAVBA)". */
function withoutCodePrefix(rawName: string): string {
  return rawName.replace(/^[A-Z][0-9A-Z]{2}\s+-\s+/u, "");
}

export function resolveAbfLine(line: Pick<ComparisonAbfLine, "rawName" | "abfCode">, index: CatalogIndex): AbfResolution {
  if (line.abfCode) {
    const byCode = index.byCode.get(line.abfCode.trim().toLocaleUpperCase("cs"));
    if (byCode) return { kind: "resolved", catalogItemId: byCode, method: "abf_code" };
  }
  const names = [normalizeSettlementText(line.rawName), normalizeSettlementText(withoutCodePrefix(line.rawName))].filter((name, position, all) => name && all.indexOf(name) === position);
  for (const name of names) {
    const exact = index.byName.get(name);
    if (exact?.size === 1) return { kind: "resolved", catalogItemId: [...exact][0]!, method: "abf_name" };
    if (exact && exact.size > 1) return { kind: "ambiguous", candidates: [...exact] };
  }
  for (const name of names) {
    if (name.length < TRUNCATED_NAME_MIN_LENGTH) continue;
    const candidates = new Set<string>();
    for (const [catalogName, ids] of index.byName) {
      if (catalogName.length > name.length && catalogName.startsWith(name)) for (const id of ids) candidates.add(id);
    }
    if (candidates.size === 1) return { kind: "resolved", catalogItemId: [...candidates][0]!, method: "abf_name_truncated" };
    if (candidates.size > 1) return { kind: "ambiguous", candidates: [...candidates] };
  }
  return { kind: "unresolved" };
}

type SideQuantity = Readonly<{ quantity: number | null; unit: string | null; unitCount: number; hasIssue: boolean; hasUnknownUnit: boolean }>;

function summarizeSide(lines: readonly Readonly<{ quantity: number | null; quantityIssue: string | null; unit: string | null }>[]): SideQuantity {
  const units = new Set(lines.map((line) => line.unit ?? ""));
  const hasIssue = lines.some((line) => line.quantity === null || Boolean(line.quantityIssue));
  const hasUnknownUnit = units.has("");
  return {
    // A sum exists only within ONE unit; lines in mixed units are never added together.
    quantity: units.size === 1 && !hasIssue ? roundQuantity(lines.reduce((sum, line) => sum + (line.quantity ?? 0), 0)) : null,
    unit: units.size === 1 ? [...units][0] || null : null,
    unitCount: units.size,
    hasIssue,
    hasUnknownUnit,
  };
}

type AbfWithUnit = ComparisonAbfLine & { unit: string | null };
type VendorWithUnit = ComparisonVendorLine;

type RowDraft = {
  rowKey: string;
  label: string;
  catalogItemId: string | null;
  abfCode: string | null;
  abf: AbfWithUnit[];
  vendor: VendorWithUnit[];
  abfMethods: Set<AbfMatchMethod>;
  vendorConfirmed: boolean;
  unresolvedReasons: string[];
  candidates: string[];
};

function unitsText(lines: readonly Readonly<{ unit: string | null }>[]): string {
  return [...new Set(lines.map((line) => line.unit ?? "bez jednotky"))].join(" + ");
}

function finishRow(draft: RowDraft, rules: readonly ComparisonOutOfScopeRule[]): ComparisonRow {
  const abf = summarizeSide(draft.abf);
  const vendor = summarizeSide(draft.vendor);
  const reasons = [...draft.unresolvedReasons];
  const ruleIds: string[] = [];
  let status: SettlementResultStatus;
  let difference: number | null = null;

  const unresolved = draft.unresolvedReasons.length > 0;
  if (unresolved) {
    status = "unclear";
  } else if (draft.vendor.length === 0) {
    status = "only_abf";
    reasons.push("Objednáno u ABF, ve vyúčtování realizačky není žádná odpovídající účtovaná položka.");
  } else if (draft.abf.length === 0) {
    status = "only_vendor";
    reasons.push("Účtováno realizačkou, v objednávce ABF pro tento stánek položka není.");
  } else if (abf.hasIssue || vendor.hasIssue) {
    status = "unclear";
    reasons.push("Některý řádek nemá čitelné množství.");
  } else if (abf.hasUnknownUnit || vendor.hasUnknownUnit) {
    status = "unclear";
    reasons.push("U některého řádku chybí měrná jednotka — množství nelze bezpečně porovnat.");
  } else if (abf.unitCount > 1 || vendor.unitCount > 1 || abf.unit !== vendor.unit) {
    status = "requires_rule";
    reasons.push(`Rozdílné jednotky: ABF ${unitsText(draft.abf)}, realizačka ${unitsText(draft.vendor)}. Množství se automaticky nepřepočítává — je potřeba pravidlo přepočtu nebo oprava jednotky ve slovníku.`);
  } else {
    difference = roundQuantity((vendor.quantity ?? 0) - (abf.quantity ?? 0));
    status = difference === 0 ? "match" : "difference";
    if (difference !== 0) reasons.push(`Vyúčtováno ${vendor.quantity} ${vendor.unit}, objednáno ${abf.quantity} ${abf.unit} (rozdíl ${difference > 0 ? "+" : ""}${difference}).`);
  }

  // out_of_scope applies only to something ABF ordered that the company did not bill at all.
  if (draft.vendor.length === 0 && draft.abf.length > 0 && (status === "only_abf" || status === "unclear")) {
    const abfName = draft.rowKey.startsWith("abf:") ? draft.rowKey.slice(4) : null;
    const rule = rules.find((candidate) => (draft.catalogItemId && candidate.catalogItemId === draft.catalogItemId) || (abfName !== null && candidate.abfNormalizedName === abfName));
    if (rule) {
      status = "out_of_scope";
      ruleIds.push(rule.id);
      reasons.length = 0;
      reasons.push(`Mimo rozsah kontroly podle pravidla „${rule.name}“ — tuto položku realizačka neúčtuje.`);
    }
  }

  if (draft.abfMethods.has("abf_name_truncated")) reasons.push("Název v objednávce ABF je zkrácený; přiřazen ke komponentě, jejíž ABF název jím jednoznačně začíná.");
  if (draft.abf.length > 1) reasons.push(`Sečteno z ${draft.abf.length} řádků objednávky ABF.`);
  if (draft.vendor.length > 1) reasons.push(`Sečteno z ${draft.vendor.length} řádků vyúčtování.`);

  return {
    rowKey: draft.rowKey,
    status,
    label: draft.label,
    catalogItemId: draft.catalogItemId,
    abfCode: draft.abfCode,
    abfQuantity: draft.abf.length > 0 ? abf.quantity : null,
    abfUnit: draft.abf.length > 0 ? abf.unit : null,
    vendorQuantity: draft.vendor.length > 0 ? vendor.quantity : null,
    vendorUnit: draft.vendor.length > 0 ? vendor.unit : null,
    difference,
    abfLineIds: draft.abf.map((line) => line.id),
    vendorLineIds: draft.vendor.map((line) => line.id),
    explanation: { abfMatch: [...draft.abfMethods], vendorMappingConfirmed: draft.vendorConfirmed, reasons, ruleIds, candidateCatalogItemIds: draft.candidates },
  };
}

const STATUS_ORDER: readonly SettlementResultStatus[] = ["difference", "only_vendor", "only_abf", "requires_rule", "unclear", "match", "out_of_scope"];
const LABEL_COLLATOR = new Intl.Collator("cs", { sensitivity: "base", numeric: true });

export function compareSettlement(input: ComparisonInput): ComparisonResult {
  const index = buildCatalogIndex(input.catalog);
  const mappingByText = new Map(input.mappings.map((mapping) => [mapping.normalizedText, mapping]));
  const rules = input.outOfScopeRules ?? [];

  type StandDraft = { key: string; abfLabel: string | null; vendorLabel: string | null; abfExhibitor: string | null; vendorExhibitor: string | null; hasAbf: boolean; hasVendor: boolean; rows: Map<string, RowDraft> };
  const stands = new Map<string, StandDraft>();
  const standOf = (key: string): StandDraft => {
    let stand = stands.get(key);
    if (!stand) {
      stand = { key, abfLabel: null, vendorLabel: null, abfExhibitor: null, vendorExhibitor: null, hasAbf: false, hasVendor: false, rows: new Map() };
      stands.set(key, stand);
    }
    return stand;
  };
  const rowOf = (stand: StandDraft, rowKey: string, seed: Pick<RowDraft, "label" | "catalogItemId" | "abfCode">): RowDraft => {
    let row = stand.rows.get(rowKey);
    if (!row) {
      row = { rowKey, ...seed, abf: [], vendor: [], abfMethods: new Set(), vendorConfirmed: false, unresolvedReasons: [], candidates: [] };
      stand.rows.set(rowKey, row);
    }
    return row;
  };

  for (const known of input.abfStandKeys ?? []) {
    const stand = standOf(known.standKey);
    stand.hasAbf = true;
    stand.abfLabel ??= known.label;
    stand.abfExhibitor ??= known.exhibitorName;
  }
  for (const known of input.vendorStandKeys ?? []) {
    const stand = standOf(known.standKey);
    stand.hasVendor = true;
    stand.vendorLabel ??= known.label;
    stand.vendorExhibitor ??= known.exhibitorName;
  }

  for (const line of input.abfLines) {
    if (!line.standKey) continue;
    const stand = standOf(line.standKey);
    stand.hasAbf = true;
    stand.abfLabel ??= line.standLabel;
    stand.abfExhibitor ??= line.exhibitorName;
    const withUnit: AbfWithUnit = { ...line, unit: canonicalUnit(line.unitRaw) };
    const resolution = resolveAbfLine(line, index);
    if (resolution.kind === "resolved") {
      const item = index.byId.get(resolution.catalogItemId)!;
      const row = rowOf(stand, `item:${item.id}`, { label: item.displayName, catalogItemId: item.id, abfCode: item.abfCode });
      row.abf.push(withUnit);
      row.abfMethods.add(resolution.method);
    } else {
      const normalized = normalizeSettlementText(line.rawName);
      const row = rowOf(stand, `abf:${normalized}`, { label: line.rawName, catalogItemId: null, abfCode: line.abfCode });
      row.abf.push(withUnit);
      if (row.unresolvedReasons.length === 0) {
        if (resolution.kind === "ambiguous") {
          row.candidates.push(...resolution.candidates);
          row.unresolvedReasons.push(`Název ABF „${line.rawName}“ odpovídá ${resolution.candidates.length} komponentám katalogu — vyberte správnou.`);
        } else {
          row.unresolvedReasons.push(`Název ABF „${line.rawName}“ není v katalogu komponent (ani jako alternativní název ABF) — přiřaďte komponentu.`);
        }
      }
    }
  }

  for (const line of input.vendorLines) {
    if (!line.standKey) continue;
    const stand = standOf(line.standKey);
    stand.hasVendor = true;
    stand.vendorLabel ??= line.standLabel;
    stand.vendorExhibitor ??= line.exhibitorName;
    const normalized = normalizeSettlementText(line.rawName);
    const mapping = mappingByText.get(normalized);
    const item = mapping?.status === "confirmed" && mapping.catalogItemId ? index.byId.get(mapping.catalogItemId) : undefined;
    if (item && mapping) {
      const row = rowOf(stand, `item:${item.id}`, { label: item.displayName, catalogItemId: item.id, abfCode: item.abfCode });
      row.vendor.push({ ...line, unit: canonicalUnit(mapping.unit) ?? canonicalUnit(line.unit) });
      row.vendorConfirmed = true;
    } else {
      const row = rowOf(stand, `vendor:${normalized}`, { label: line.rawName, catalogItemId: null, abfCode: null });
      row.vendor.push({ ...line, unit: canonicalUnit(line.unit) });
      if (row.unresolvedReasons.length === 0) {
        row.unresolvedReasons.push(
          !mapping ? `Název realizačky „${line.rawName}“ není ve slovníku — přiřaďte komponentu a mapování potvrďte.`
            : mapping.status === "confirmed" ? `Slovník odkazuje na komponentu, která už v katalogu není — vyberte jinou.`
              : mapping.catalogItemId ? `Mapování názvu „${line.rawName}“ je jen ${mapping.status === "suggested" ? "návrh" : "označené jako nejasné"} — potvrďte ho, jinak se nepoužije.`
                : `Název realizačky „${line.rawName}“ zatím nemá přiřazenou komponentu.`,
        );
      }
    }
  }

  const result: StandComparison[] = [];
  const totals = emptyRowCounts();
  for (const stand of stands.values()) {
    const rows = [...stand.rows.values()].map((draft) => finishRow(draft, rules)).sort((a, b) =>
      STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status) || LABEL_COLLATOR.compare(a.label, b.label) || (a.rowKey < b.rowKey ? -1 : 1),
    );
    const counts = emptyRowCounts();
    for (const row of rows) {
      counts[row.status] += 1;
      totals[row.status] += 1;
    }
    result.push({
      standKey: stand.key,
      displayNumber: stand.abfLabel ?? stand.vendorLabel ?? stand.key,
      matchState: stand.hasAbf && stand.hasVendor ? "matched" : stand.hasAbf ? "abf_only" : "vendor_only",
      abfExhibitorName: stand.abfExhibitor,
      vendorExhibitorName: stand.vendorExhibitor,
      rows,
      counts,
      problemCount: countProblems(counts),
    });
  }
  result.sort((a, b) => compareStandNumbersNatural(a.standKey, b.standKey));

  return {
    stands: result,
    summary: {
      standCount: result.length,
      matchedStandCount: result.filter((stand) => stand.matchState === "matched").length,
      abfOnlyStandCount: result.filter((stand) => stand.matchState === "abf_only").length,
      vendorOnlyStandCount: result.filter((stand) => stand.matchState === "vendor_only").length,
      rowCounts: totals,
    },
  };
}

// ============================================================================
// UI filters
// ============================================================================

export const SETTLEMENT_ROW_FILTERS = ["all", "match", "difference", "only_abf", "only_vendor", "unclear"] as const;
export type SettlementRowFilter = (typeof SETTLEMENT_ROW_FILTERS)[number];

export const SETTLEMENT_ROW_FILTER_LABELS_CS: Readonly<Record<SettlementRowFilter, string>> = {
  all: "Vše",
  match: "Shody",
  difference: "Rozdíly",
  only_abf: "Pouze ABF",
  only_vendor: "Pouze realizačka",
  unclear: "Nejasné položky",
};

/** "Nejasné položky" covers both `unclear` and `requires_rule` — both need a human decision. "Vše" hides nothing. */
export function matchesRowFilter(status: SettlementResultStatus, filter: SettlementRowFilter): boolean {
  if (filter === "all") return true;
  if (filter === "unclear") return status === "unclear" || status === "requires_rule";
  return status === filter;
}
