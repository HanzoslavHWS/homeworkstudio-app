/**
 * Import Batch #2A planning — DRY-RUN ONLY.
 *
 * Scope: canonical M57/L02 catalog_items (existing hardcoded seeds in data/components.ts,
 * never yet persisted as catalog_items rows), the 23 technical-service source identities
 * from the CZK/EUR sheets (already staged in Batch #1's import_rows) — 1 mapped onto
 * canonical L02, 22 planned as brand-new needs_review service catalog_items — and the 495
 * fixed pricing_entries they resolve to against the 28 PriceLists Batch #1 already created.
 *
 * Every one of the 495 planned pricing_entries carries a REAL planned catalog_item target
 * (one of the 24: M57, L02, or one of the 22 new technical-service candidates) — a
 * pricing_entry with no catalog identity would be an anonymous number nobody could ever
 * trace back to "which service", which is exactly what Batch #1 refused to write. See
 * section 6 of the Batch #2A follow-up spec.
 *
 * The apply writer counterpart lives in lib/db/importBatch2a.supabase.ts (thin I/O only) —
 * every RESOLUTION decision (insert/noop/conflict for a catalog_item, insert/update/noop for
 * a pricing_entry) is computed here as a pure function first, so it is fully unit-testable
 * without touching Supabase, and the I/O layer just executes what these functions decide.
 * Pure, no I/O, no Date.now()/crypto — every function here takes plain data in (including
 * any timestamp it needs) and returns plain data out.
 *
 * OUT OF SCOPE (must stay untouched): P86, the ~93 other PRICELIST rows, booths, furniture
 * other than M57, the whole PRICELIST catalog. See buildBatch2aPlan()'s warnings.
 */
import type { CatalogItemKind, ComponentDefinition, Currency } from "./models.ts";
import { evaluateCatalogReadiness, isGeneratorEligible, type ReadinessResult } from "./catalogReadiness.ts";
import { buildMappingSourceKey, normalizedMappingName, type ImportPreview, type ImportTechnicalServiceRowPreview } from "./importBatch.ts";
import type { MappingDecision } from "./importBatch1.ts";

const CANONICAL_INTERNAL_CODES = ["M57", "L02"] as const;
export type CanonicalInternalCode = (typeof CANONICAL_INTERNAL_CODES)[number];

const TECHNICAL_SERVICE_SOURCE_SHEET = "TECHNICAL-SERVICE";

/** Same source system Batch #1 used (domain/importBatch1.ts's BATCH1_SOURCE_SYSTEM) — these technical-service candidates come from the same workbook. */
export const BATCH2A_SOURCE_SYSTEM = "excel-v6.6";

// ============================================================================
// 1. CANONICAL M57 / L02 — DB representation of the EXISTING hardcoded seeds.
// ============================================================================

export type ExistingCatalogItemRow = Readonly<{ id: string; internalCode?: string; sourceSystem?: string; sourceKey?: string; kind?: CatalogItemKind }>;

/**
 * Section 2 (stable reimport identity): "1. confirmed internalCode pokud existuje, 2. jinak
 * sourceSystem + sourceKey. Nikdy pouze normalized name." Applies to any catalog item this
 * batch plans, canonical or technical-service — normalized display name is NEVER a lookup
 * key here, because two genuinely different items can share a near-identical name (see the
 * kettle-vs-L02 false positive Batch #1 already guarded against).
 */
export function resolveExistingCatalogItem(
  candidate: Readonly<{ internalCode: string | null; sourceSystem: string; sourceKey: string }>,
  existing: readonly ExistingCatalogItemRow[],
): ExistingCatalogItemRow | undefined {
  if (candidate.internalCode) {
    const byCode = existing.find((row) => row.internalCode === candidate.internalCode);
    if (byCode) return byCode;
  }
  return existing.find((row) => row.sourceSystem === candidate.sourceSystem && row.sourceKey === candidate.sourceKey);
}

export type CatalogItemResolution = Readonly<{
  action: "insert" | "noop" | "conflict";
  existingId?: string;
  conflictReason?: string;
}>;

/**
 * Section 3: "Pokud existující DB položka se stejným internalCode má jiný význam: STOP /
 * conflict. Nikdy ji automaticky nepřepiš." — the apply writer NEVER blindly upserts a
 * catalog_item; it always resolves first (pure, here) and only ever inserts a genuinely new
 * row or no-ops onto a matching one. A same-identity row with a DIFFERENT kind (e.g. an
 * internal_code accidentally reused for a different physical item) is a conflict, not a
 * silent overwrite.
 */
