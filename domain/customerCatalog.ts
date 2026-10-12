/**
 * Zákaznický katalog ("Katalog") — the presentation output built FROM the existing component
 * catalog. Pure, no I/O. This module is a consumer only:
 *
 *  - items come from catalog_items (CatalogItemAdmin) and their `document.catalogPublication`
 *    section (domain/catalogItemsAdmin.ts) — never a parallel catalog;
 *  - prices come from the existing Event → PriceList → PricingEntry resolution
 *    (selectPricingEntry / derivePricingAvailability in domain/catalog.ts) — never a catalog-only
 *    price, never a currency conversion, never VAT (every price in this project is BEZ DPH);
 *  - the HTML preview and the PDF renderer (lib/customerCatalogPdf.ts) both draw the SAME
 *    CustomerCatalogDocument built here, so what the user previews is what gets exported.
 */
import type { StoredAsset } from "./assets.ts";
import { derivePricingAvailability, selectPricingEntry } from "./catalog.ts";
import {
  abfCodeOf,
  categoryLabelCs,
  documentCatalogPublication,
  documentDimensions,
  documentPhotoAsset,
  documentPhotoUrl,
  documentServiceTechnical,
  documentVariants,
  itemTypeOf,
  type CatalogItemAdmin,
  type DocumentDimensions,
} from "./catalogItemsAdmin.ts";
import { packageItemsFor } from "./catalogPackages.ts";
import { pricingEntriesForCatalogItem, type PricingEntrySummary } from "./catalogPricing.ts";
import { sanitizeFileNameSegment } from "./graphicsFileNaming.ts";
import type { CatalogItemType, Currency } from "./models.ts";
import type { Exhibition, PriceList } from "./organizations.ts";

// ============================================================================
// PUBLISHABILITY
// ============================================================================

export const CUSTOMER_CATALOG_ITEM_TYPES = ["PRODUCT", "SERVICE", "BOOTH"] as const;
export type CustomerCatalogItemType = (typeof CUSTOMER_CATALOG_ITEM_TYPES)[number];

export const CUSTOMER_CATALOG_TYPE_LABELS_CS: Readonly<Record<CustomerCatalogItemType, string>> = {
  PRODUCT: "Produkt",
  SERVICE: "Služba",
  BOOTH: "Stánek",
};

/** INTERNAL_COMPONENT is never offered to a customer, whatever its publication flag says. */
export function isCustomerCatalogItemType(itemType: CatalogItemType): itemType is CustomerCatalogItemType {
  return (CUSTOMER_CATALOG_ITEM_TYPES as readonly string[]).includes(itemType);
}

/** Whether the admin may publish this card at all (drives the "Publikace v katalogu" section). */
export function canPublishInCustomerCatalog(item: Pick<CatalogItemAdmin, "itemType" | "kind">): boolean {
  return isCustomerCatalogItemType(itemTypeOf(item));
}

/**
 * The one publishability rule: a customer-facing type, not archived, and explicitly switched on
 * ("Zobrazovat v katalogu"). Readiness for the booth generator is deliberately NOT part of it —
 * a product can be sold from the catalog long before it has a 3D model.
 */
export function isPublishedInCustomerCatalog(item: Pick<CatalogItemAdmin, "itemType" | "kind" | "lifecycleStatus" | "document">): boolean {
  return canPublishInCustomerCatalog(item) && item.lifecycleStatus !== "archived" && documentCatalogPublication(item.document).visible;
}

// ============================================================================
// PRICE CONTEXT — Event → PriceList (in the requested currency) → PricingEntry
// ============================================================================

/**
 * Price lists assigned to the event (Exhibition.priceListIds — the authoritative link) in exactly
 * the requested currency; the event's default list first. Empty means "this event has no price
 * list in this currency" — a real state the UI shows as such. Never falls back to the other
 * currency and never converts.
 */
