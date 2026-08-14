/**
 * Import Batch #2B planning — DRY-RUN ONLY, this session. No apply writer is invoked; no
 * database or R2 write happens anywhere in this module or its caller (scripts/importBatch2b.ts).
 *
 * Scope: the ~93 non-technical-service PRICELIST rows from
 * private-imports/code-matching-report.json (technical services — category "T. služby" — are
 * entirely Batch #2A's scope and are excluded here), plus P86 as a separate explicit canonical
 * case (never derived from fuzzy name matching — see planP86Canonical()).
 *
 * Reuses Batch #2A's identity rules rather than reinventing them: resolveExistingCatalogItem()
 * (internalCode first, then sourceSystem+sourceKey, NEVER normalized name) and
 * buildMappingSourceKey() (domain/importBatch.ts) for a stable, deterministic sourceKey.
 *
 * OUT OF SCOPE for this module: any REVIEW/NO_MATCH row ever getting an internalCode: they
 * are always planned with internalCode=null, action="review"/"skip" — no automatic M/L/P/T/
 * A/I/W/U code generation, ever.
 */
import type { BoothType, CatalogItemKind, CatalogItemStatus, ComponentDefinition } from "./models.ts";
import { evaluateCatalogReadiness, isGeneratorEligible } from "./catalogReadiness.ts";
import { buildMappingSourceKey } from "./importBatch.ts";
import { resolveExistingCatalogItem, type ExistingCatalogItemRow } from "./importBatch2a.ts";

/** Same workbook/source system Batch #1/#2A already use — this is still the V6.6 Excel + ABF warehouse export pairing. */
export const BATCH2B_SOURCE_SYSTEM = "excel-v6.6";
const PRICELIST_SOURCE_SHEET = "PRICELIST";
/** Category value Batch #2A's technical services already fully own — never re-planned here. */
const TECHNICAL_SERVICE_CATEGORY = "T. služby";

export type Batch2bAbfStatus = "EXACT_SAFE" | "REVIEW" | "NO_MATCH";

/** One row of code-matching-report.json's `pricelist` array — the shape this module consumes. */
export type Batch2bSourceRow = Readonly<{
  sourceRow: number;
  category: string;
  nameCz: string;
  nameEn?: string | null;
  currentInternalCode?: string | null;
  unit: string | null;
  status: Batch2bAbfStatus;
  proposedCode: string | null;
  proposedName: string | null;
  proposedForeignName: string | null;
  proposedUnit: string | null;
}>;

/** True only for the code-matching-report.json rows this module is allowed to plan — excludes the "T. služby" category Batch #2A already owns. */
export function isBatch2bEligibleRow(row: Pick<Batch2bSourceRow, "category">): boolean {
  return row.category !== TECHNICAL_SERVICE_CATEGORY;
}

// ============================================================================
// CATEGORY -> KIND CLASSIFICATION — never invents a new CatalogItemKind. An ambiguous
// category/code combination is explicitly flagged "not confident" and the caller must treat
// it as needs_review (section 8).
// ============================================================================

export type CategoryKindClassification = Readonly<{
  kind: CatalogItemKind;
  confident: boolean;
  reason: string;
}>;

/**
 * Section 8: classification is derived from the REPORT's own category field and (only where
 * the category alone is ambiguous, e.g. "Stavba" mixing construction/floor-finish rows) the
 * ABF proposedCode's family prefix — never from guessing at the Czech word's meaning beyond
 * these explicit, reviewable rules.
 */
export function classifyPricelistItemKind(row: Pick<Batch2bSourceRow, "category" | "proposedCode">): CategoryKindClassification {
  const code = row.proposedCode ?? "";
  if (row.category === "Typovky") return { kind: "booth", confident: true, reason: "category=Typovky (typová řada stánků)" };
  if (code === "M01" || code === "M02") return { kind: "floor_finish", confident: true, reason: "koberec = floor_finish (dedikovaný kind)" };
  if (row.category === "Stavba" && code.startsWith("S")) return { kind: "construction", confident: true, reason: "ABF kód s prefixem S = stavba/construction service" };
  if (row.category === "Stavba") return { kind: "construction", confident: true, reason: "category=Stavba (stropní podhled/závěs = booth fit-out, construction)" };
  if (row.category === "Úvaz") return { kind: "construction", confident: true, reason: "category=Úvaz (rigging/příhradovina = construction)" };
  if (row.category === "Světlo") return { kind: "other", confident: false, reason: "category=Světlo (osvětlení/elektro) — model nemá dedikovaný lighting/electrical kind, needs_review klasifikace" };
  if (row.category === "Octanorm" || row.category === "Nábytek" || row.category === "Kuchyňka" || row.category === "Ostatní") {
    return { kind: "furniture", confident: true, reason: `category=${row.category}` };
  }
  return { kind: "other", confident: false, reason: `neznámá/needs_review kategorie "${row.category}" — bezpečně nepřevoditelná na existující kind, needs_review` };
}