export function resolveCatalogItemForApply(
  candidate: Readonly<{ internalCode: string | null; sourceSystem: string; sourceKey: string; kind: CatalogItemKind }>,
  existing: readonly ExistingCatalogItemRow[],
): CatalogItemResolution {
  const existingRow = resolveExistingCatalogItem(candidate, existing);
  if (!existingRow) return { action: "insert" };
  if (existingRow.kind && existingRow.kind !== candidate.kind) {
    return {
      action: "conflict",
      existingId: existingRow.id,
      conflictReason: `existující catalog_item (id=${existingRow.id}) má kind="${existingRow.kind}", očekáváno "${candidate.kind}" — internalCode/sourceKey kolize s jiným významem, apply zastaven.`,
    };
  }
  return { action: "noop", existingId: existingRow.id };
}

export type PricingEntryResolution = Readonly<{ action: "insert" | "update" | "noop"; existingId?: string }>;
export type ExistingPricingEntryRow = Readonly<{ id: string; catalogItemId: string; priceListId: string; eventId: string; currency: Currency; salePrice: number | null }>;

/**
 * Section 9: "Stejná kombinace catalog item + price list + pricing context nesmí vytvořit
 * duplicate pricing_entry." pricing_entries has NO unique DB constraint on this natural key,
 * so idempotency is enforced here, at the application level, before every write — identical
 * price -> noop, changed price -> update (never a second row), no match -> insert.
 */
export function resolvePricingEntryForApply(
  candidate: Readonly<{ catalogItemId: string; priceListId: string; eventId: string; currency: Currency; salePrice: number }>,
  existing: readonly ExistingPricingEntryRow[],
): PricingEntryResolution {
  const match = existing.find(
    (row) => row.catalogItemId === candidate.catalogItemId && row.priceListId === candidate.priceListId && row.eventId === candidate.eventId && row.currency === candidate.currency,
  );
  if (!match) return { action: "insert" };
  if (match.salePrice === candidate.salePrice) return { action: "noop", existingId: match.id };
  return { action: "update", existingId: match.id };
}

export type PlannedCanonicalCatalogItem = Readonly<{
  internalCode: CanonicalInternalCode;
  action: "insert" | "noop";
  kind: CatalogItemKind;
  document: ComponentDefinition;
  readiness: ReadinessResult;
  generatorEligible: boolean;
  existingId?: string;
}>;

/**
 * Section 1/3/4: the DB row content mirrors the existing seed object (data/components.ts) —
 * it is never re-derived from Excel; Excel only ever supplies a *candidate match* to this
 * canonical item, never its content. `action: "noop"` when a row with this internal_code
 * already exists — this can never propose a second M57 or L02.
 *
 * M57 is our manually built/verified canonical reference component (section 3): it is
 * treated as already human-reviewed, so its planned document carries an explicit
 * `reviewedAt` (passed in, never generated internally — this function stays pure/deterministic)
 * instead of the seed's current `undefined`. generatorEligible is computed the normal way
 * (isGeneratorEligible) — for a legacy seed with no lifecycleStatus that is already `true`
 * regardless of readiness, exactly "podle canonical definice", nothing special-cased here.
 * L02 needs no such override — "service" kind readiness never checks reviewedAt at all.
 */
export function planCanonicalCatalogItems(
  seeds: readonly ComponentDefinition[],
  existing: readonly ExistingCatalogItemRow[],
  manualReviewTimestamp: string,
): readonly PlannedCanonicalCatalogItem[] {
  return CANONICAL_INTERNAL_CODES.map((code) => {
    const seed = seeds.find((item) => item.internalCode === code);
    if (!seed) throw new Error(`Canonical seed ${code} nenalezen v data/components.ts — Batch #2A na něm závisí.`);
    const kind: CatalogItemKind = code === "M57" ? "furniture" : "service";
    const document: ComponentDefinition = code === "M57" ? { ...seed, reviewedAt: seed.reviewedAt ?? manualReviewTimestamp } : seed;
    const existingRow = existing.find((row) => row.internalCode === code);
    return {
      internalCode: code,
      action: existingRow ? "noop" : "insert",
      kind,
      document,
      readiness: evaluateCatalogReadiness(document, kind),
      generatorEligible: isGeneratorEligible(document, kind),
      existingId: existingRow?.id,
    } satisfies PlannedCanonicalCatalogItem;
  });
}

// ============================================================================
// 2. TECHNICAL SERVICES — 23 source identities from the CZK/EUR sheets.
//    1 maps onto canonical L02 (no new catalog_item). 22 become new needs_review service
//    catalog_items — real DB identities, so the 495 pricing_entries have somewhere to point.
// ============================================================================

export type UnitConfidence = "low" | "medium" | "high";

/** One row from private-imports/code-matching-report.json's technicalServices[] — the ABF warehouse matching analysis, source of truth for internalCode. */
export type AbfTechnicalServiceMatch = Readonly<{
  nameCz: string;
  status: "EXACT_SAFE" | "REVIEW" | "NO_MATCH";
  proposedCode: string | null;
  proposedName: string | null;
}>;