export function eventPriceListsForCurrency(
  event: Pick<Exhibition, "priceListIds" | "defaultPriceListId"> | undefined,
  priceLists: readonly PriceList[],
  currency: Currency,
): readonly PriceList[] {
  if (!event) return [];
  return priceLists
    .filter((priceList) => event.priceListIds.includes(priceList.id) && priceList.currency === currency && priceList.active)
    .sort((a, b) => Number(b.id === event.defaultPriceListId) - Number(a.id === event.defaultPriceListId) || event.priceListIds.indexOf(a.id) - event.priceListIds.indexOf(b.id));
}

/** The price list the catalog prices against: the explicitly chosen one when it is still a valid candidate, else the first candidate. */
export function resolveCatalogPriceList(
  event: Pick<Exhibition, "priceListIds" | "defaultPriceListId"> | undefined,
  priceLists: readonly PriceList[],
  currency: Currency,
  preferredPriceListId?: string,
): PriceList | undefined {
  const candidates = eventPriceListsForCurrency(event, priceLists, currency);
  return candidates.find((priceList) => priceList.id === preferredPriceListId) ?? candidates[0];
}

export type CustomerCatalogPriceContext = Readonly<{
  event?: Pick<Exhibition, "id" | "realizationCompanyId">;
  priceList?: Pick<PriceList, "id" | "currency" | "realizationCompanyId">;
  currency: Currency;
  /** pricing_entries rows of the chosen price list (lib/db/catalogPricing — readPricingEntriesForPriceList). */
  entries: readonly PricingEntrySummary[];
  at?: string;
}>;

export type CustomerCatalogPrice =
  | Readonly<{ status: "fixed"; amount: number; currency: Currency }>
  | Readonly<{ status: "individual" }>
  | Readonly<{ status: "included" }>
  | Readonly<{ status: "missing" }>;

/**
 * "missing" whenever nothing resolves — no price list for the currency, no entry for the item, or
 * a fixed entry without a number. Never 0: a zero only appears when the stored sale price IS 0.
 */
export function resolveCustomerCatalogPrice(catalogItemId: string, context: CustomerCatalogPriceContext): CustomerCatalogPrice {
  const priceList = context.priceList;
  if (!priceList || priceList.currency !== context.currency) return { status: "missing" };
  const candidates = pricingEntriesForCatalogItem(catalogItemId, context.entries).filter((entry) => entry.priceListId === priceList.id);
  const entry = selectPricingEntry(candidates, {
    exhibitionId: context.event?.id,
    realizationCompanyId: priceList.realizationCompanyId ?? context.event?.realizationCompanyId,
    priceListId: priceList.id,
    currency: context.currency,
    at: context.at,
  });
  const availability = derivePricingAvailability(entry);
  if (availability === "fixed") return { status: "fixed", amount: entry!.salePrice!, currency: context.currency };
  return { status: availability };
}

export const PRICE_WITHOUT_VAT_SUFFIX = "bez DPH";

/**
 * "1 250 Kč bez DPH" / "€ 52 bez DPH". Thousands are separated by a no-break space (U+00A0).
 * `euroSign: "code"` writes "EUR 52 bez DPH" — the PDF's embedded font subset
 * (lib/fonts/graphicsProductionFont.ts) has no € glyph, so the PDF and its preview use the code.
 */
export function formatCatalogPrice(amount: number, currency: Currency, euroSign: "symbol" | "code" = "symbol"): string {
  const number = new Intl.NumberFormat("cs-CZ", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(amount).replace(/[   ]/gu, " ");
  if (currency === "EUR") return `${euroSign === "symbol" ? "€" : "EUR"} ${number} ${PRICE_WITHOUT_VAT_SUFFIX}`;
  return `${number} Kč ${PRICE_WITHOUT_VAT_SUFFIX}`;
}

// ============================================================================
// ENTRIES — one published catalog item with everything a card may show
// ============================================================================

export type CustomerCatalogPackageLine = Readonly<{ childItemId: string; name: string; quantity: number; unit: string | null }>;

export type CustomerCatalogEntry = Readonly<{
  id: string;
  itemType: CustomerCatalogItemType;
  /** Catalog name when set, the technical display name otherwise. */
  name: string;
  abfCode: string | null;
  internalCode: string | null;
  category: string | null;
  categoryLabel: string;
  unit: string | null;
  shortDescription: string | null;
  dimensions: DocumentDimensions;
  /** Never a signed URL — resolved by the caller (catalog image, else the item's own photo). */
  imageAsset?: StoredAsset;
  imageUrl?: string;
  sortOrder: number | null;
  /** SERVICE technical metadata flattened to label/value pairs. */
  technicalParameters: readonly Readonly<{ key: string; value: string }>[];
  /** BOOTH: customer-facing package contents — never internal construction components. */
  packageContents: readonly CustomerCatalogPackageLine[];
  price: CustomerCatalogPrice;
}>;

export const UNCATEGORIZED_CATEGORY_LABEL = "Ostatní";

function formatQuantity(value: number): string {
  return new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 2 }).format(value);
}