// ============================================================================
// DIMENSION EXTRACTION — only ever reads an already-present, unambiguous pattern out of the
// ABF proposedName text. Never invents a missing axis, never guesses from a partial match.
// ============================================================================

export type PlannedDimensions = Readonly<{ widthMm: number; depthMm: number; heightMm?: number }>;

/** Furniture/component pattern: "... 100X100X250 cm ..." (three axes, centimeters). */
export function parseFurnitureDimensionsFromAbfName(name: string | null | undefined): PlannedDimensions | undefined {
  if (!name) return undefined;
  const match = name.match(/(\d+(?:[.,]\d+)?)\s*[X×]\s*(\d+(?:[.,]\d+)?)\s*[X×]\s*(\d+(?:[.,]\d+)?)\s*cm/iu);
  if (!match) return undefined;
  const [, w, d, h] = match;
  const toMm = (value: string) => Math.round(Number(value.replace(",", ".")) * 10);
  return { widthMm: toMm(w!), depthMm: toMm(d!), heightMm: toMm(h!) };
}

/** Typová řada booth pattern: "... 2X2 m ..." (two axes, meters, no height in the source name). */
export function parseBoothFootprintFromAbfName(name: string | null | undefined): PlannedDimensions | undefined {
  if (!name) return undefined;
  const match = name.match(/(\d+(?:[.,]\d+)?)\s*[X×]\s*(\d+(?:[.,]\d+)?)\s*m\b/iu);
  if (!match) return undefined;
  const [, w, d] = match;
  const toMm = (value: string) => Math.round(Number(value.replace(",", ".")) * 1000);
  return { widthMm: toMm(w!), depthMm: toMm(d!) };
}

function parseDimensions(row: Pick<Batch2bSourceRow, "proposedName">, kind: CatalogItemKind): PlannedDimensions | undefined {
  if (kind === "booth") return parseBoothFootprintFromAbfName(row.proposedName);
  return parseFurnitureDimensionsFromAbfName(row.proposedName);
}

// ============================================================================
// PLAN ITEM — the shape written to import-batch2b-plan.json (section 16).
// ============================================================================

export type Batch2bPlanStatus = "exact_safe" | "review" | "skip_existing" | "conflict";
export type Batch2bPlanAction = "insert" | "update" | "noop" | "skip" | "review";
export type Batch2bAssetStatus = "missing" | "reused-from-seed";

export type Batch2bPlanItem = Readonly<{
  source: string;
  sourceRow: number;
  sourceCategory: string;
  sourceName: string;
  status: Batch2bPlanStatus;
  internalCode: string | null;
  catalogTarget?: string;
  catalogKind: CatalogItemKind | null;
  action: Batch2bPlanAction;
  lifecycleStatus: CatalogItemStatus | null;
  generatorEligible: boolean;
  dimensions?: PlannedDimensions;
  unit: string | null;
  pricingUnit: string | null;
  assetStatus: Batch2bAssetStatus;
  sourceKey: string;
  reasons: readonly string[];
  warnings: readonly string[];
}>;

function sourceRowKey(row: Pick<Batch2bSourceRow, "category" | "nameCz">): string {
  return buildMappingSourceKey({ sourceSheet: PRICELIST_SOURCE_SHEET, category: row.category, rawName: row.nameCz });
}

/**
 * One PRICELIST row -> one plan item. Never called for "T. služby" rows (see
 * isBatch2bEligibleRow) — those are Batch #2A's, not this module's.
 */
