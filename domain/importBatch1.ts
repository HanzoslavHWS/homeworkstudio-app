/**
 * Batch #1 planning: Events + PriceLists + staged pricing/mapping decisions.
 *
 * Pure, no I/O — every function here takes plain data in and returns plain data out, so it
 * can be fully unit tested without touching Supabase. lib/db/importBatch1.supabase.ts is the
 * thin I/O layer that reads current DB state and applies a plan produced here.
 *
 * IMPORTANT — catalog identity blocker (section 7 of the Batch #1 spec):
 * pricing_entries needs a target identity. catalog_mappings.catalog_item_id and
 * pricing_entries.catalog_item_id both point at catalog_items, but Batch #1 deliberately
 * does not import catalog_items (M57/L02/P86 stay seed-only, the 116 PRICELIST candidates
 * are deferred to Batch #2). Writing pricing_entries with catalog_item_id = NULL would
 * produce indistinguishable rows — 23 different technical services per event/currency would
 * collapse into anonymous numbers with no way to tell "2kW electricity" from "cleaning" ever
 * again. That is worse than not writing them. So this batch NEVER inserts into pricing_entries
 * or catalog_mappings; it stages the fully-parsed, fully-traceable data in import_rows
 * (which already supports source_sheet/source_row/raw_name/raw_values/normalized_values/
 * mapping_status without needing catalog_item_id at all) so Batch #2 can create the real
 * pricing_entries once catalog_items exist for these technical services.
 */
import type { Currency } from "./models.ts";
import { normalizeExhibition, type Exhibition, type PriceList } from "./organizations.ts";
import {
  buildImportPriceListCode,
  buildMappingSourceKey,
  normalizedMappingName,
  type ImportEventPreview,
  type ImportPreview,
  type ImportRow,
  type ImportRowMappingStatus,
  type MappingSourceIdentity,
} from "./importBatch.ts";

export const BATCH1_SOURCE_SYSTEM = "excel-v6.6";
const CURRENCIES: readonly Currency[] = ["CZK", "EUR"];

// ============================================================================
// EVENTS
// ============================================================================

export type ExistingEventRow = Readonly<{ id: string; sourceKey: string; document: Exhibition }>;

export type PlannedEventWrite = Readonly<{
  sourceKey: string;
  action: "insert" | "update" | "noop";
  needsReview: boolean;
  reviewReason?: string;
  /** Exhibition as it should be written, EXCLUDING priceListIds/defaultPriceListId — those are only known after the price-list phase runs (see attachPriceListsToEvent). */
  event: Exhibition;
  existingId?: string;
}>;

function eventCoreDocumentEquals(a: Exhibition, b: Exhibition): boolean {
  return a.name === b.name && a.eventFrom === b.eventFrom && a.eventTo === b.eventTo && a.slug === b.slug && a.year === b.year;
}

/**
 * Section 4: CTM's date is genuinely absent in the source. Exhibition.eventFrom/eventTo are
 * both optional and events.start_date/end_date are nullable columns — verified, neither
 * layer requires a date, so CTM is imported with real NULL/NULL, never a guessed date. It
 * still surfaces as needsReview so a human follows up on the actual date separately.
 */
export function planEvents(events: readonly ImportEventPreview[], existing: readonly ExistingEventRow[]): readonly PlannedEventWrite[] {
  const existingBySourceKey = new Map(existing.map((row) => [row.sourceKey, row]));
  return events.map((event) => {
    const existingRow = existingBySourceKey.get(event.sourceKey);
    // Merge onto the existing document (logoAsset, documents, priceListIds, realization
    // context, ...) — Excel only ever supplies name/eventFrom/eventTo. An update must never
    // wipe out fields a human already set via the admin UI.
    const normalized = normalizeExhibition({
      ...existingRow?.document,
      id: existingRow?.id ?? event.sourceKey,
      slug: event.sourceKey,
      name: event.name,
      year: deriveYear(event.startDate),
      eventFrom: event.startDate ?? undefined,
      eventTo: event.endDate ?? undefined,
    });
    const action: PlannedEventWrite["action"] = !existingRow ? "insert" : eventCoreDocumentEquals(normalized, existingRow.document) ? "noop" : "update";
    return {
      sourceKey: event.sourceKey,
      action,
      needsReview: event.needsReview,
      reviewReason: event.needsReview ? "Datum není v Excelu jednoznačné/přítomné — eventFrom/eventTo zůstávají NULL, nevymyšleno." : undefined,
      event: normalized,
      existingId: existingRow?.id,
    };
  });
}

// ============================================================================
// PRICE LISTS
// ============================================================================

export type ExistingPriceListRow = Readonly<{ id: string; code: string }>;

export type PlannedPriceListWrite = Readonly<{
  code: string;
  eventSourceKey: string;
  currency: Currency;
  year: number;
  action: "insert" | "noop";
  priceList: PriceList;
  existingId?: string;
}>;

function deriveYear(startDate: string | null): number {
  return startDate ? Number(startDate.slice(0, 4)) : new Date().getFullYear();
}