function customerName(item: Pick<CatalogItemAdmin, "document" | "displayName">): string {
  return documentCatalogPublication(item.document).name ?? item.displayName;
}

function entryImage(item: CatalogItemAdmin): Readonly<{ imageAsset?: StoredAsset; imageUrl?: string }> {
  const publication = documentCatalogPublication(item.document);
  const asset = publication.image ?? documentPhotoAsset(item.document) ?? documentVariants(item.document).find((variant) => variant.photoAsset)?.photoAsset;
  if (asset) return { imageAsset: asset };
  const url = documentPhotoUrl(item.document);
  return url ? { imageUrl: url } : {};
}

function serviceParameters(item: CatalogItemAdmin): readonly Readonly<{ key: string; value: string }>[] {
  const technical = documentServiceTechnical(item.document);
  if (!technical) return [];
  return [
    ...(technical.powerKw !== undefined ? [{ key: "Výkon", value: `${formatQuantity(technical.powerKw)} kW` }] : []),
    ...(technical.parameters ?? []),
  ];
}

/**
 * What the base package contains, for the customer: only lines included in the package price
 * whose child is itself a customer-facing type. INTERNAL_COMPONENT children (panels, posts,
 * profiles) are construction detail and never listed; optional extras are not "contents".
 */
function boothPackageContents(item: CatalogItemAdmin, itemsById: ReadonlyMap<string, CatalogItemAdmin>): readonly CustomerCatalogPackageLine[] {
  return packageItemsFor(item.id, item.packageItems ?? []).flatMap((line) => {
    const child = itemsById.get(line.childItemId);
    if (!child || !line.includedInPackage || !canPublishInCustomerCatalog(child)) return [];
    return [{ childItemId: child.id, name: customerName(child), quantity: line.quantity, unit: child.unit }];
  });
}

/** Published items only (see isPublishedInCustomerCatalog), each priced for the given context. Order is the caller's concern — see sortCustomerCatalogEntries. */
export function buildCustomerCatalogEntries(items: readonly CatalogItemAdmin[], context: CustomerCatalogPriceContext): readonly CustomerCatalogEntry[] {
  const itemsById = new Map(items.map((item) => [item.id, item]));
  return items.filter(isPublishedInCustomerCatalog).map((item) => {
    const itemType = itemTypeOf(item) as CustomerCatalogItemType;
    const publication = documentCatalogPublication(item.document);
    return {
      id: item.id,
      itemType,
      name: customerName(item),
      abfCode: abfCodeOf(item),
      internalCode: item.internalCode,
      category: item.category,
      categoryLabel: item.category ? categoryLabelCs(item.category) : UNCATEGORIZED_CATEGORY_LABEL,
      unit: item.unit?.trim() || null,
      shortDescription: publication.shortDescription ?? null,
      dimensions: documentDimensions(item.document),
      ...entryImage(item),
      sortOrder: publication.sortOrder ?? null,
      technicalParameters: itemType === "SERVICE" ? serviceParameters(item) : [],
      packageContents: itemType === "BOOTH" ? boothPackageContents(item, itemsById) : [],
      price: resolveCustomerCatalogPrice(item.id, context),
    };
  });
}

// ============================================================================
// ORDER — categories, then items inside a category. Always deterministic.
// ============================================================================

const TEXT_COLLATOR = new Intl.Collator("cs", { sensitivity: "base", numeric: true });

/** Stable key for a category — "" groups every item without one. */
export function catalogCategoryKey(entry: Pick<CustomerCatalogEntry, "category">): string {
  return entry.category ?? "";
}