export function planPricelistItem(
  row: Batch2bSourceRow,
  existingCatalogItems: readonly ExistingCatalogItemRow[],
): Batch2bPlanItem {
  const sourceKey = sourceRowKey(row);
  const base = {
    source: PRICELIST_SOURCE_SHEET,
    sourceRow: row.sourceRow,
    sourceCategory: row.category,
    sourceName: row.nameCz,
    unit: row.unit,
    sourceKey,
  };

  if (row.status === "REVIEW") {
    return {
      ...base,
      status: "review",
      internalCode: null,
      catalogKind: null,
      action: "review",
      lifecycleStatus: null,
      generatorEligible: false,
      pricingUnit: null,
      assetStatus: "missing",
      reasons: [`ABF matching status=REVIEW (navržený kód "${row.proposedCode ?? "?"}" je jen kandidát, ne potvrzená identita) — vyžaduje ruční rozhodnutí, NEIMPORTOVÁNO jako approved identity.`],
      warnings: [],
    };
  }

  if (row.status === "NO_MATCH") {
    return {
      ...base,
      status: "review",
      internalCode: null,
      catalogKind: null,
      action: "skip",
      lifecycleStatus: null,
      generatorEligible: false,
      pricingUnit: null,
      assetStatus: "missing",
      reasons: ["ABF matching status=NO_MATCH — žádný bezpečný kód, položka se neimportuje."],
      warnings: [],
    };
  }

  // EXACT_SAFE
  const internalCode = row.proposedCode;
  if (!internalCode) {
    return {
      ...base,
      status: "conflict",
      internalCode: null,
      catalogKind: null,
      action: "review",
      lifecycleStatus: null,
      generatorEligible: false,
      pricingUnit: null,
      assetStatus: "missing",
      reasons: ["EXACT_SAFE řádek bez proposedCode — interní nesrovnalost zdrojového reportu, vyžaduje ruční review před jakýmkoli zápisem."],
      warnings: [],
    };
  }

  const classification = classifyPricelistItemKind(row);
  const dimensions = parseDimensions(row, classification.kind);
  const existing = resolveExistingCatalogItem({ internalCode, sourceSystem: BATCH2B_SOURCE_SYSTEM, sourceKey }, existingCatalogItems);
  const warnings = classification.confident ? [] : [classification.reason];

  if (existing) {
    return {
      ...base,
      status: "skip_existing",
      internalCode,
      catalogTarget: existing.id,
      catalogKind: existing.kind ?? classification.kind,
      action: "noop",
      lifecycleStatus: null,
      generatorEligible: false,
      dimensions,
      pricingUnit: row.proposedUnit,
      assetStatus: "missing",
      reasons: [`internalCode "${internalCode}" už existuje v DB (catalog_item ${existing.id}) — z Batch #2A nebo dřívějšího batche. Resolve na existující položku, žádný duplicitní insert.`],
      warnings,
    };
  }

  return {
    ...base,
    status: "exact_safe",
    internalCode,
    catalogKind: classification.kind,
    action: "insert",
    lifecycleStatus: "needs_review",
    generatorEligible: false,
    dimensions,
    pricingUnit: row.proposedUnit,
    assetStatus: "missing",
    reasons: [`Nová needs_review položka — ABF EXACT_SAFE kód "${internalCode}" potvrzen name+specs matchingem, ale generatorEligible zůstává false, dokud nesplní readiness pravidla a neprojde ručním review.`],
    warnings,
  };
}

export function planPricelistItems(
  rows: readonly Batch2bSourceRow[],
  existingCatalogItems: readonly ExistingCatalogItemRow[],
): readonly Batch2bPlanItem[] {
  return rows.filter(isBatch2bEligibleRow).map((row) => planPricelistItem(row, existingCatalogItems));
}

// ============================================================================
// P86 — CANONICAL EXPLICIT CASE (section 5). Never derived from this session's fuzzy
// name-matching report (P86 only ever appears there as a low-score ALTERNATIVE for an
// unrelated "Stavba octanorm" row, never as anyone's primary EXACT_SAFE match) — its identity
// comes from a direct ABF-code lookup against the warehouse export plus the existing,
// already-shipped static seed in data/booths.ts.
// ============================================================================

/**
 * Minimal ComponentDefinition-shaped adapter for readiness checks — mirrors the established
 * scripts/importPreviewV66.ts stubFromRow() pattern, except every field here is the REAL P86
 * seed value (dimensions/GLB/category), never a zeroed-out placeholder, since P86 already has
 * a complete, shipped static definition in data/booths.ts.
 */
function readinessAdapterForBooth(booth: BoothType): ComponentDefinition {
  return {
    id: booth.id,
    internalCode: booth.internalCode,
    displayName: booth.name,
    type: "booth",
    name: booth.name,
    category: booth.category ?? booth.projectType,
    widthMm: booth.widthMm ?? 0,
    depthMm: booth.depthMm ?? 0,
    heightMm: booth.heightMm ?? undefined,
    resizable: false,
    productionProfiles: {},
    rotation: { defaultMode: "free", snapStep: 45, quickAngles: [0], allowFreeRotation: true, locked: false },
    systemLocked: booth.systemLocked,
    userLocked: booth.userLocked,
    visible: booth.visible,
    sceneLabel: booth.name,
    unit: "ks",
    modelUrl: booth.modelUrl,
    active: booth.active,
    lifecycleStatus: undefined,
  } as ComponentDefinition;
}

