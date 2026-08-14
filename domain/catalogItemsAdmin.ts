/**
 * Component Administration ("Administrace → Komponenty") — pure domain layer for browsing
 * and safely editing the REAL catalog_items table (all kinds: furniture/booth/construction/
 * service/..., all lifecycle statuses, unlike domain/catalogPricing.ts which is a narrow
 * customer-safe summary for technical-service pricing only).
 *
 * generatorEligible is NEVER stored — it is always recomputed live here via
 * domain/catalogReadiness.ts's evaluateCatalogReadiness()/isGeneratorEligible(), the exact
 * same functions the rest of the app already trusts. No parallel readiness logic.
 */
import { CATALOG_ITEM_KINDS, type CatalogItemKind, type CatalogItemStatus, type ComponentDefinition, type PricingEntry } from "./models.ts";
import { evaluateCatalogReadiness, isGeneratorEligible, isValidCatalogItemStatus, type ReadinessResult } from "./catalogReadiness.ts";
import { getBasePricingEntry } from "./catalog.ts";

export const CATALOG_ITEM_KIND_LABELS_CS: Readonly<Record<CatalogItemKind, string>> = {
  booth: "Stánek",
  construction: "Konstrukce / Octanorm",
  furniture: "Mobiliář",
  technical_point: "Technický bod",
  service: "Služba",
  graphics_service: "Grafická služba",
  floor_finish: "Podlahová krytina",
  other: "Ostatní",
};

/** The document JSONB column stores EITHER a full ComponentDefinition OR a BoothType payload (see the catalog_items migration comment) — never assume one shape here, only read named fields defensively. */
export type CatalogItemAdminDocument = Record<string, unknown>;

export type CatalogItemAdmin = Readonly<{
  id: string;
  internalCode: string | null;
  kind: CatalogItemKind;
  lifecycleStatus: CatalogItemStatus;
  displayName: string;
  officialName: string | null;
  category: string | null;
  unit: string | null;
  document: CatalogItemAdminDocument;
  createdAt: string;
  updatedAt: string;
}>;