function compareWithinCategory(a: CustomerCatalogEntry, b: CustomerCatalogEntry): number {
  if (a.sortOrder !== b.sortOrder) {
    if (a.sortOrder === null) return 1;
    if (b.sortOrder === null) return -1;
    return a.sortOrder - b.sortOrder;
  }
  return TEXT_COLLATOR.compare(a.name, b.name) || TEXT_COLLATOR.compare(a.id, b.id);
}

export type CustomerCatalogCategory = Readonly<{ key: string; label: string; count: number }>;

/**
 * Categories present in `entries`: first those named in `categoryOrder` (in that order), then the
 * rest alphabetically by label — the stable "kategorie → název" fallback when no order is set.
 */
export function orderCustomerCatalogCategories(entries: readonly CustomerCatalogEntry[], categoryOrder: readonly string[] = []): readonly CustomerCatalogCategory[] {
  const byKey = new Map<string, { key: string; label: string; count: number }>();
  for (const entry of entries) {
    const key = catalogCategoryKey(entry);
    const current = byKey.get(key);
    if (current) current.count += 1;
    else byKey.set(key, { key, label: entry.categoryLabel, count: 1 });
  }
  const rank = (key: string) => {
    const index = categoryOrder.indexOf(key);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };
  return [...byKey.values()].sort((a, b) => rank(a.key) - rank(b.key) || TEXT_COLLATOR.compare(a.label, b.label) || TEXT_COLLATOR.compare(a.key, b.key));
}

/** Category order (see orderCustomerCatalogCategories), then catalog_sort_order, then name, then id. */
export function sortCustomerCatalogEntries(entries: readonly CustomerCatalogEntry[], categoryOrder: readonly string[] = []): readonly CustomerCatalogEntry[] {
  const categoryRank = new Map(orderCustomerCatalogCategories(entries, categoryOrder).map((category, index) => [category.key, index]));
  return entries.slice().sort((a, b) => categoryRank.get(catalogCategoryKey(a))! - categoryRank.get(catalogCategoryKey(b))! || compareWithinCategory(a, b));
}

// ============================================================================
// FILTERS
// ============================================================================

export type CustomerCatalogFilters = Readonly<{
  itemType?: CustomerCatalogItemType | "";
  /** A catalogCategoryKey; undefined = every category ("" is the uncategorized group). */
  category?: string;
  query?: string;
}>;

function normalizedText(value: string): string {
  return value.toLocaleLowerCase("cs").normalize("NFD").replace(/\p{Diacritic}/gu, "");
}

export function filterCustomerCatalogEntries(entries: readonly CustomerCatalogEntry[], filters: CustomerCatalogFilters): readonly CustomerCatalogEntry[] {
  const query = filters.query?.trim() ? normalizedText(filters.query.trim()) : "";
  return entries.filter((entry) => {
    if (filters.itemType && entry.itemType !== filters.itemType) return false;
    if (filters.category !== undefined && catalogCategoryKey(entry) !== filters.category) return false;
    if (query && !normalizedText(`${entry.name} ${entry.abfCode ?? ""}`).includes(query)) return false;
    return true;
  });
}

// ============================================================================
// EXPORT OPTIONS
// ============================================================================

export type CustomerCatalogExportOptions = Readonly<{
  showPrices: boolean;
  showAbfCode: boolean;
  showDescription: boolean;
  showDimensions: boolean;
  showUnit: boolean;
  showTechnicalParameters: boolean;
  /** BOOTH "Obsahuje:" list. */
  showPackageContents: boolean;
  /** Internal code is not customer information — OFF unless switched on explicitly. */
  showInternalCode: boolean;
}>;

export const DEFAULT_CUSTOMER_CATALOG_EXPORT_OPTIONS: CustomerCatalogExportOptions = {
  showPrices: true,
  showAbfCode: true,
  showDescription: true,
  showDimensions: true,
  showUnit: true,
  showTechnicalParameters: true,
  showPackageContents: true,
  showInternalCode: false,
};

