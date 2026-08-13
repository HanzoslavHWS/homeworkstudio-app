import type { ComponentDefinition, Currency } from "./models.ts";
import { suggestCatalogMappingCandidates, type CatalogMappingCandidate } from "./catalogMapping.ts";
import {
  normalizeEventPricingSheet,
  normalizeEventSourceSheet,
  normalizePricelistSheet,
  type EventPricingRow,
  type EventSourceRow,
  type ParsedPrice,
  type PricelistRow,
  type RawSheetRow,
} from "./priceImport.ts";

export type ImportBatchStatus = "dry_run" | "applied" | "failed";

export type ImportBatch = Readonly<{
  id: string;
  sourceFileName: string;
  /** Non-cryptographic content fingerprint — cheap re-import / dedup detection, not a security hash. */
  sourceFingerprint: string;
  sourceVersion: string;
  createdAt: string;
  status: ImportBatchStatus;
}>;

export type ImportRowMappingStatus =
  | "new"
  | "existing_unchanged"
  | "changed"
  | "candidate"
  | "confirmed"
  | "missing_from_latest_import";

export type ImportRow = Readonly<{
  id: string;
  importBatchId: string;
  sourceSheet: string;
  sourceRow: number;
  sourceKey?: string;
  rawName: string;
  rawCategory?: string;
  rawValues: Readonly<Record<string, unknown>>;
  normalizedValues: Readonly<Record<string, unknown>>;
  mappingStatus: ImportRowMappingStatus;
  targetEntityId?: string;
  candidates?: readonly CatalogMappingCandidate[];
  issues: readonly string[];
}>;

export type CatalogMapping = Readonly<{
  id: string;
  sourceSystem: string;
  /**
   * The stable business identity: sheet + category + normalized name, e.g.
   * "pricelist::nabytek::zidle-calounena" — see buildMappingSourceKey(). This, not
   * normalizedName, is what re-import lookups and the DB unique constraint key on.
   * The same normalized name in a different sheet or category is a DIFFERENT source
   * item and must be able to map to a different (or unmapped) CatalogItem.
   */
  sourceKey: string;
  /** Denormalized copy of the name for search/display only — never the uniqueness key. */
  normalizedName: string;
  catalogItemId: string;
  confirmed: boolean;
  createdAt: string;
}>;

/** FNV-1a 32-bit — cheap, deterministic, dependency-free content fingerprint. Not for security use. */
export function fingerprintBytes(bytes: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    hash ^= bytes[i]!;
    hash = Math.imul(hash, 0x01000193);
  }
  return `${bytes.length.toString(16)}-${(hash >>> 0).toString(16)}`;
}

export function stableRowKey(sourceSheet: string, sourceKeyOrName: string): string {
  return `${sourceSheet}::${sourceKeyOrName}`;
}

export type ImportRowDiff = Readonly<{
  newKeys: readonly string[];
  unchangedKeys: readonly string[];
  changedKeys: readonly string[];
  missingFromLatestImport: readonly string[];
}>;

/**
 * Section 27/28: re-import must not blindly duplicate, and a row disappearing from the
 * source must never trigger an automatic delete — only a "missingFromLatestImport" flag.
 */
export function diffImportRows(previous: readonly ImportRow[], current: readonly ImportRow[]): ImportRowDiff {
  const previousByKey = new Map(previous.map((row) => [stableRowKey(row.sourceSheet, row.sourceKey ?? row.rawName), row]));
  const currentByKey = new Map(current.map((row) => [stableRowKey(row.sourceSheet, row.sourceKey ?? row.rawName), row]));

  const newKeys: string[] = [];
  const unchangedKeys: string[] = [];
  const changedKeys: string[] = [];
  for (const [key, row] of currentByKey) {
    const previousRow = previousByKey.get(key);
    if (!previousRow) {
      newKeys.push(key);
    } else if (JSON.stringify(previousRow.normalizedValues) === JSON.stringify(row.normalizedValues)) {
      unchangedKeys.push(key);
    } else {
      changedKeys.push(key);
    }
  }
  const missingFromLatestImport = [...previousByKey.keys()].filter((key) => !currentByKey.has(key));

  return { newKeys, unchangedKeys, changedKeys, missingFromLatestImport };
}

export function buildImportPriceListCode(eventSourceKey: string, year: number, currency: Currency): string {
  return `${eventSourceKey.toUpperCase()}-${year}-${currency}`;
}

export function normalizedMappingName(rawName: string): string {
  return rawName.trim().replace(/\s+/gu, " ").toLocaleLowerCase("cs");
}

function slugPart(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[̀-ͯ]/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/gu, "-");
}

export type MappingSourceIdentity = Readonly<{ sourceSheet: string; category?: string; rawName: string }>;