export type PlannedTechnicalService = Readonly<{
  sourceKey: string;
  sourceSystem: string;
  nameCz: string;
  nameEn: string | null;
  canonicalName: string;
  kind: CatalogItemKind;
  pricingUnit: ComponentDefinition["pricingUnit"];
  internalCode: string | null;
  /** Where an ABF code came from, purely for reporting — never used as a lookup key by itself. */
  abfMatchStatus: "EXACT_SAFE" | "REVIEW" | "NO_MATCH";
  /** Stable reimport identity actually usable for this item: internalCode when confirmed, sourceKey when not — see resolveExistingCatalogItem(). Never "name". */
  identityBasis: "internalCode" | "sourceKey";
  /** True for the 22 brand-new candidates; false for the 1 row mapped onto an existing canonical item (no new catalog_item is planned for it). */
  isNewCatalogItem: boolean;
  action: "insert" | "noop" | "mapped_to_existing_canonical";
  lifecycleStatus: "needs_review" | null;
  mappedCanonicalCode?: CanonicalInternalCode;
  /** Only present for the 22 new candidates — the catalog_items.document this batch would insert. */
  document?: ComponentDefinition;
  readiness: ReadinessResult;
  generatorEligible: boolean;
  unitConfidence: UnitConfidence;
  unitReason: string;
  existingId?: string;
}>;

function stubTechnicalServiceItem(sourceKey: string, rawName: string, internalCode: string | null): ComponentDefinition {
  return {
    id: `technical-service-stub-${sourceKey}`,
    internalCode: internalCode ?? undefined,
    displayName: rawName,
    type: "service",
    name: rawName,
    category: "T. služby",
    widthMm: 0,
    depthMm: 0,
    resizable: false,
    productionProfiles: {},
    rotation: { defaultMode: "free", snapStep: 45, quickAngles: [0], allowFreeRotation: true, locked: false },
    systemLocked: false,
    userLocked: false,
    visible: true,
    sceneLabel: rawName,
    unit: undefined,
    pricingUnit: undefined,
    pricingEntries: [],
    catalogItemType: "service",
    lifecycleStatus: "needs_review",
    catalogItemKind: "service",
    // No GLB/3D requirement (section 2) — showIn2D/showIn3D deliberately left unset, this is
    // an order-line service, never a spatial scene object (mirrors the real L02 seed).
  } as ComponentDefinition;
}

/**
 * Section 1/2/9: internalCode comes from EXACTLY ONE source per row — a Batch #1 confirmed
 * canonical mapping (only "Přípojka el. energie - 2kW" → L02), OR an EXACT_SAFE row in the
 * ABF matching report (private-imports/code-matching-report.json). A REVIEW candidate is
 * NEVER used as a real code — internalCode stays NULL exactly like NO_MATCH. Getting a real
 * ABF code does NOT flip generatorEligible/lifecycleStatus — a code is a catalog identity,
 * not a human approval to activate (section 9). Every row keeps a stable identity even at
 * internalCode=NULL via sourceKey (identityBasis), so a re-run can never duplicate it —
 * resolveExistingCatalogItem() is the only sanctioned lookup, name is never used.
 */
export function planTechnicalServices(
  rows: readonly ImportTechnicalServiceRowPreview[],
  decisions: readonly MappingDecision[],
  abfMatches: ReadonlyMap<string, AbfTechnicalServiceMatch> = new Map(),
  existingCatalogItems: readonly ExistingCatalogItemRow[] = [],
): readonly PlannedTechnicalService[] {
  const confirmedByName = new Map(
    decisions.filter((d) => d.decision === "confirmed").map((d) => [normalizedMappingName(d.identity.rawName), d.targetInternalCode]),
  );
  return rows.map((row) => {
    const mappedCode = confirmedByName.get(normalizedMappingName(row.rawName)) as CanonicalInternalCode | undefined;
    const sourceKey = buildMappingSourceKey({ sourceSheet: TECHNICAL_SERVICE_SOURCE_SHEET, rawName: row.rawName });
    const isNewCatalogItem = !mappedCode;

    const abfMatch = abfMatches.get(row.rawName);
    const abfExactCode = abfMatch?.status === "EXACT_SAFE" ? abfMatch.proposedCode : null;
    const internalCode = mappedCode ?? abfExactCode ?? null;
    const abfMatchStatus = abfMatch?.status ?? "NO_MATCH";

    const document = isNewCatalogItem ? stubTechnicalServiceItem(sourceKey, row.rawName, abfExactCode) : undefined;
    const readinessTarget = document ?? stubTechnicalServiceItem(sourceKey, row.rawName, null);

    const existingRow = isNewCatalogItem
      ? resolveExistingCatalogItem({ internalCode, sourceSystem: BATCH2A_SOURCE_SYSTEM, sourceKey }, existingCatalogItems)
      : undefined;

    const canonicalName = mappedCode === "L02" ? "Elektrická energie – příkon do 2 kW / 230 V" : abfExactCode ? (abfMatch!.proposedName ?? row.rawName) : row.rawName;

    return {
      sourceKey,
      sourceSystem: BATCH2A_SOURCE_SYSTEM,
      nameCz: row.rawName,
      nameEn: null,
      canonicalName,
      kind: "service",
      pricingUnit: undefined,
      internalCode,
      abfMatchStatus,
      identityBasis: internalCode ? "internalCode" : "sourceKey",
      isNewCatalogItem,
      action: !isNewCatalogItem ? "mapped_to_existing_canonical" : existingRow ? "noop" : "insert",
      lifecycleStatus: isNewCatalogItem ? "needs_review" : null,
      mappedCanonicalCode: mappedCode,
      document,
      readiness: evaluateCatalogReadiness(readinessTarget, "service"),
      generatorEligible: false,
      unitConfidence: "low",
      unitReason: "CZK/EUR sheet neobsahuje sloupec jednotky — žádná jednotka nebyla ze zdroje potvrzena; domýšlet 'piece' by bylo hádání, ne potvrzený fakt.",
      existingId: existingRow?.id,
    } satisfies PlannedTechnicalService;
  });
}