export function normalizeCustomerCatalogExportOptions(raw: unknown): CustomerCatalogExportOptions {
  const candidate = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const options: { -readonly [K in keyof CustomerCatalogExportOptions]: boolean } = { ...DEFAULT_CUSTOMER_CATALOG_EXPORT_OPTIONS };
  for (const key of Object.keys(options) as (keyof CustomerCatalogExportOptions)[]) {
    const value = candidate[key];
    if (typeof value === "boolean") options[key] = value;
  }
  return options;
}

// ============================================================================
// DOCUMENT — what the preview and the PDF both render
// ============================================================================

export type CustomerCatalogCardLayout = "product" | "service" | "booth";

const CARD_LAYOUT_BY_TYPE: Readonly<Record<CustomerCatalogItemType, CustomerCatalogCardLayout>> = {
  PRODUCT: "product",
  SERVICE: "service",
  BOOTH: "booth",
};

/** A card carries ONLY what the chosen options allow — a renderer never re-checks an option. */
export type CustomerCatalogCard = Readonly<{
  id: string;
  layout: CustomerCatalogCardLayout;
  name: string;
  abfCode?: string;
  internalCode?: string;
  description?: string;
  dimensionsLabel?: string;
  unit?: string;
  /** Always ends with "bez DPH" for a numeric price. Absent when prices are off or the item has none. */
  priceLabel?: string;
  /** Prices are on, but this item has no price for the chosen event/price list. */
  priceMissing: boolean;
  parameters: readonly Readonly<{ key: string; value: string }>[];
  /** BOOTH package contents, e.g. "2× Židle". */
  contents: readonly string[];
  hasImage: boolean;
}>;

export type CustomerCatalogSection = Readonly<{ categoryKey: string; title: string; cards: readonly CustomerCatalogCard[] }>;

export type CustomerCatalogDocument = Readonly<{
  title: string;
  eventName?: string;
  eventDateRange?: string;
  eventVenue?: string;
  currency: Currency;
  showPrices: boolean;
  sections: readonly CustomerCatalogSection[];
  itemCount: number;
  /** Selected items without a price while prices are shown — the UI warns before export. */
  missingPriceCount: number;
}>;

export const DEFAULT_CUSTOMER_CATALOG_TITLE = "Katalog vybavení a služeb";
export const CUSTOMER_CATALOG_PRICE_NOTE = "Všechny ceny jsou uvedeny bez DPH.";

function formatMillimetres(value: number): string {
  return new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 0 }).format(value).replace(/[   ]/gu, " ");
}

/** PRODUCT/SERVICE: "600 × 400 × 750 mm" (šířka × hloubka × výška). BOOTH: footprint in metres, "3 × 2 m". Undefined when width/depth are unknown. */
export function formatCatalogDimensions(dimensions: DocumentDimensions, itemType: CustomerCatalogItemType): string | undefined {
  if (!dimensions.hasDimensions || dimensions.widthMm === null || dimensions.depthMm === null) return undefined;
  if (itemType === "BOOTH") {
    const metres = (mm: number) => new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 2 }).format(mm / 1000);
    return `${metres(dimensions.widthMm)} × ${metres(dimensions.depthMm)} m`;
  }
  const parts = [dimensions.widthMm, dimensions.depthMm, ...(dimensions.heightMm !== null ? [dimensions.heightMm] : [])];
  return `${parts.map(formatMillimetres).join(" × ")} mm`;
}

function priceLabelFor(price: CustomerCatalogPrice): string | undefined {
  switch (price.status) {
    case "fixed":
      return formatCatalogPrice(price.amount, price.currency, "code");
    case "individual":
      return "Cena na vyžádání";
    case "included":
      return "V ceně";
    default:
      return undefined;
  }
}