/**
 * Section 7: a normalized name alone is NOT a safe unique business identifier — the same
 * name can legitimately appear in a different sheet or category as a genuinely different
 * source item (e.g. two unrelated "Lamino" rows). The source key folds in sheet + category
 * so those stay distinct identities even though suggestCatalogMappingCandidates might
 * still surface similar-looking candidates for both.
 */
export function buildMappingSourceKey(identity: MappingSourceIdentity): string {
  return [identity.sourceSheet, identity.category ?? "", normalizedMappingName(identity.rawName)].map(slugPart).join("::");
}

/**
 * Section 26/27: once a human confirms "Excel row X = catalog item Y", the next import of
 * the same workbook must recognize it instead of asking again — this is the lookup a
 * re-import would call before falling back to suggestCatalogMappingCandidates. Keyed on
 * the stable sourceKey, not the (collision-prone) normalizedName.
 */
export function findConfirmedMapping(
  mappings: readonly CatalogMapping[],
  sourceSystem: string,
  identity: MappingSourceIdentity,
): CatalogMapping | undefined {
  const sourceKey = buildMappingSourceKey(identity);
  return mappings.find((mapping) => mapping.confirmed && mapping.sourceSystem === sourceSystem && mapping.sourceKey === sourceKey);
}

export class DuplicateMappingSourceKeyError extends Error {
  readonly sourceSystem: string;
  readonly sourceKey: string;

  constructor(sourceSystem: string, sourceKey: string) {
    super(`Mapping pro "${sourceKey}" (${sourceSystem}) už existuje.`);
    this.name = "DuplicateMappingSourceKeyError";
    this.sourceSystem = sourceSystem;
    this.sourceKey = sourceKey;
  }
}

/** Mirrors the DB's unique(source_system, source_key) constraint — see the init migration. */
export function assertUniqueMappingSourceKey(existing: readonly CatalogMapping[], sourceSystem: string, sourceKey: string): void {
  const collision = existing.some((mapping) => mapping.sourceSystem === sourceSystem && mapping.sourceKey === sourceKey);
  if (collision) throw new DuplicateMappingSourceKeyError(sourceSystem, sourceKey);
}

export type ImportEventPreview = Readonly<{
  sourceKey: string;
  name: string;
  startDate: string | null;
  endDate: string | null;
  needsReview: boolean;
}>;

export type ImportCatalogRowPreview = Readonly<{
  sourceRow: number;
  category: string;
  rawNameCz: string;
  rawNameEn: string | null;
  unit: string | null;
  unitNeedsReview: boolean;
  saleCzk: ParsedPrice;
  saleEur: ParsedPrice;
  purchaseCzk: ParsedPrice;
  candidates: readonly CatalogMappingCandidate[];
}>;

export type ImportTechnicalServiceEventPrice = Readonly<{
  eventSourceKey: string;
  czk: ParsedPrice;
  eur: ParsedPrice;
}>;

export type ImportTechnicalServiceRowPreview = Readonly<{
  rawName: string;
  eventPrices: readonly ImportTechnicalServiceEventPrice[];
  candidates: readonly CatalogMappingCandidate[];
}>;

export type ImportPreviewCounts = Readonly<{
  events: number;
  eventsNeedingReview: number;
  catalogRows: number;
  categories: readonly string[];
  basePricesCzkPresent: number;
  basePricesCzkMissing: number;
  basePricesEurPresent: number;
  basePricesEurMissing: number;
  purchasePricesCzkPresent: number;
  purchasePricesCzkMissing: number;
  technicalServiceRows: number;
  eventPricingEntriesCzk: number;
  eventPricingEntriesEur: number;
  missingEventPricingCzk: number;
  missingEventPricingEur: number;
  rowsNeedingUnitReview: number;
  candidateMappingRows: number;
  /** Section 22 in the spec: "náklad" is currently near-empty — must stay 0 unless the sheet actually has values. */
  technicalPurchasePricesCzkPresent: number;
}>;

export type ImportPreview = Readonly<{
  counts: ImportPreviewCounts;
  events: readonly ImportEventPreview[];
  catalogRows: readonly ImportCatalogRowPreview[];
  technicalServiceRows: readonly ImportTechnicalServiceRowPreview[];
}>;

export type ImportWorkbookSheets = Readonly<{
  pricelist: readonly RawSheetRow[];
  dataSheet: readonly RawSheetRow[];
  czk: readonly RawSheetRow[];
  eur: readonly RawSheetRow[];
  naklad: readonly RawSheetRow[];
}>;

/**
 * Pure aggregation over already-normalized sheets: no file I/O, no DB, no writes.
 * This is what both the dry-run report and a future "Import dat" admin UI can call.
 */