// ============================================================================
// REIMPORT / IDENTITY SUMMARY — section 2/11: duplicate-risk proof for the report.
// ============================================================================

export type ReimportSummary = Readonly<{
  identityByInternalCode: number;
  identityBySourceKeyOnly: number;
  duplicateInternalCodes: readonly string[];
  duplicateSourceKeys: readonly string[];
}>;

export function summarizeReimportIdentity(technicalServices: readonly PlannedTechnicalService[]): ReimportSummary {
  const newItems = technicalServices.filter((s) => s.isNewCatalogItem);
  const identityByInternalCode = newItems.filter((s) => s.identityBasis === "internalCode").length;
  const identityBySourceKeyOnly = newItems.filter((s) => s.identityBasis === "sourceKey").length;

  const codeCounts = new Map<string, number>();
  for (const s of newItems) if (s.internalCode) codeCounts.set(s.internalCode, (codeCounts.get(s.internalCode) ?? 0) + 1);
  const duplicateInternalCodes = [...codeCounts.entries()].filter(([, count]) => count > 1).map(([code]) => code);

  const keyCounts = new Map<string, number>();
  for (const s of newItems) keyCounts.set(s.sourceKey, (keyCounts.get(s.sourceKey) ?? 0) + 1);
  const duplicateSourceKeys = [...keyCounts.entries()].filter(([, count]) => count > 1).map(([key]) => key);

  return { identityByInternalCode, identityBySourceKeyOnly, duplicateInternalCodes, duplicateSourceKeys };
}

// ============================================================================
// CATALOG ITEMS SUMMARY — section 6: total planned catalog_items = 24 (M57 + L02 + 22).
// ============================================================================

export type CatalogItemsSummary = Readonly<{
  canonical: number;
  technicalServiceCandidates: number;
  technicalServiceCandidatesWithAbfCode: number;
  technicalServiceCandidatesWithoutAbfCode: number;
  total: number;
}>;

export function summarizeCatalogItems(
  canonicalCatalogItems: readonly PlannedCanonicalCatalogItem[],
  technicalServices: readonly PlannedTechnicalService[],
): CatalogItemsSummary {
  const newItems = technicalServices.filter((s) => s.isNewCatalogItem);
  const technicalServiceCandidatesWithAbfCode = newItems.filter((s) => s.internalCode !== null).length;
  return {
    canonical: canonicalCatalogItems.length,
    technicalServiceCandidates: newItems.length,
    technicalServiceCandidatesWithAbfCode,
    technicalServiceCandidatesWithoutAbfCode: newItems.length - technicalServiceCandidatesWithAbfCode,
    total: canonicalCatalogItems.length + newItems.length,
  };
}

// ============================================================================
// 3. PRICING PLAN — 495 fixed pricing_entries. Missing NEVER creates a row, NEVER becomes 0.
// ============================================================================

export type ExistingEventRow2A = Readonly<{ id: string; sourceKey: string; year: number }>;
export type ExistingPriceListRow2A = Readonly<{ id: string; code: string; currency: Currency; eventId: string | null }>;

export type PlannedPricingEntry = Readonly<{
  technicalServiceSourceKey: string;
  eventSourceKey: string;
  currency: Currency;
  /** "M57"/"L02" for the canonical-mapped row, otherwise the technical service's own sourceKey — always one of the 24 planned catalog_items, never a dangling reference. */
  catalogItemRef: string;
  priceListId: string;
  eventId: string;
  salePrice: number;
  priceMode: "fixed";
  pricingUnit: undefined;
  source: Readonly<{ sourceSheet: Currency; rawName: string }>;
}>;