export function buildCustomerCatalogCard(entry: CustomerCatalogEntry, options: CustomerCatalogExportOptions): CustomerCatalogCard {
  const priceLabel = options.showPrices ? priceLabelFor(entry.price) : undefined;
  const dimensionsLabel = options.showDimensions ? formatCatalogDimensions(entry.dimensions, entry.itemType) : undefined;
  return {
    id: entry.id,
    layout: CARD_LAYOUT_BY_TYPE[entry.itemType],
    name: entry.name,
    ...(options.showAbfCode && entry.abfCode ? { abfCode: entry.abfCode } : {}),
    ...(options.showInternalCode && entry.internalCode ? { internalCode: entry.internalCode } : {}),
    ...(options.showDescription && entry.shortDescription ? { description: entry.shortDescription } : {}),
    ...(dimensionsLabel ? { dimensionsLabel } : {}),
    ...(options.showUnit && entry.unit ? { unit: entry.unit } : {}),
    ...(priceLabel ? { priceLabel } : {}),
    priceMissing: options.showPrices && entry.price.status === "missing",
    parameters: options.showTechnicalParameters ? entry.technicalParameters : [],
    contents: options.showPackageContents
      ? entry.packageContents.map((line) => (line.quantity === 1 ? line.name : `${formatQuantity(line.quantity)}× ${line.name}`))
      : [],
    hasImage: Boolean(entry.imageAsset || entry.imageUrl),
  };
}

/** "ABF M57" / "ABF M57 · INT-PULT-01" — undefined when neither code is shown. */
export function catalogCardCodeLine(card: Pick<CustomerCatalogCard, "abfCode" | "internalCode">): string | undefined {
  const parts = [card.abfCode ? `ABF ${card.abfCode}` : undefined, card.internalCode].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

/** "1 250 Kč bez DPH / ks", or "Jednotka: ks" when only the unit is shown. Shared by the preview and the PDF. */
export function catalogCardPriceLine(card: Pick<CustomerCatalogCard, "priceLabel" | "unit">): string | undefined {
  if (card.priceLabel) return card.unit && card.priceLabel.endsWith(PRICE_WITHOUT_VAT_SUFFIX) ? `${card.priceLabel} / ${card.unit}` : card.priceLabel;
  return card.unit ? `Jednotka: ${card.unit}` : undefined;
}

export function countEntriesWithoutPrice(entries: readonly CustomerCatalogEntry[]): number {
  return entries.filter((entry) => entry.price.status === "missing").length;
}

function formatEventDateRange(event: Pick<Exhibition, "eventFrom" | "eventTo">): string | undefined {
  if (!event.eventFrom) return undefined;
  const format = (iso: string) => new Date(iso).toLocaleDateString("cs-CZ").replace(/[   ]/gu, " ");
  const from = format(event.eventFrom);
  const to = event.eventTo ? format(event.eventTo) : undefined;
  return to && to !== from ? `${from} – ${to}` : from;
}

export function buildCustomerCatalogDocument(input: Readonly<{
  /** The SELECTED entries, in any order. */
  entries: readonly CustomerCatalogEntry[];
  options: CustomerCatalogExportOptions;
  currency: Currency;
  event?: Pick<Exhibition, "name" | "venue" | "eventFrom" | "eventTo">;
  categoryOrder?: readonly string[];
  title?: string;
}>): CustomerCatalogDocument {
  const sorted = sortCustomerCatalogEntries(input.entries, input.categoryOrder);
  const sections = orderCustomerCatalogCategories(sorted, input.categoryOrder).map((category) => ({
    categoryKey: category.key,
    title: category.label,
    cards: sorted.filter((entry) => catalogCategoryKey(entry) === category.key).map((entry) => buildCustomerCatalogCard(entry, input.options)),
  }));
  const dateRange = input.event ? formatEventDateRange(input.event) : undefined;
  return {
    title: input.title?.trim() || DEFAULT_CUSTOMER_CATALOG_TITLE,
    ...(input.event?.name ? { eventName: input.event.name } : {}),
    ...(dateRange ? { eventDateRange: dateRange } : {}),
    ...(input.event?.venue ? { eventVenue: input.event.venue } : {}),
    currency: input.currency,
    showPrices: input.options.showPrices,
    sections,
    itemCount: sorted.length,
    missingPriceCount: input.options.showPrices ? countEntriesWithoutPrice(sorted) : 0,
  };
}

/** "Katalog_FOR_BEAUTY_2026_CZK.pdf" — diacritics stripped, anything not filesystem-safe collapsed to "_". */
export function buildCustomerCatalogFileName(input: Readonly<{ eventName?: string; currency: Currency }>): string {
  const eventSegment = input.eventName
    ? sanitizeFileNameSegment(input.eventName).replace(/[^A-Za-z0-9_]+/gu, "_").replace(/_+/gu, "_").replace(/^_+|_+$/gu, "")
    : "";
  return `${["Katalog", eventSegment, input.currency].filter(Boolean).join("_")}.pdf`;
}

// ============================================================================
// SAVED CONFIGURATION ("FOR BEAUTY 2026 – kompletní katalog")
// ============================================================================

export type CustomerCatalogPresetConfig = Readonly<{
  eventId?: string;
  priceListId?: string;
  currency: Currency;
  itemType: CustomerCatalogItemType | "";
  category?: string;
  selectedItemIds: readonly string[];
  options: CustomerCatalogExportOptions;
  categoryOrder: readonly string[];
  title?: string;
}>;

export type CustomerCatalogPreset = Readonly<{
  id: string;
  name: string;
  config: CustomerCatalogPresetConfig;
  createdAt: string;
  updatedAt: string;
}>;

export type CustomerCatalogPresetInput = Readonly<{ id?: string; name: string; config: CustomerCatalogPresetConfig }>;

export interface CustomerCatalogPresetRepository {
  list(): Promise<readonly CustomerCatalogPreset[]>;
  save(input: CustomerCatalogPresetInput): Promise<CustomerCatalogPreset>;
  delete(id: string): Promise<void>;
}

export class InvalidCustomerCatalogPresetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCustomerCatalogPresetError";
  }
}