/**
 * Section 5 + section 6 (currency isolation): one PriceList per (event, currency) — CZK and
 * EUR are always separate rows/codes, never merged, never cross-converted. Created even for
 * events with currently no pricing data (e.g. ctm) — an empty price list is a valid state,
 * ready to receive entries later; it isn't itself pricing data.
 */
export function planPriceLists(events: readonly ImportEventPreview[], existing: readonly ExistingPriceListRow[]): readonly PlannedPriceListWrite[] {
  const existingByCode = new Map(existing.map((row) => [row.code, row]));
  const plans: PlannedPriceListWrite[] = [];
  for (const event of events) {
    const year = deriveYear(event.startDate);
    for (const currency of CURRENCIES) {
      const code = buildImportPriceListCode(event.sourceKey, year, currency);
      const existingRow = existingByCode.get(code);
      const priceList: PriceList = {
        id: existingRow?.id ?? code,
        name: `${event.name} ${year} — ${currency}`,
        code,
        currency,
        year,
        active: true,
      };
      plans.push({ code, eventSourceKey: event.sourceKey, currency, year, action: existingRow ? "noop" : "insert", priceList, existingId: existingRow?.id });
    }
  }
  return plans;
}

/** Section 5: Event → PriceList via priceListIds/defaultPriceListId, default = the CZK list. Pure — takes already-resolved DB ids for the price lists belonging to this event. */
export function attachPriceListsToEvent(event: Exhibition, priceListIdsByCurrency: Readonly<Partial<Record<Currency, string>>>): Exhibition {
  const newIds = Object.values(priceListIdsByCurrency).filter((id): id is string => Boolean(id));
  const priceListIds = [...new Set([...event.priceListIds, ...newIds])];
  const defaultPriceListId = event.defaultPriceListId ?? priceListIdsByCurrency.CZK ?? priceListIds[0];
  return { ...event, priceListIds, defaultPriceListId };
}

// ============================================================================
// MAPPING DECISIONS (human-confirmed, batch-specific — see scripts/importBatch1.ts)
// ============================================================================

export type MappingDecision = Readonly<{
  identity: MappingSourceIdentity;
  decision: Extract<ImportRowMappingStatus, "confirmed" | "rejected">;
  targetInternalCode?: string;
  reason?: string;
}>;

/** Builds the (source_sheet=PRICELIST) import_rows that record a confirmed/rejected mapping decision. These do NOT create catalog_items — they are audit-trail only, per section 7/8. */
export function planMappingDecisionRows(
  batchId: string,
  catalogRows: ImportPreview["catalogRows"],
  decisions: readonly MappingDecision[],
): readonly ImportRow[] {
  const rows: ImportRow[] = [];
  for (const decision of decisions) {
    if (decision.identity.sourceSheet !== "PRICELIST") continue;
    const row = catalogRows.find(
      (candidate) => normalizedMappingName(candidate.rawNameCz) === normalizedMappingName(decision.identity.rawName) && (!decision.identity.category || candidate.category === decision.identity.category),
    );
    const sourceKey = buildMappingSourceKey(decision.identity);
    rows.push({
      id: sourceKey,
      importBatchId: batchId,
      sourceSheet: "PRICELIST",
      sourceRow: row?.sourceRow ?? -1,
      sourceKey,
      rawName: decision.identity.rawName,
      rawCategory: decision.identity.category,
      rawValues: row ? { category: row.category, rawNameCz: row.rawNameCz, rawNameEn: row.rawNameEn } : {},
      normalizedValues: { targetInternalCode: decision.targetInternalCode ?? null, decision: decision.decision, reason: decision.reason ?? null },
      mappingStatus: decision.decision,
      issues: decision.decision === "rejected" ? [decision.reason ?? "rejected"] : [],
    });
  }
  return rows;
}

// ============================================================================
// STAGED TECHNICAL-SERVICE PRICING (import_rows only — see module doc for why)
// ============================================================================

export type StagedPricingCounts = Readonly<{
  fixedCzk: number;
  missingCzk: number;
  fixedEur: number;
  missingEur: number;
}>;

/**
 * One import_row per (sheet, technical service). Carries the FULL per-event price map so
 * nothing is lost — Batch #2 can turn each into real pricing_entries once catalog_items
 * exist. Never writes a number for "??" / "ZVOL VELETRH" / blank — those already arrive here
 * as ParsedPrice{status:"missing"} from domain/priceImport.ts and stay that way.
 */