export type PricingPlanValidation = Readonly<{
  currencyMismatches: readonly string[];
  orphanPricingSourceKeys: readonly string[];
  /** Entries whose catalogItemRef doesn't resolve to any of the 24 planned catalog_items — must always be empty (section 6: "catalog target missing = 0"). */
  catalogTargetMissing: readonly string[];
}>;

export type PricingPlanCounts = Readonly<{
  czkFixed: number;
  eurFixed: number;
  totalFixed: number;
  czkMissing: number;
  eurMissing: number;
  totalMissing: number;
}>;

export type PricingPlan = Readonly<{
  entries: readonly PlannedPricingEntry[];
  counts: PricingPlanCounts;
  validation: PricingPlanValidation;
}>;

/**
 * Section 3/6: never crosses currency (a CZK amount only ever resolves against a CZK
 * PriceList of the SAME event, same for EUR — no conversion, ever) and never invents a price
 * for a "missing" cell. Every produced entry's catalogItemRef is validated against the set of
 * 24 planned catalog_items (validKnownCatalogRefs) — anything that wouldn't resolve is
 * reported in catalogTargetMissing instead of silently entering the plan.
 */
export function planPricingEntries(
  rows: readonly ImportTechnicalServiceRowPreview[],
  technicalServices: readonly PlannedTechnicalService[],
  existingEvents: readonly ExistingEventRow2A[],
  existingPriceLists: readonly ExistingPriceListRow2A[],
): PricingPlan {
  const eventBySourceKey = new Map(existingEvents.map((event) => [event.sourceKey, event]));
  const priceListByEventAndCurrency = new Map<string, ExistingPriceListRow2A>();
  for (const priceList of existingPriceLists) {
    const event = existingEvents.find((candidate) => candidate.id === priceList.eventId);
    if (event) priceListByEventAndCurrency.set(`${event.sourceKey}::${priceList.currency}`, priceList);
  }
  const serviceBySourceKey = new Map(
    technicalServices.map((service) => [buildMappingSourceKey({ sourceSheet: TECHNICAL_SERVICE_SOURCE_SHEET, rawName: service.nameCz }), service]),
  );
  const validKnownCatalogRefs = new Set<string>([...CANONICAL_INTERNAL_CODES, ...technicalServices.filter((s) => s.isNewCatalogItem).map((s) => s.sourceKey)]);

  const entries: PlannedPricingEntry[] = [];
  const currencyMismatches: string[] = [];
  const orphanPricingSourceKeys: string[] = [];
  const catalogTargetMissing: string[] = [];
  let czkMissing = 0;
  let eurMissing = 0;

  for (const row of rows) {
    const sourceKey = buildMappingSourceKey({ sourceSheet: TECHNICAL_SERVICE_SOURCE_SHEET, rawName: row.rawName });
    const service = serviceBySourceKey.get(sourceKey);
    if (!service) continue; // structurally impossible when planTechnicalServices ran over the same rows
    const catalogItemRef = service.mappedCanonicalCode ?? service.sourceKey;

    for (const eventPrice of row.eventPrices) {
      for (const currency of ["CZK", "EUR"] as const) {
        const parsed = currency === "CZK" ? eventPrice.czk : eventPrice.eur;
        if (parsed.status === "missing" || parsed.amount === null) {
          if (currency === "CZK") czkMissing += 1;
          else eurMissing += 1;
          continue;
        }
        const traceKey = `${service.sourceKey}::${eventPrice.eventSourceKey}::${currency}`;
        if (!validKnownCatalogRefs.has(catalogItemRef)) {
          catalogTargetMissing.push(traceKey);
          continue;
        }
        const priceList = priceListByEventAndCurrency.get(`${eventPrice.eventSourceKey}::${currency}`);
        const event = eventBySourceKey.get(eventPrice.eventSourceKey);
        if (!priceList || !event) {
          orphanPricingSourceKeys.push(traceKey);
          continue;
        }
        if (priceList.currency !== currency) {
          currencyMismatches.push(traceKey);
          continue;
        }
        entries.push({
          technicalServiceSourceKey: service.sourceKey,
          eventSourceKey: eventPrice.eventSourceKey,
          currency,
          catalogItemRef,
          priceListId: priceList.id,
          eventId: event.id,
          salePrice: parsed.amount,
          priceMode: "fixed",
          pricingUnit: undefined,
          source: { sourceSheet: currency, rawName: row.rawName },
        });
      }
    }
  }

  const czkFixed = entries.filter((entry) => entry.currency === "CZK").length;
  const eurFixed = entries.filter((entry) => entry.currency === "EUR").length;
  return {
    entries,
    counts: { czkFixed, eurFixed, totalFixed: czkFixed + eurFixed, czkMissing, eurMissing, totalMissing: czkMissing + eurMissing },
    validation: { currencyMismatches, orphanPricingSourceKeys, catalogTargetMissing },
  };
}