const PRESET_NAME_MAX = 120;
const PRESET_TITLE_MAX = 120;
const PRESET_MAX_ITEMS = 5000;

function stringList(raw: unknown, max: number): readonly string[] {
  return Array.isArray(raw) ? [...new Set(raw.filter((value): value is string => typeof value === "string"))].slice(0, max) : [];
}

/** Defensive read of a stored/posted config — unknown fields dropped, missing ones defaulted. Ids that no longer exist are harmless: the page simply finds nothing to select for them. */
export function normalizeCustomerCatalogPresetConfig(raw: unknown): CustomerCatalogPresetConfig {
  const candidate = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const title = typeof candidate.title === "string" ? candidate.title.trim().slice(0, PRESET_TITLE_MAX) : "";
  return {
    ...(typeof candidate.eventId === "string" && candidate.eventId ? { eventId: candidate.eventId } : {}),
    ...(typeof candidate.priceListId === "string" && candidate.priceListId ? { priceListId: candidate.priceListId } : {}),
    currency: candidate.currency === "EUR" ? "EUR" : "CZK",
    itemType: (CUSTOMER_CATALOG_ITEM_TYPES as readonly unknown[]).includes(candidate.itemType) ? (candidate.itemType as CustomerCatalogItemType) : "",
    ...(typeof candidate.category === "string" ? { category: candidate.category } : {}),
    selectedItemIds: stringList(candidate.selectedItemIds, PRESET_MAX_ITEMS),
    options: normalizeCustomerCatalogExportOptions(candidate.options),
    categoryOrder: stringList(candidate.categoryOrder, 500),
    ...(title ? { title } : {}),
  };
}

export function parseCustomerCatalogPresetInput(body: unknown): CustomerCatalogPresetInput {
  if (!body || typeof body !== "object") throw new InvalidCustomerCatalogPresetError("Chybí data konfigurace katalogu.");
  const raw = body as Record<string, unknown>;
  const name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (!name) throw new InvalidCustomerCatalogPresetError("Zadejte název konfigurace.");
  if (name.length > PRESET_NAME_MAX) throw new InvalidCustomerCatalogPresetError(`Název konfigurace může mít nejvýše ${PRESET_NAME_MAX} znaků.`);
  if (/[<>]/u.test(name)) throw new InvalidCustomerCatalogPresetError("Název konfigurace nesmí obsahovat znaky < a >.");
  return {
    ...(typeof raw.id === "string" && raw.id ? { id: raw.id } : {}),
    name,
    config: normalizeCustomerCatalogPresetConfig(raw.config),
  };
}