export function buildImportPreview(sheets: ImportWorkbookSheets, existingCatalogItems: readonly ComponentDefinition[]): ImportPreview {
  const events = normalizeEventSourceSheet(sheets.dataSheet);
  const pricelistRows = normalizePricelistSheet(sheets.pricelist);
  const czkRows = normalizeEventPricingSheet(sheets.czk);
  const eurRows = normalizeEventPricingSheet(sheets.eur);
  const nakladRows = normalizeEventPricingSheet(sheets.naklad);

  const eurByName = new Map(eurRows.map((row) => [row.rawName, row]));
  const technicalPurchasePricesCzkPresent = nakladRows
    .flatMap((row) => Object.values(row.pricesByEventKey))
    .filter((price) => price.status === "priced").length;

  const catalogRows: ImportCatalogRowPreview[] = pricelistRows.map((row) => ({
    sourceRow: row.sourceRow,
    category: row.category,
    rawNameCz: row.rawNameCz,
    rawNameEn: row.rawNameEn,
    unit: row.unit.unit,
    unitNeedsReview: row.unit.needsReview,
    saleCzk: row.saleCzk,
    saleEur: row.saleEur,
    purchaseCzk: row.purchaseCzk,
    candidates: suggestCatalogMappingCandidates({ rawNameCz: row.rawNameCz, rawNameEn: row.rawNameEn }, existingCatalogItems),
  }));

  const technicalServiceRows: ImportTechnicalServiceRowPreview[] = czkRows.map((czkRow) => {
    const eurRow = eurByName.get(czkRow.rawName);
    const eventKeys = new Set([...Object.keys(czkRow.pricesByEventKey), ...Object.keys(eurRow?.pricesByEventKey ?? {})]);
    const eventPrices: ImportTechnicalServiceEventPrice[] = [...eventKeys].map((eventSourceKey) => ({
      eventSourceKey,
      czk: czkRow.pricesByEventKey[eventSourceKey] ?? { amount: null, status: "missing" },
      eur: eurRow?.pricesByEventKey[eventSourceKey] ?? { amount: null, status: "missing" },
    }));
    return {
      rawName: czkRow.rawName,
      eventPrices,
      candidates: suggestCatalogMappingCandidates({ rawNameCz: czkRow.rawName }, existingCatalogItems),
    };
  });

  const categories = [...new Set(catalogRows.map((row) => row.category).filter(Boolean))];
  const countPriced = (rows: readonly ImportCatalogRowPreview[], pick: (row: ImportCatalogRowPreview) => ParsedPrice) =>
    rows.filter((row) => pick(row).status === "priced").length;

  const eventPricingCzkFlat = technicalServiceRows.flatMap((row) => row.eventPrices.map((p) => p.czk));
  const eventPricingEurFlat = technicalServiceRows.flatMap((row) => row.eventPrices.map((p) => p.eur));

  const counts: ImportPreviewCounts = {
    events: events.length,
    eventsNeedingReview: events.filter((event) => event.date.needsReview).length,
    catalogRows: catalogRows.length,
    categories,
    basePricesCzkPresent: countPriced(catalogRows, (r) => r.saleCzk),
    basePricesCzkMissing: catalogRows.length - countPriced(catalogRows, (r) => r.saleCzk),
    basePricesEurPresent: countPriced(catalogRows, (r) => r.saleEur),
    basePricesEurMissing: catalogRows.length - countPriced(catalogRows, (r) => r.saleEur),
    purchasePricesCzkPresent: countPriced(catalogRows, (r) => r.purchaseCzk),
    purchasePricesCzkMissing: catalogRows.length - countPriced(catalogRows, (r) => r.purchaseCzk),
    technicalServiceRows: technicalServiceRows.length,
    eventPricingEntriesCzk: eventPricingCzkFlat.filter((p) => p.status === "priced").length,
    eventPricingEntriesEur: eventPricingEurFlat.filter((p) => p.status === "priced").length,
    missingEventPricingCzk: eventPricingCzkFlat.filter((p) => p.status === "missing").length,
    missingEventPricingEur: eventPricingEurFlat.filter((p) => p.status === "missing").length,
    rowsNeedingUnitReview: catalogRows.filter((row) => row.unitNeedsReview).length,
    candidateMappingRows: catalogRows.filter((row) => row.candidates.length > 0).length,
    technicalPurchasePricesCzkPresent,
  };

  return {
    counts,
    events: events.map((event) => ({
      sourceKey: event.sourceKey,
      name: event.name,
      startDate: event.date.startDate,
      endDate: event.date.endDate,
      needsReview: event.date.needsReview,
    })),
    catalogRows,
    technicalServiceRows,
  };
}

export { normalizeEventPricingSheet, normalizeEventSourceSheet, normalizePricelistSheet };
export type { EventPricingRow, EventSourceRow, PricelistRow };