// ============================================================================
// 7. MAPPINGS — catalog_mappings has no "rejected" status; rejections stay audit-trail only.
// ============================================================================

export type PlannedCatalogMapping = Readonly<{
  rawName: string;
  canonicalInternalCode: CanonicalInternalCode;
  confirmed: true;
  /** catalog_items.id doesn't exist yet (catalog_items = 0) — resolved by internalCode at apply time, never guessed here. */
  catalogItemRef: CanonicalInternalCode;
  /** catalog_mappings.source_system/source_key — same identity Batch #1 already recorded for this exact decision in import_rows (see domain/importBatch1.ts planMappingDecisionRows). unique(source_system, source_key) in the DB makes this idempotent by construction. */
  sourceSystem: string;
  sourceKey: string;
  normalizedName: string;
}>;

export type RejectedMappingAuditNote = Readonly<{
  rawName: string;
  rejectedInternalCode: string;
  reason: string;
  recordedIn: string;
}>;

export type MappingsPlan = Readonly<{
  confirmed: readonly PlannedCatalogMapping[];
  rejected: readonly RejectedMappingAuditNote[];
}>;

export function planMappings(decisions: readonly MappingDecision[]): MappingsPlan {
  const confirmed = decisions
    .filter((decision) => decision.decision === "confirmed" && Boolean(decision.targetInternalCode))
    .map((decision) => ({
      rawName: decision.identity.rawName,
      canonicalInternalCode: decision.targetInternalCode as CanonicalInternalCode,
      confirmed: true as const,
      catalogItemRef: decision.targetInternalCode as CanonicalInternalCode,
      sourceSystem: BATCH2A_SOURCE_SYSTEM,
      sourceKey: buildMappingSourceKey(decision.identity),
      normalizedName: normalizedMappingName(decision.identity.rawName),
    }));
  // Batch #1 already recorded this in import_rows (mapping_status='rejected') — Batch #2A
  // does not touch catalog_mappings for it and does not re-record it anywhere.
  const rejected = decisions
    .filter((decision) => decision.decision === "rejected")
    .map((decision) => ({
      rawName: decision.identity.rawName,
      rejectedInternalCode: decision.targetInternalCode ?? "",
      reason: decision.reason ?? "",
      recordedIn: "import_rows (Batch #1, already applied) — audit trail only, no catalog_mappings row",
    }));
  return { confirmed, rejected };
}

// ============================================================================
// PREFLIGHT — section 11: everything checkable BEFORE the first write. Pure — reuses the
// plan's own validation fields plus a dry-run resolution pass against real existing
// catalog_items, so "0 duplicate internalCode conflict" / "0 duplicate source identity
// conflict" are proven against the ACTUAL DB state, not just internal plan consistency.
// ============================================================================

export class CatalogItemConflictError extends Error {
  readonly internalCode: string | null;
  readonly sourceKey: string;
  readonly existingId: string;

  constructor(reason: string, details: Readonly<{ internalCode: string | null; sourceKey: string; existingId: string }>) {
    super(reason);
    this.name = "CatalogItemConflictError";
    this.internalCode = details.internalCode;
    this.sourceKey = details.sourceKey;
    this.existingId = details.existingId;
  }
}

export class Batch2aPreflightError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`Batch #2A preflight selhal (${issues.length} problém(y)), apply zastaven před prvním zápisem: ${issues.join(" | ")}`);
    this.name = "Batch2aPreflightError";
    this.issues = issues;
  }
}

export type Batch2aPreflightResult = Readonly<{ ok: boolean; issues: readonly string[] }>;

export function runBatch2aPreflight(plan: Batch2aPlan, existingCatalogItems: readonly ExistingCatalogItemRow[]): Batch2aPreflightResult {
  const issues: string[] = [];
  if (plan.pricing.validation.currencyMismatches.length > 0) issues.push(`${plan.pricing.validation.currencyMismatches.length} currency mismatch(es) v pricing plánu.`);
  if (plan.pricing.validation.orphanPricingSourceKeys.length > 0) issues.push(`${plan.pricing.validation.orphanPricingSourceKeys.length} orphan pricing target(s) — chybějící event/price list.`);
  if (plan.pricing.validation.catalogTargetMissing.length > 0) issues.push(`${plan.pricing.validation.catalogTargetMissing.length} pricing entries bez catalog targetu.`);
  if (plan.reimport.duplicateInternalCodes.length > 0) issues.push(`Duplicitní internalCode uvnitř plánu: ${plan.reimport.duplicateInternalCodes.join(", ")}.`);
  if (plan.reimport.duplicateSourceKeys.length > 0) issues.push(`Duplicitní sourceKey uvnitř plánu: ${plan.reimport.duplicateSourceKeys.join(", ")}.`);

  for (const canonical of plan.canonicalCatalogItems) {
    const resolution = resolveCatalogItemForApply(
      { internalCode: canonical.internalCode, sourceSystem: BATCH2A_SOURCE_SYSTEM, sourceKey: canonical.internalCode, kind: canonical.kind },
      existingCatalogItems,
    );
    if (resolution.action === "conflict") issues.push(`Canonical ${canonical.internalCode}: ${resolution.conflictReason}`);
  }
  for (const service of plan.technicalServices) {
    if (!service.isNewCatalogItem) continue;
    const resolution = resolveCatalogItemForApply(
      { internalCode: service.internalCode, sourceSystem: service.sourceSystem, sourceKey: service.sourceKey, kind: service.kind },
      existingCatalogItems,
    );
    if (resolution.action === "conflict") issues.push(`Technical service ${service.sourceKey}: ${resolution.conflictReason}`);
  }

  return { ok: issues.length === 0, issues };
}