function readNumber(document: CatalogItemAdminDocument, key: string): number | undefined {
  const value = document[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readString(document: CatalogItemAdminDocument, key: string): string | undefined {
  const value = document[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

export type DocumentDimensions = Readonly<{
  widthMm: number | null;
  depthMm: number | null;
  heightMm: number | null;
  hasDimensions: boolean;
}>;

/** Mirrors catalogReadiness.ts's hasDimensions() exactly (widthMm>0 && depthMm>0) — 0/absent is this codebase's established "unknown", never a real measurement. */
export function documentDimensions(document: CatalogItemAdminDocument): DocumentDimensions {
  const widthMm = readNumber(document, "widthMm") ?? null;
  const depthMm = readNumber(document, "depthMm") ?? null;
  const heightMm = readNumber(document, "heightMm") ?? null;
  const hasDimensions = Boolean(widthMm && widthMm > 0 && depthMm && depthMm > 0);
  return {
    widthMm: widthMm && widthMm > 0 ? widthMm : null,
    depthMm: depthMm && depthMm > 0 ? depthMm : null,
    heightMm: heightMm && heightMm > 0 ? heightMm : null,
    hasDimensions,
  };
}

export function documentHas3DAsset(document: CatalogItemAdminDocument): boolean {
  if (readString(document, "modelUrl")) return true;
  const assets = document.assets as { models3d?: readonly unknown[] } | undefined;
  return Boolean(assets?.models3d?.length);
}

export type SourceTraceability = Readonly<{ sourceSystem: string | null; sourceKey: string | null }>;

/** Read-only provenance — never editable from the admin UI (section 8 of the spec). */
export function documentSourceTraceability(document: CatalogItemAdminDocument): SourceTraceability {
  return { sourceSystem: readString(document, "sourceSystem") ?? null, sourceKey: readString(document, "sourceKey") ?? null };
}

export type DocumentBasePricing = Readonly<{ czk: number | null; eur: number | null }>;

/** "Base" pricing = a PricingEntry with no priceListId/exhibitionId (see domain/catalog.ts getBasePricingEntry) — never event pricing_entries. */
export function documentBasePricing(document: CatalogItemAdminDocument): DocumentBasePricing {
  const entries = Array.isArray(document.pricingEntries) ? (document.pricingEntries as readonly PricingEntry[]) : undefined;
  return {
    czk: getBasePricingEntry(entries, "CZK")?.salePrice ?? null,
    eur: getBasePricingEntry(entries, "EUR")?.salePrice ?? null,
  };
}

/** Adapts a document (ComponentDefinition- or BoothType-shaped) + its real lifecycle_status column into the shape evaluateCatalogReadiness/isGeneratorEligible expect — same spread+cast technique already established by domain/catalogPricing.ts's computeGeneratorEligible. */
function toReadinessAdapter(item: Pick<CatalogItemAdmin, "document" | "lifecycleStatus">): ComponentDefinition {
  return { ...item.document, lifecycleStatus: item.lifecycleStatus } as ComponentDefinition;
}

export function computeReadiness(item: Pick<CatalogItemAdmin, "document" | "lifecycleStatus" | "kind">): ReadinessResult {
  return evaluateCatalogReadiness(toReadinessAdapter(item), item.kind);
}

/** NEVER stored — always live-computed, so a stale flag can never drift from the real rules. */
export function computeGeneratorEligibleLive(item: Pick<CatalogItemAdmin, "document" | "lifecycleStatus" | "kind">): boolean {
  return isGeneratorEligible(toReadinessAdapter(item), item.kind);
}

export type CatalogItemAdminListEntry = Readonly<{
  id: string;
  internalCode: string | null;
  displayName: string;
  kind: CatalogItemKind;
  category: string | null;
  lifecycleStatus: CatalogItemStatus;
  widthMm: number | null;
  depthMm: number | null;
  heightMm: number | null;
  hasDimensions: boolean;
  has3DAsset: boolean;
  basePriceCzk: number | null;
  basePriceEur: number | null;
  readiness: ReadinessResult;
  generatorEligible: boolean;
}>;

export function buildCatalogItemListEntry(item: CatalogItemAdmin): CatalogItemAdminListEntry {
  const dims = documentDimensions(item.document);
  const pricing = documentBasePricing(item.document);
  return {
    id: item.id,
    internalCode: item.internalCode,
    displayName: item.displayName,
    kind: item.kind,
    category: item.category,
    lifecycleStatus: item.lifecycleStatus,
    widthMm: dims.widthMm,
    depthMm: dims.depthMm,
    heightMm: dims.heightMm,
    hasDimensions: dims.hasDimensions,
    has3DAsset: documentHas3DAsset(item.document),
    basePriceCzk: pricing.czk,
    basePriceEur: pricing.eur,
    readiness: computeReadiness(item),
    generatorEligible: computeGeneratorEligibleLive(item),
  };
}

// ============================================================================
// FILTERS — list-view search/category/status/readiness/asset (section 5). Every option here
// is a value the real model already supports; nothing invented.
// ============================================================================

export type CatalogItemAdminFilters = Readonly<{
  query?: string;
  kind?: CatalogItemKind | "";
  lifecycleStatus?: CatalogItemStatus | "";
  readiness?: "ready" | "not-ready" | "";
  asset?: "has-3d" | "missing-3d" | "";
}>;

function normalizedText(value: string): string {
  return value.toLocaleLowerCase("cs").normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function matchesCatalogItemAdminSearch(entry: Pick<CatalogItemAdminListEntry, "internalCode" | "displayName" | "category">, query: string): boolean {
  if (!query.trim()) return true;
  const haystack = normalizedText(`${entry.internalCode ?? ""} ${entry.displayName} ${entry.category ?? ""}`);
  return haystack.includes(normalizedText(query));
}

export function filterCatalogItemsAdmin(entries: readonly CatalogItemAdminListEntry[], filters: CatalogItemAdminFilters): readonly CatalogItemAdminListEntry[] {
  return entries.filter((entry) => {
    if (filters.query && !matchesCatalogItemAdminSearch(entry, filters.query)) return false;
    if (filters.kind && entry.kind !== filters.kind) return false;
    if (filters.lifecycleStatus && entry.lifecycleStatus !== filters.lifecycleStatus) return false;
    if (filters.readiness === "ready" && !entry.readiness.ready) return false;
    if (filters.readiness === "not-ready" && entry.readiness.ready) return false;
    if (filters.asset === "has-3d" && !entry.has3DAsset) return false;
    if (filters.asset === "missing-3d" && entry.has3DAsset) return false;
    return true;
  });
}

// ============================================================================
// EDIT — whitelisted fields only (section 7/8). internalCode/sourceSystem/sourceKey/document
// wholesale are NEVER accepted here, no matter what a raw request body contains.
// ============================================================================

export type CatalogItemAdminEdit = Readonly<{
  displayName?: string;
  name?: string;
  category?: string;
  unit?: string;
  widthMm?: number;
  depthMm?: number;
  heightMm?: number;
  lifecycleStatus?: CatalogItemStatus;
}>;

const EDITABLE_STRING_KEYS = ["displayName", "name", "category", "unit"] as const;
const EDITABLE_NUMBER_KEYS = ["widthMm", "depthMm", "heightMm"] as const;

/** Whitelists a raw (possibly attacker-controlled) JSON body — anything not explicitly listed here is silently dropped, never merged. */
export function parseCatalogItemAdminEdit(body: unknown): CatalogItemAdminEdit {
  if (!body || typeof body !== "object") return {};
  const raw = body as Record<string, unknown>;
  const edit: { -readonly [K in keyof CatalogItemAdminEdit]?: CatalogItemAdminEdit[K] } = {};
  for (const key of EDITABLE_STRING_KEYS) {
    const value = raw[key];
    if (typeof value === "string") edit[key] = value;
  }
  for (const key of EDITABLE_NUMBER_KEYS) {
    const value = raw[key];
    if (typeof value === "number" && Number.isFinite(value)) edit[key] = value;
  }
  if (typeof raw.lifecycleStatus === "string" && isValidCatalogItemStatus(raw.lifecycleStatus)) edit.lifecycleStatus = raw.lifecycleStatus;
  return edit;
}

/**
 * Pure merge into the EXISTING document — spreads first so every unknown/non-whitelisted field
 * (parts, printSurfaces, pricingEntries, assets, sourceSystem, sourceKey, ...) survives
 * untouched. This is the P86-sanity guarantee (section 12): save can never serialize a small
 * form and silently drop canonical metadata.
 */
export function applyCatalogItemEdit(document: CatalogItemAdminDocument, edit: CatalogItemAdminEdit): CatalogItemAdminDocument {
  const next: CatalogItemAdminDocument = { ...document };
  if (edit.displayName !== undefined) next.displayName = edit.displayName;
  if (edit.name !== undefined) next.name = edit.name;
  if (edit.category !== undefined) next.category = edit.category;
  if (edit.unit !== undefined) next.unit = edit.unit;
  if (edit.widthMm !== undefined) next.widthMm = edit.widthMm;
  if (edit.depthMm !== undefined) next.depthMm = edit.depthMm;
  if (edit.heightMm !== undefined) next.heightMm = edit.heightMm;
  if (edit.lifecycleStatus !== undefined) next.lifecycleStatus = edit.lifecycleStatus;
  return next;
}

export class CatalogItemAdminNotFoundError extends Error {
  readonly id: string;
  constructor(id: string) {
    super(`Katalogová položka ${id} nebyla nalezena.`);
    this.name = "CatalogItemAdminNotFoundError";
    this.id = id;
  }
}

export function isKnownCatalogItemKind(value: string): value is CatalogItemKind {
  return (CATALOG_ITEM_KINDS as readonly string[]).includes(value);
}