export function planStagedPricingRows(batchId: string, preview: ImportPreview): readonly ImportRow[] {
  const rows: ImportRow[] = [];
  for (const sheet of ["CZK", "EUR"] as const) {
    for (const service of preview.technicalServiceRows) {
      const sourceKey = buildMappingSourceKey({ sourceSheet: sheet, rawName: service.rawName });
      const perEvent = service.eventPrices.map((entry) => ({
        eventSourceKey: entry.eventSourceKey,
        amount: sheet === "CZK" ? entry.czk.amount : entry.eur.amount,
        status: sheet === "CZK" ? entry.czk.status : entry.eur.status,
        // Every present numeric value from these sheets is a literal number the workbook
        // states outright — never anything the importer infers, so priceMode is always
        // "fixed" here. "individual"/"included" only ever apply at the catalog-item level
        // (Kontejner, P86 fascia) and neither appears as a row in CZK/EUR.
        priceMode: (sheet === "CZK" ? entry.czk.status : entry.eur.status) === "priced" ? ("fixed" as const) : undefined,
      }));
      rows.push({
        id: sourceKey,
        importBatchId: batchId,
        sourceSheet: sheet,
        sourceRow: -1,
        sourceKey,
        rawName: service.rawName,
        rawValues: { perEvent: perEvent.map((entry) => ({ eventSourceKey: entry.eventSourceKey, amount: entry.amount, status: entry.status })) },
        normalizedValues: { currency: sheet, perEvent },
        mappingStatus: service.candidates.some((c) => c.internalCode) ? "candidate" : "new",
        candidates: service.candidates,
        issues: [],
      });
    }
  }
  return rows;
}

export function summarizeStagedPricing(preview: ImportPreview): StagedPricingCounts {
  return {
    fixedCzk: preview.counts.eventPricingEntriesCzk,
    missingCzk: preview.counts.missingEventPricingCzk,
    fixedEur: preview.counts.eventPricingEntriesEur,
    missingEur: preview.counts.missingEventPricingEur,
  };
}

// ============================================================================
// FULL PLAN + SUMMARY
// ============================================================================

export type Batch1Plan = Readonly<{
  events: readonly PlannedEventWrite[];
  priceLists: readonly PlannedPriceListWrite[];
  mappingDecisionRows: readonly ImportRow[];
  stagedPricingRows: readonly ImportRow[];
  stagedPricingCounts: StagedPricingCounts;
  warnings: readonly string[];
}>;

export function buildBatch1Plan(
  batchId: string,
  preview: ImportPreview,
  existingEvents: readonly ExistingEventRow[],
  existingPriceLists: readonly ExistingPriceListRow[],
  decisions: readonly MappingDecision[],
): Batch1Plan {
  const events = planEvents(preview.events, existingEvents);
  const priceLists = planPriceLists(preview.events, existingPriceLists);
  const mappingDecisionRows = planMappingDecisionRows(batchId, preview.catalogRows, decisions);
  const stagedPricingRows = planStagedPricingRows(batchId, preview);
  const warnings: string[] = [];
  const needsReviewEvents = events.filter((e) => e.needsReview);
  for (const event of needsReviewEvents) warnings.push(`Event "${event.sourceKey}": ${event.reviewReason}`);
  warnings.push(
    `pricing_entries a catalog_mappings se v tomto batchi NEZAPISUJÍ — chybí cílová catalog_item identita (M57/L02/P86 zůstávají jen seed, 116 PRICELIST kandidátů jde do Batch #2). ${preview.counts.eventPricingEntriesCzk + preview.counts.eventPricingEntriesEur} reálných cen je bezpečně staged v import_rows, připraveno k dokončení v Batch #2.`,
  );
  return { events, priceLists, mappingDecisionRows, stagedPricingRows, stagedPricingCounts: summarizeStagedPricing(preview), warnings };
}

export type Batch1PlanSummary = Readonly<{
  events: Readonly<{ insert: number; update: number; noop: number; needsReview: number }>;
  priceLists: Readonly<{ insert: number; noop: number }>;
  pricingEntries: Readonly<{ insert: number; update: number; noop: number; missingSkipped: number; stagedOnly: number }>;
  mappings: Readonly<{ confirmed: number; rejected: number; untouched: number }>;
  databaseWrites: number;
}>;

export function summarizeBatch1Plan(plan: Batch1Plan, mode: "dry-run" | "apply"): Batch1PlanSummary {
  const confirmed = plan.mappingDecisionRows.filter((row) => row.mappingStatus === "confirmed").length;
  const rejected = plan.mappingDecisionRows.filter((row) => row.mappingStatus === "rejected").length;
  return {
    events: {
      insert: plan.events.filter((e) => e.action === "insert").length,
      update: plan.events.filter((e) => e.action === "update").length,
      noop: plan.events.filter((e) => e.action === "noop").length,
      needsReview: plan.events.filter((e) => e.needsReview).length,
    },
    priceLists: {
      insert: plan.priceLists.filter((p) => p.action === "insert").length,
      noop: plan.priceLists.filter((p) => p.action === "noop").length,
    },
    pricingEntries: {
      // Always 0/0/0 by design — see module doc. Never populated by "guessing" an identity.
      insert: 0,
      update: 0,
      noop: 0,
      missingSkipped: plan.stagedPricingCounts.missingCzk + plan.stagedPricingCounts.missingEur,
      stagedOnly: plan.stagedPricingCounts.fixedCzk + plan.stagedPricingCounts.fixedEur,
    },
    mappings: {
      confirmed,
      rejected,
      untouched: 0,
    },
    databaseWrites: mode === "dry-run" ? 0 : Number.NaN, // apply path fills in the real count itself
  };
}