// ============================================================================
// FULL PLAN
// ============================================================================

export type Batch2aPlan = Readonly<{
  canonicalCatalogItems: readonly PlannedCanonicalCatalogItem[];
  technicalServices: readonly PlannedTechnicalService[];
  catalogItemsSummary: CatalogItemsSummary;
  pricing: PricingPlan;
  mappings: MappingsPlan;
  reimport: ReimportSummary;
  warnings: readonly string[];
}>;

export function buildBatch2aPlan(
  preview: ImportPreview,
  canonicalSeeds: readonly ComponentDefinition[],
  existingCatalogItems: readonly ExistingCatalogItemRow[],
  existingEvents: readonly ExistingEventRow2A[],
  existingPriceLists: readonly ExistingPriceListRow2A[],
  decisions: readonly MappingDecision[],
  manualReviewTimestamp: string,
  abfMatches: ReadonlyMap<string, AbfTechnicalServiceMatch> = new Map(),
): Batch2aPlan {
  const canonicalCatalogItems = planCanonicalCatalogItems(canonicalSeeds, existingCatalogItems, manualReviewTimestamp);
  const technicalServices = planTechnicalServices(preview.technicalServiceRows, decisions, abfMatches, existingCatalogItems);
  const catalogItemsSummary = summarizeCatalogItems(canonicalCatalogItems, technicalServices);
  const pricing = planPricingEntries(preview.technicalServiceRows, technicalServices, existingEvents, existingPriceLists);
  const mappings = planMappings(decisions);
  const reimport = summarizeReimportIdentity(technicalServices);

  const otherPricelistRows = Math.max(preview.counts.catalogRows - 2, 0);
  const warnings: string[] = [
    "P86 nebyl v tomto batchi vůbec zpracován — žádný stub, žádný catalog_item plán, žádná mapping. Zůstává výhradně seed v data/booths.ts.",
    `${otherPricelistRows} ostatních PRICELIST řádků (mimo M57/L02 kandidáty, včetně 77 EXACT_SAFE z ABF matching reportu) nebylo plánováno k importu — zůstávají mimo tento batch pro Batch #2B.`,
    "Furniture mimo M57 a booths se v tomto batchi neimportují.",
    "Ověřeno proti supabase/migrations/20260813120000_init_schema.sql: pricing_entries NEMÁ sloupec pricing_unit vůbec (jen catalog_items.document.pricingUnit) — needs_review catalog_item s pricingUnit=NULL nikdy neblokuje vznik jeho pricing_entries. Není to blocker.",
    "Reimport identita 22 technical-service catalog_items je nyní stabilní: internalCode, pokud ho ABF matching potvrdil (EXACT_SAFE), jinak sourceSystem+sourceKey — nikdy normalized name. Viz reimport summary.",
    "Nalezení ABF internalCode samo o sobě NEMĚNÍ lifecycleStatus (zůstává needs_review) ani generatorEligible (zůstává false) — to je pouze catalog identita, ne schválení k aktivaci.",
  ];
  if (reimport.duplicateInternalCodes.length > 0) warnings.push(`POZOR: duplicitní internalCode napříč technical services: ${reimport.duplicateInternalCodes.join(", ")}.`);
  if (reimport.duplicateSourceKeys.length > 0) warnings.push(`POZOR: duplicitní sourceKey napříč technical services: ${reimport.duplicateSourceKeys.join(", ")}.`);
  if (pricing.validation.currencyMismatches.length > 0) warnings.push(`POZOR: ${pricing.validation.currencyMismatches.length} currency mismatch(es) — viz pricing.validation.currencyMismatches.`);
  if (pricing.validation.orphanPricingSourceKeys.length > 0) warnings.push(`POZOR: ${pricing.validation.orphanPricingSourceKeys.length} orphan pricing candidate(s) — viz pricing.validation.orphanPricingSourceKeys.`);
  if (pricing.validation.catalogTargetMissing.length > 0) warnings.push(`POZOR: ${pricing.validation.catalogTargetMissing.length} pricing candidate(s) bez catalog targetu — viz pricing.validation.catalogTargetMissing.`);

  return { canonicalCatalogItems, technicalServices, catalogItemsSummary, pricing, mappings, reimport, warnings };
}