export function planP86Canonical(
  koje2x2: BoothType,
  existingCatalogItems: readonly ExistingCatalogItemRow[],
): Batch2bPlanItem {
  const sourceKey = buildMappingSourceKey({ sourceSheet: "ABF_WAREHOUSE_EXPORT", category: "Canonical", rawName: "P86 KOJE4 KÓJE 2X2" });
  const existing = resolveExistingCatalogItem({ internalCode: "P86", sourceSystem: BATCH2B_SOURCE_SYSTEM, sourceKey }, existingCatalogItems);
  const readinessDocument = readinessAdapterForBooth(koje2x2);
  const readiness = evaluateCatalogReadiness(readinessDocument, "booth");
  const generatorEligible = isGeneratorEligible(readinessDocument, "booth");
  const reasons = [
    "P86 = KÓJE 2X2 potvrzeno PŘÍMÝM ABF kódovým lookupem (private-imports/vyjezd abry sklad.xlsx, řádek s kódem P86, zkratka KOJE4) — NIKDY z fuzzy name/matching reportu.",
    "P86 se nesmí zaměnit s P84 (KÓJE 2X2 JOBS, zkratka KOJE4JOBS) ani P85 (KÓJE 3X2 JOBS) — tři odlišné položky ve stejném ABF exportu, ověřeno explicitně řádek po řádku.",
    "Existující static seed data/booths.ts (id=koje-2x2) obsahuje kompletní business definici — package rules (šedý koberec 4 m², stavba stánku, límec grafika 2 bm, PrintSurface 2000×300) se přebírají beze změny, negenerují se znovu.",
  ];
  if (existing) {
    return {
      source: "ABF_WAREHOUSE_EXPORT", sourceRow: -1, sourceCategory: "Canonical", sourceName: "Kóje 2 × 2 m (P86)",
      status: "skip_existing", internalCode: "P86", catalogTarget: existing.id, catalogKind: "booth", action: "noop",
      lifecycleStatus: null, generatorEligible: false,
      dimensions: { widthMm: koje2x2.widthMm, depthMm: koje2x2.depthMm, heightMm: koje2x2.heightMm },
      unit: "ks", pricingUnit: "ks", assetStatus: "reused-from-seed", sourceKey,
      reasons: [...reasons, `internalCode "P86" už existuje v DB (catalog_item ${existing.id}) — žádný duplicitní insert.`],
      warnings: [],
    };
  }
  return {
    source: "ABF_WAREHOUSE_EXPORT", sourceRow: -1, sourceCategory: "Canonical", sourceName: "Kóje 2 × 2 m (P86)",
    status: "exact_safe", internalCode: "P86", catalogKind: "booth", action: "insert",
    // P86 mirrors M57/L02's Batch #2A treatment: an already-approved, already-shipped
    // canonical reference, not a fresh needs_review candidate — lifecycleStatus/generatorEligible
    // are the REAL computed values (evaluateCatalogReadiness/isGeneratorEligible against the
    // actual koje-2x2 seed object), never hardcoded.
    lifecycleStatus: readiness.ready ? "active" : "needs_review",
    generatorEligible,
    dimensions: { widthMm: koje2x2.widthMm, depthMm: koje2x2.depthMm, heightMm: koje2x2.heightMm },
    unit: "ks", pricingUnit: "ks", assetStatus: "reused-from-seed", sourceKey,
    reasons,
    warnings: ["P86 zatím NEEXISTUJE jako catalog_item v remote DB — insert by vyžadoval budoucí Batch #2B --apply, který v této session neproběhl (DATABASE WRITES = 0)."],
  };
}

// ============================================================================
// PREFLIGHT / CONFLICT DETECTION (section 15) — pure, runs over the whole planned set before
// any hypothetical apply. Never a silent merge; every conflict is a STOP for that item.
// ============================================================================

export type Batch2bConflict = Readonly<{
  kind: "duplicate_internal_code_in_plan" | "duplicate_source_key_in_plan" | "db_internal_code_collision";
  internalCode?: string;
  sourceKey?: string;
  items: readonly Readonly<{ sourceRow: number; sourceName: string }>[];
  reason: string;
}>;