// ============================================================================
// APPLY PREVIEW — section 12: what a real apply WOULD do against the current DB state,
// computed with the exact same pure resolution functions the real writer uses
// (lib/db/importBatch2a.supabase.ts), so the preview can never drift from apply behavior.
// Pure — takes already-fetched existing rows, does no I/O itself.
// ============================================================================

export type ExistingCatalogMappingRow = Readonly<{ sourceSystem: string; sourceKey: string; catalogItemId: string }>;

export type Batch2aApplyPreview = Readonly<{
  catalogItems: Readonly<{ insert: number; noop: number; conflicts: number }>;
  catalogMappings: Readonly<{ insert: number; noop: number }>;
  pricingEntries: Readonly<{ insert: number; update: number; noop: number }>;
}>;

export function previewBatch2aApply(
  plan: Batch2aPlan,
  existingCatalogItems: readonly ExistingCatalogItemRow[],
  existingCatalogMappings: readonly ExistingCatalogMappingRow[],
  existingPricingEntries: readonly ExistingPricingEntryRow[],
): Batch2aApplyPreview {
  let catalogItemsInsert = 0;
  let catalogItemsNoop = 0;
  let catalogItemsConflicts = 0;
  // Maps a pricing entry's symbolic catalogItemRef (internalCode or sourceKey) to the REAL
  // resolved DB id — only populated for items that already exist (noop); an item still
  // pending insert has no real id yet, so any pricing entry targeting it is trivially
  // also "insert" (it cannot already exist for a catalog_item that doesn't exist).
  const resolvedIdByRef = new Map<string, string>();

  for (const canonical of plan.canonicalCatalogItems) {
    const resolution = resolveCatalogItemForApply(
      { internalCode: canonical.internalCode, sourceSystem: BATCH2A_SOURCE_SYSTEM, sourceKey: canonical.internalCode, kind: canonical.kind },
      existingCatalogItems,
    );
    if (resolution.action === "insert") catalogItemsInsert += 1;
    else if (resolution.action === "noop") {
      catalogItemsNoop += 1;
      resolvedIdByRef.set(canonical.internalCode, resolution.existingId!);
    } else catalogItemsConflicts += 1;
  }
  for (const service of plan.technicalServices) {
    if (!service.isNewCatalogItem) continue;
    const resolution = resolveCatalogItemForApply(
      { internalCode: service.internalCode, sourceSystem: service.sourceSystem, sourceKey: service.sourceKey, kind: service.kind },
      existingCatalogItems,
    );
    if (resolution.action === "insert") catalogItemsInsert += 1;
    else if (resolution.action === "noop") {
      catalogItemsNoop += 1;
      resolvedIdByRef.set(service.sourceKey, resolution.existingId!);
      if (service.internalCode) resolvedIdByRef.set(service.internalCode, resolution.existingId!);
    } else catalogItemsConflicts += 1;
  }

  const existingMappingKeys = new Set(existingCatalogMappings.map((m) => `${m.sourceSystem}::${m.sourceKey}`));
  let catalogMappingsInsert = 0;
  let catalogMappingsNoop = 0;
  for (const mapping of plan.mappings.confirmed) {
    if (existingMappingKeys.has(`${mapping.sourceSystem}::${mapping.sourceKey}`)) catalogMappingsNoop += 1;
    else catalogMappingsInsert += 1;
  }

  let pricingInsert = 0;
  let pricingUpdate = 0;
  let pricingNoop = 0;
  for (const entry of plan.pricing.entries) {
    const catalogItemId = resolvedIdByRef.get(entry.catalogItemRef);
    if (!catalogItemId) {
      pricingInsert += 1;
      continue;
    }
    const resolution = resolvePricingEntryForApply(
      { catalogItemId, priceListId: entry.priceListId, eventId: entry.eventId, currency: entry.currency, salePrice: entry.salePrice },
      existingPricingEntries,
    );
    if (resolution.action === "insert") pricingInsert += 1;
    else if (resolution.action === "update") pricingUpdate += 1;
    else pricingNoop += 1;
  }

  return {
    catalogItems: { insert: catalogItemsInsert, noop: catalogItemsNoop, conflicts: catalogItemsConflicts },
    catalogMappings: { insert: catalogMappingsInsert, noop: catalogMappingsNoop },
    pricingEntries: { insert: pricingInsert, update: pricingUpdate, noop: pricingNoop },
  };
}