export function detectBatch2bConflicts(
  items: readonly Batch2bPlanItem[],
  existingCatalogItems: readonly ExistingCatalogItemRow[],
): readonly Batch2bConflict[] {
  const conflicts: Batch2bConflict[] = [];
  const plannedInserts = items.filter((item) => item.action === "insert" && item.internalCode);

  const byCode = new Map<string, Batch2bPlanItem[]>();
  for (const item of plannedInserts) {
    const code = item.internalCode!;
    byCode.set(code, [...(byCode.get(code) ?? []), item]);
  }
  for (const [code, group] of byCode) {
    if (group.length > 1) {
      conflicts.push({
        kind: "duplicate_internal_code_in_plan",
        internalCode: code,
        items: group.map((item) => ({ sourceRow: item.sourceRow, sourceName: item.sourceName })),
        reason: `internalCode "${code}" je navržen pro vložení vícekrát v jednom Batch #2B plánu — konflikt, žádná položka se nezapíše bez ručního review.`,
      });
    }
  }

  const bySourceKey = new Map<string, Batch2bPlanItem[]>();
  for (const item of items) {
    bySourceKey.set(item.sourceKey, [...(bySourceKey.get(item.sourceKey) ?? []), item]);
  }
  for (const [key, group] of bySourceKey) {
    if (group.length > 1) {
      conflicts.push({
        kind: "duplicate_source_key_in_plan",
        sourceKey: key,
        items: group.map((item) => ({ sourceRow: item.sourceRow, sourceName: item.sourceName })),
        reason: `sourceKey "${key}" se v plánu opakuje pro více zdrojových řádků — reimport identita by byla nejednoznačná.`,
      });
    }
  }

  const existingCodes = new Set(existingCatalogItems.map((row) => row.internalCode).filter((code): code is string => Boolean(code)));
  for (const item of plannedInserts) {
    const code = item.internalCode!;
    if (existingCodes.has(code)) {
      conflicts.push({
        kind: "db_internal_code_collision",
        internalCode: code,
        items: [{ sourceRow: item.sourceRow, sourceName: item.sourceName }],
        reason: `internalCode "${code}" je navržen jako NOVÝ insert, ale už existuje v remote DB — mělo by to být resolvováno jako skip_existing/noop, ne insert. Interní chyba plánování.`,
      });
    }
  }

  return conflicts;
}

// ============================================================================
// CATEGORY REPORT (section 17) — grouping for the human-readable summary.
// ============================================================================

export type Batch2bCategoryGroup = "Furniture" | "Construction / Octanorm" | "Booths / Txx" | "Other" | "REVIEW" | "NO_MATCH";

export function categoryGroupFor(item: Batch2bPlanItem): Batch2bCategoryGroup {
  if (item.status === "review" && item.action === "review") return "REVIEW";
  if (item.status === "review" && item.action === "skip") return "NO_MATCH";
  if (item.catalogKind === "booth") return "Booths / Txx";
  if (item.catalogKind === "construction" || item.catalogKind === "floor_finish") return "Construction / Octanorm";
  if (item.catalogKind === "furniture") return "Furniture";
  return "Other";
}

export type Batch2bCategorySummary = Readonly<{
  group: Batch2bCategoryGroup;
  sourceCount: number;
  exactSafeCount: number;
  plannedInserts: number;
  existingNoop: number;
  needsReview: number;
  generatorEligible: number;
  missingDimensions: number;
  missingAssets: number;
}>;

export function summarizeByCategoryGroup(items: readonly Batch2bPlanItem[]): readonly Batch2bCategorySummary[] {
  const groups = new Map<Batch2bCategoryGroup, Batch2bPlanItem[]>();
  for (const item of items) {
    const group = categoryGroupFor(item);
    groups.set(group, [...(groups.get(group) ?? []), item]);
  }
  return [...groups.entries()].map(([group, groupItems]) => ({
    group,
    sourceCount: groupItems.length,
    exactSafeCount: groupItems.filter((item) => item.status === "exact_safe" || item.status === "skip_existing").length,
    plannedInserts: groupItems.filter((item) => item.action === "insert").length,
    existingNoop: groupItems.filter((item) => item.action === "noop").length,
    needsReview: groupItems.filter((item) => item.lifecycleStatus === "needs_review").length,
    generatorEligible: groupItems.filter((item) => item.generatorEligible).length,
    missingDimensions: groupItems.filter((item) => (item.status === "exact_safe" || item.status === "skip_existing") && !item.dimensions).length,
    missingAssets: groupItems.filter((item) => item.assetStatus === "missing" && (item.status === "exact_safe" || item.status === "skip_existing")).length,
  }));
}
