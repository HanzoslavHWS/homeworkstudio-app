/**
 * Versioned price lists (V1-DATA-05). Pure, no I/O. Mirror of
 * supabase/migrations/20261022120000_price_list_versions.sql.
 *
 * Rules (docs/V1_DATA_DECISIONS.md section 8):
 *   - base = one shared SALE list of components and furniture; electricity = SALE prices of services
 *     of the electricity category, per event; purchase = one shared PURCHASE list (Creativ Expo,
 *     Gendai, MAC Praha). Sale and purchase never share a type, a table or an API route.
 *   - Every price is without VAT. A version stores its own EUR rate and rounding. A derived EUR UNIT
 *     price is rounded by the version rule (default ceil to 1 EUR: 21.35 -> 22), never a total.
 *   - EUR source of a row: derived (from CZK), direct (set in EUR), manual (derived price overridden
 *     by hand, recorded as manual), none (not sold in EUR).
 *   - An event uses the version EXPLICITLY assigned to it. Nothing here looks at a date: valid
 *     from/to of a version is informational only.
 *   - A missing price is "missing" (to be quoted), never 0.
 *
 * The legacy resolver (domain/catalog.ts selectPricingEntry) is untouched; projects switch to this
 * one in V1-DATA-07, together with price snapshots. Every result therefore carries its origin
 * (list, version, entry, EUR rate and rounding, manual flag) so a snapshot can store it.
 */
import type { Currency } from "./models.ts";
import type { CatalogPackageItem, PackageUnitPrice } from "./catalogPackages.ts";
import { priceKit, type KitLineSelection, type KitPriceResolver, type KitPriceResult, type KitSurchargeRef } from "./catalogKitPricing.ts";
import type { CatalogVariantSet } from "./catalogVariants.ts";

// ============================================================================
// Vocabulary
// ============================================================================

export const PRICE_LIST_KINDS = ["base", "electricity", "purchase"] as const;
export type PriceListKind = (typeof PRICE_LIST_KINDS)[number];
export const SALE_PRICE_LIST_KINDS = ["base", "electricity"] as const;
export type SalePriceListKind = (typeof SALE_PRICE_LIST_KINDS)[number];

export const PRICE_LIST_KIND_LABELS_CS: Readonly<Record<PriceListKind, string>> = {
  base: "Základní prodejní ceník",
  electricity: "Ceník elektřiny",
  purchase: "Nákupní ceník",
};

export const PRICE_VERSION_STATUSES = ["draft", "published", "archived"] as const;
export type PriceVersionStatus = (typeof PRICE_VERSION_STATUSES)[number];

export const PRICE_VERSION_STATUS_LABELS_CS: Readonly<Record<PriceVersionStatus, string>> = {
  draft: "Koncept",
  published: "Publikováno",
  archived: "Archivováno",
};

/**
 * The three sale prices every fixed row carries at once (decision 8.1, 2026-10-22). An offer /
 * project chooses one explicitly — never derived from the customer's country.
 *   CZK        fixed price in CZK
 *   EUR_SK     CZK converted by the version rate and rounding (or overridden by hand, recorded)
 *   EUR_WORLD  own fixed EUR price, independent of CZK and the rate
 */
export const PRICE_TRACKS = ["CZK", "EUR_SK", "EUR_WORLD"] as const;
export type PriceTrack = (typeof PRICE_TRACKS)[number];

export const PRICE_TRACK_LABELS_CS: Readonly<Record<PriceTrack, string>> = {
  CZK: "CZK",
  EUR_SK: "EUR SK (přepočet kurzem)",
  EUR_WORLD: "EUR WORLD (pevná cena v EUR)",
};

export function isPriceTrack(value: unknown): value is PriceTrack {
  return typeof value === "string" && (PRICE_TRACKS as readonly string[]).includes(value);
}

export function currencyOfTrack(track: PriceTrack): Currency {
  return track === "CZK" ? "CZK" : "EUR";
}

/**
 * How the EUR_SK price of a row is obtained. New rows use derived | manual only. direct / none exist
 * on rows written before the three-price correction: direct = its EUR price is read as EUR_WORLD
 * (EUR_SK derived from CZK), none = no EUR_SK price.
 */
export const EUR_MODES = ["derived", "direct", "manual", "none"] as const;
export type EurMode = (typeof EUR_MODES)[number];
export const EUR_SK_MODES = ["derived", "manual"] as const;
export type EurSkMode = (typeof EUR_SK_MODES)[number];

export const EUR_MODE_LABELS_CS: Readonly<Record<EurMode, string>> = {
  derived: "přepočet",
  manual: "ruční",
  direct: "starší řádek (EUR → WORLD)",
  none: "starší řádek (bez EUR SK)",
};

export const EUR_ROUNDING_MODES = ["ceil", "round", "floor"] as const;
export type EurRoundingMode = (typeof EUR_ROUNDING_MODES)[number];

export const EUR_ROUNDING_MODE_LABELS_CS: Readonly<Record<EurRoundingMode, string>> = {
  ceil: "Nahoru",
  round: "Matematicky",
  floor: "Dolů",
};

export const EUR_ROUNDING_STEPS = [0.01, 0.1, 0.5, 1, 5, 10] as const;
export type EurRoundingStep = (typeof EUR_ROUNDING_STEPS)[number];

/** Approved test default (2026-10-22). Editable per version; changing it means a new version. */
export const DEFAULT_EUR_RATE = 24.17;
export const DEFAULT_EUR_ROUNDING_MODE: EurRoundingMode = "ceil";
export const DEFAULT_EUR_ROUNDING_STEP: EurRoundingStep = 1;

export const PRICE_CATEGORIES = ["standard", "electricity"] as const;
export type PriceCategory = (typeof PRICE_CATEGORIES)[number];

export const PRICE_CATEGORY_LABELS_CS: Readonly<Record<PriceCategory, string>> = {
  standard: "Běžná položka",
  electricity: "Elektřina",
};

export const SALE_PRICE_MODES = ["fixed", "individual", "included"] as const;
export type SalePriceMode = (typeof SALE_PRICE_MODES)[number];

export const SALE_PRICE_MODE_LABELS_CS: Readonly<Record<SalePriceMode, string>> = {
  fixed: "Pevná cena",
  individual: "Cena na dotaz",
  included: "Zahrnuto v ceně",
};

// ============================================================================
// Records
// ============================================================================

export type VersionedPriceList = Readonly<{
  id: string;
  code: string;
  name: string;
  kind: PriceListKind;
  isActive: boolean;
  note?: string;
}>;

export type PriceListVersion = Readonly<{
  id: string;
  priceListId: string;
  versionNo: number;
  /** Optimistic concurrency counter; every write states the revision it was based on. */
  revision: number;
  label?: string;
  status: PriceVersionStatus;
  /** Informational (evidenční) validity. Never used to pick a version. */
  validFrom?: string;
  validTo?: string;
  eurRate: number;
  eurRoundingMode: EurRoundingMode;
  eurRoundingStep: number;
  basedOnVersionId?: string;
  note?: string;
  createdBy?: string;
  publishedAt?: string;
  publishedBy?: string;
  archivedAt?: string;
  createdAt?: string;
}>;

/** One SALE unit price. Never carries a purchase price. */
export type SalePriceEntry = Readonly<{
  id: string;
  versionId: string;
  catalogItemId: string;
  /** Price of one variant; without it the price applies to every variant of the card. */
  variantId?: string;
  /**
   * Price of one product line of the card (catalog_variants.series, e.g. REVEXPO) — never together
   * with variantId. Keyed by the card: M02 + REVEXPO never prices M04 + REVEXPO.
   */
  variantSeries?: string;
  priceMode: SalePriceMode;
  /** CZK price. */
  saleCzk?: number;
  /** How EUR_SK is obtained (derived from saleCzk, or manual = saleEur). */
  eurMode: EurMode;
  /** Manual EUR_SK price (eurMode manual). Legacy direct rows: the EUR price, read as EUR_WORLD. */
  saleEur?: number;
  /** EUR_WORLD price — fixed, independent of saleCzk and the rate. */
  saleEurWorld?: number;
  unitCode?: string;
  note?: string;
}>;

export type SurchargeTargetKind = "variant" | "substitute";

/** Amount of a fixed / per-unit surcharge (V1-DATA-04 rules). Substitutes are keyed by kit + line + substitute, never by the substitute row id. */
export type PriceSurcharge = Readonly<{
  id: string;
  versionId: string;
  targetKind: SurchargeTargetKind;
  variantId?: string;
  kitItemId?: string;
  lineKey?: string;
  substituteItemId?: string;
  substituteVariantId?: string;
  amountCzk?: number;
  eurMode: EurMode;
  amountEur?: number;
  amountEurWorld?: number;
  note?: string;
}>;

/** INTERNAL purchase unit price (CZK, without VAT). Its own type so it can never be spread into a sale row. */
export type PurchasePriceEntry = Readonly<{
  id: string;
  versionId: string;
  catalogItemId: string;
  variantId?: string;
  purchaseCzk: number;
  unitCode?: string;
  note?: string;
}>;

export type PurchaseListCompany = Readonly<{
  id: string;
  priceListId: string;
  realizationCompanyId: string;
  isActive: boolean;
  note?: string;
}>;

export type EventPriceAssignment = Readonly<{
  id: string;
  eventId: string;
  listKind: SalePriceListKind;
  priceListVersionId: string;
  assignedAt: string;
  assignedBy?: string;
  note?: string;
  /** Set when a later assignment replaced this one. Current assignment = no replacedAt. */
  replacedAt?: string;
  replacedBy?: string;
}>;

// ============================================================================
// EUR conversion
// ============================================================================

const round2 = (value: number) => Math.round(value * 100) / 100;

export function isEurRoundingStep(value: unknown): value is EurRoundingStep {
  return typeof value === "number" && (EUR_ROUNDING_STEPS as readonly number[]).includes(value);
}

/** Rounds an EUR UNIT price to the version rule. Float noise (20.000000001) never pushes a ceil up. */
export function roundEur(value: number, mode: EurRoundingMode, step: number): number {
  const units = Math.round((value / step) * 1e6) / 1e6;
  const rounded = mode === "ceil" ? Math.ceil(units) : mode === "floor" ? Math.floor(units) : Math.round(units);
  return round2(rounded * step);
}

export type EurRule = Pick<PriceListVersion, "eurRate" | "eurRoundingMode" | "eurRoundingStep">;

/** CZK -> EUR by the version rule, e.g. 516 Kč / 24.17 = 21.35 € -> 22 €. */
export function convertCzkToEur(czk: number, rule: EurRule): number {
  if (!(rule.eurRate > 0)) throw new RangeError("Kurz EUR musí být kladné číslo.");
  return roundEur(czk / rule.eurRate, rule.eurRoundingMode, rule.eurRoundingStep);
}

/** The three prices of a row (or a surcharge) as stored. */
export type ThreePriceSource = Readonly<{ czk?: number; eurMode: EurMode; eur?: number; eurWorld?: number }>;

export type ResolvedAmount = Readonly<{
  amount?: number;
  /** How the EUR amount was obtained. Absent for CZK. */
  eurSource?: "derived" | "manual" | "world";
  /** For a manual EUR_SK price: what the conversion would have given (shown next to it). */
  derivedEur?: number;
  missingReason?: "no_czk_price" | "no_eur_sk_price" | "no_eur_world_price";
}>;

/** EUR_WORLD of a row: its own column; a legacy direct row's EUR price counts as EUR_WORLD. */
export function eurWorldOf(source: ThreePriceSource): number | undefined {
  return source.eurWorld ?? (source.eurMode === "direct" ? source.eur : undefined);
}

/** EUR_SK of a row: manual value, or CZK converted by the version rule. Never touches EUR_WORLD. */
export function eurSkOf(source: ThreePriceSource, rule: EurRule): Readonly<{ amount?: number; manual: boolean; derived?: number }> {
  const derived = source.czk !== undefined ? convertCzkToEur(source.czk, rule) : undefined;
  if (source.eurMode === "manual") return { ...(source.eur !== undefined ? { amount: source.eur } : {}), manual: true, ...(derived !== undefined ? { derived } : {}) };
  if (source.eurMode === "none") return { manual: false };
  return { ...(derived !== undefined ? { amount: derived, derived } : {}), manual: false };
}

/** One of the three prices, chosen explicitly by track. */
export function resolveAmount(source: ThreePriceSource, track: PriceTrack, rule: EurRule): ResolvedAmount {
  if (track === "CZK") return source.czk === undefined ? { missingReason: "no_czk_price" } : { amount: source.czk };
  if (track === "EUR_WORLD") {
    const world = eurWorldOf(source);
    return world === undefined ? { missingReason: "no_eur_world_price" } : { amount: world, eurSource: "world" };
  }
  const sk = eurSkOf(source, rule);
  if (sk.amount === undefined) return { missingReason: "no_eur_sk_price" };
  return sk.manual
    ? { amount: sk.amount, eurSource: "manual", ...(sk.derived !== undefined ? { derivedEur: sk.derived } : {}) }
    : { amount: sk.amount, eurSource: "derived" };
}

// ============================================================================
// Sale price resolution
// ============================================================================

/** One published (or, for previews, draft) sale version with its rows. */
export type SalePriceBook = Readonly<{
  list: VersionedPriceList;
  version: PriceListVersion;
  entries: readonly SalePriceEntry[];
  surcharges: readonly PriceSurcharge[];
}>;

export type VersionedPricingContext = Readonly<{
  /** Which of the three prices is wanted — always chosen explicitly. */
  track: PriceTrack;
  /** Version explicitly assigned to the event (or pinned in a project from V1-DATA-07). */
  base?: SalePriceBook;
  electricity?: SalePriceBook;
  /** Category of a catalog card; unknown cards count as standard. */
  priceCategoryOf: (catalogItemId: string) => PriceCategory | undefined;
  /** Product line of a variant (swatch book). Without it product-line rows are never used. */
  variantSeriesOf?: (variantId: string) => string | undefined;
}>;

export type VersionedPriceOrigin = Readonly<{
  listId: string;
  listCode: string;
  listKind: SalePriceListKind;
  versionId: string;
  versionNo: number;
  versionStatus: PriceVersionStatus;
  entryId?: string;
  surchargeId?: string;
  /** true when the row is specific to the requested variant. */
  variantSpecific: boolean;
  /** Product line whose row decided the price (variant -> product line -> card). */
  variantSeries?: string;
  eurRate: number;
  eurRoundingMode: EurRoundingMode;
  eurRoundingStep: number;
  eurSource?: ResolvedAmount["eurSource"];
  derivedEur?: number;
  /** A hand-entered EUR_SK price (eur_mode manual). */
  manual: boolean;
}>;

export type VersionedPriceStatus = "priced" | "individual" | "included" | "missing";

export type VersionedPriceMissingReason = "no_version" | "no_entry" | "no_czk_price" | "no_eur_sk_price" | "no_eur_world_price";

export type VersionedPriceResult = Readonly<{
  status: VersionedPriceStatus;
  track: PriceTrack;
  currency: Currency;
  /** Unit price without VAT. Present for priced (and 0 for included). Never invented for missing. */
  amountNet?: number;
  unitCode?: string;
  origin?: VersionedPriceOrigin;
  missingReason?: VersionedPriceMissingReason;
}>;

export const MISSING_REASON_LABELS_CS: Readonly<Record<VersionedPriceMissingReason, string>> = {
  no_version: "Veletrh nemá přiřazenou verzi ceníku — k nacenění.",
  no_entry: "Položka v přiřazené verzi ceníku chybí — k nacenění.",
  no_czk_price: "Položka nemá cenu v CZK — k nacenění.",
  no_eur_sk_price: "Položka nemá cenu EUR SK — k nacenění.",
  no_eur_world_price: "Položka nemá cenu EUR WORLD — k nacenění.",
};

function isSaleKind(kind: PriceListKind): kind is SalePriceListKind {
  return kind === "base" || kind === "electricity";
}

function booksFor(context: VersionedPricingContext, catalogItemId: string): readonly SalePriceBook[] {
  const books: SalePriceBook[] = [];
  if (context.priceCategoryOf(catalogItemId) === "electricity" && context.electricity) books.push(context.electricity);
  if (context.base) books.push(context.base);
  return books;
}

/** Variant-specific row first, then the row of the variant's product line, then the card's general row. */
export function findSaleEntry(entries: readonly SalePriceEntry[], catalogItemId: string, variantId?: string, variantSeries?: string): SalePriceEntry | undefined {
  if (variantId) {
    const specific = entries.find((entry) => entry.catalogItemId === catalogItemId && entry.variantId === variantId);
    if (specific) return specific;
  }
  if (variantSeries) {
    const line = entries.find((entry) => entry.catalogItemId === catalogItemId && !entry.variantId && entry.variantSeries === variantSeries);
    if (line) return line;
  }
  return entries.find((entry) => entry.catalogItemId === catalogItemId && !entry.variantId && !entry.variantSeries);
}

function originOf(book: SalePriceBook, extra: Partial<VersionedPriceOrigin>): VersionedPriceOrigin {
  if (!isSaleKind(book.list.kind)) throw new Error("Nákupní ceník nelze použít pro prodejní cenu.");
  return {
    listId: book.list.id,
    listCode: book.list.code,
    listKind: book.list.kind,
    versionId: book.version.id,
    versionNo: book.version.versionNo,
    versionStatus: book.version.status,
    variantSpecific: false,
    eurRate: book.version.eurRate,
    eurRoundingMode: book.version.eurRoundingMode,
    eurRoundingStep: book.version.eurRoundingStep,
    manual: false,
    ...extra,
  };
}

export function priceFromSaleEntry(book: SalePriceBook, entry: SalePriceEntry, track: PriceTrack, variantId?: string): VersionedPriceResult {
  const common = { track, currency: currencyOfTrack(track), ...(entry.unitCode ? { unitCode: entry.unitCode } : {}) };
  const variantSpecific = Boolean(variantId && entry.variantId === variantId);
  const series = entry.variantSeries ? { variantSeries: entry.variantSeries } : {};
  if (entry.priceMode === "individual") return { ...common, status: "individual", origin: originOf(book, { entryId: entry.id, variantSpecific, ...series }) };
  if (entry.priceMode === "included") return { ...common, status: "included", amountNet: 0, origin: originOf(book, { entryId: entry.id, variantSpecific, ...series }) };
  const resolved = resolveAmount({ czk: entry.saleCzk, eurMode: entry.eurMode, eur: entry.saleEur, eurWorld: entry.saleEurWorld }, track, book.version);
  const origin = originOf(book, {
    entryId: entry.id,
    variantSpecific,
    ...series,
    ...(resolved.eurSource ? { eurSource: resolved.eurSource } : {}),
    ...(resolved.derivedEur !== undefined ? { derivedEur: resolved.derivedEur } : {}),
    manual: resolved.eurSource === "manual",
  });
  if (resolved.amount === undefined) return { ...common, status: "missing", origin, missingReason: resolved.missingReason };
  return { ...common, status: "priced", amountNet: resolved.amount, origin };
}

/**
 * Sale unit price of a card (optionally of one variant) in the event's assigned versions.
 * Electricity-category cards look in the event's electricity version first and fall back to the
 * base version; every other card uses the base version only. A row found in a version decides,
 * even when it has no amount in the requested track (no silent fallback to another list).
 */
export function resolveSalePrice(context: VersionedPricingContext, catalogItemId: string, variantId?: string): VersionedPriceResult {
  const books = booksFor(context, catalogItemId);
  const missing = { status: "missing" as const, track: context.track, currency: currencyOfTrack(context.track) };
  if (books.length === 0) return { ...missing, missingReason: "no_version" };
  const variantSeries = variantId ? context.variantSeriesOf?.(variantId) : undefined;
  for (const book of books) {
    const entry = findSaleEntry(book.entries, catalogItemId, variantId, variantSeries);
    if (entry) return priceFromSaleEntry(book, entry, context.track, variantId);
  }
  return { ...missing, missingReason: "no_entry" };
}

/** Same result in the PackageUnitPrice shape of pricePackage / priceKit. Missing -> undefined (never 0). */
export function toPackageUnitPrice(result: VersionedPriceResult): PackageUnitPrice {
  if (result.status === "individual") return { priceMode: "individual" };
  if (result.status === "included") return { priceMode: "included", salePrice: 0 };
  if (result.status === "priced") return { priceMode: "fixed", salePrice: result.amountNet };
  return undefined;
}

function surchargeMatches(surcharge: PriceSurcharge, kitItemId: string, ref: KitSurchargeRef): boolean {
  if (ref.kind === "variant") return surcharge.targetKind === "variant" && surcharge.variantId === ref.variantId;
  return (
    surcharge.targetKind === "substitute" &&
    surcharge.kitItemId === kitItemId &&
    surcharge.lineKey === ref.lineKey &&
    surcharge.substituteItemId === ref.substituteItemId &&
    (surcharge.substituteVariantId ?? undefined) === (ref.substituteVariantId ?? undefined)
  );
}

export type ResolvedSurcharge = Readonly<{ amountNet?: number; surcharge?: PriceSurcharge; origin?: VersionedPriceOrigin; missingReason?: VersionedPriceMissingReason }>;

/** Amount of a fixed / per-unit surcharge (variant or kit substitute) in the event's versions. */
export function resolveSurchargeAmount(context: VersionedPricingContext, kitItemId: string, ref: KitSurchargeRef): ResolvedSurcharge {
  const books = ref.kind === "substitute" ? booksFor(context, ref.substituteItemId) : context.base ? [context.base] : [];
  if (books.length === 0) return { missingReason: "no_version" };
  for (const book of books) {
    const surcharge = book.surcharges.find((candidate) => surchargeMatches(candidate, kitItemId, ref));
    if (!surcharge) continue;
    const resolved = resolveAmount({ czk: surcharge.amountCzk, eurMode: surcharge.eurMode, eur: surcharge.amountEur, eurWorld: surcharge.amountEurWorld }, context.track, book.version);
    const origin = originOf(book, { surchargeId: surcharge.id, ...(resolved.eurSource ? { eurSource: resolved.eurSource } : {}), manual: resolved.eurSource === "manual" });
    return resolved.amount === undefined ? { surcharge, origin, missingReason: resolved.missingReason } : { amountNet: resolved.amount, surcharge, origin };
  }
  return { missingReason: "no_entry" };
}

/** KitPriceResolver (V1-DATA-04 priceKit) backed by the event's assigned versions. */
export function versionedKitPriceResolver(context: VersionedPricingContext, kitItemId: string): KitPriceResolver {
  return {
    unitPrice: (itemId, variantId) => toPackageUnitPrice(resolveSalePrice(context, itemId, variantId)),
    surchargeAmount: (ref) => resolveSurchargeAmount(context, kitItemId, ref).amountNet,
  };
}

export type VersionedKitPriceResult = KitPriceResult & Readonly<{ track: PriceTrack; currency: Currency; kitPrice: VersionedPriceResult }>;

/**
 * Kit / booth price: the kit card's own price plus optional lines and surcharges. Included lines
 * never add their component's price again; text lines are never priced. A kit without a price, or
 * any line without one, makes the whole kit "needs quote" — nothing becomes 0.
 */
export function priceKitVersioned(input: Readonly<{
  context: VersionedPricingContext;
  kitItemId: string;
  lines: readonly CatalogPackageItem[];
  variantSets?: readonly CatalogVariantSet[];
  selections?: readonly KitLineSelection[];
  agreementItemIds?: ReadonlySet<string>;
}>): VersionedKitPriceResult {
  const kitPrice = resolveSalePrice(input.context, input.kitItemId);
  const kitPriceNet = kitPrice.status === "priced" || kitPrice.status === "included" ? kitPrice.amountNet ?? 0 : 0;
  const result = priceKit({
    kitPriceNet,
    lines: input.lines,
    ...(input.variantSets ? { variantSets: input.variantSets } : {}),
    ...(input.selections ? { selections: input.selections } : {}),
    ...(input.agreementItemIds ? { agreementItemIds: input.agreementItemIds } : {}),
    resolver: versionedKitPriceResolver(input.context, input.kitItemId),
  });
  const kitNeedsQuote = kitPrice.status === "missing" || kitPrice.status === "individual";
  return { ...result, needsQuote: result.needsQuote || kitNeedsQuote, track: input.context.track, currency: currencyOfTrack(input.context.track), kitPrice };
}

/**
 * How many fixed rows / surcharges of a version can NOT be priced in each track. Used to warn when a
 * version is assigned to an event: e.g. versions published before the three-price correction have
 * no EUR_WORLD, so EUR_WORLD stays "k nacenění" — nothing is invented or converted from CZK.
 */
export type TrackCoverage = Readonly<{ fixedRows: number; surcharges: number; missingRows: Readonly<Record<PriceTrack, number>>; missingSurcharges: Readonly<Record<PriceTrack, number>> }>;

export function versionTrackCoverage(entries: readonly SalePriceEntry[], surcharges: readonly PriceSurcharge[], rule: EurRule): TrackCoverage {
  const count = (sources: readonly ThreePriceSource[], track: PriceTrack) => sources.filter((source) => resolveAmount(source, track, rule).amount === undefined).length;
  const rows = entries.filter((entry) => entry.priceMode === "fixed").map((entry) => ({ czk: entry.saleCzk, eurMode: entry.eurMode, eur: entry.saleEur, eurWorld: entry.saleEurWorld }));
  const amounts = surcharges.map((surcharge) => ({ czk: surcharge.amountCzk, eurMode: surcharge.eurMode, eur: surcharge.amountEur, eurWorld: surcharge.amountEurWorld }));
  const byTrack = (sources: readonly ThreePriceSource[]) => Object.fromEntries(PRICE_TRACKS.map((track) => [track, count(sources, track)])) as Record<PriceTrack, number>;
  return { fixedRows: rows.length, surcharges: amounts.length, missingRows: byTrack(rows), missingSurcharges: byTrack(amounts) };
}

/** Warning text for an incomplete version (empty when every track is covered). Shared by the price pages and the event card. */
export function coverageWarningText(coverage: TrackCoverage | undefined): string {
  const tracks = uncoveredTracks(coverage);
  if (!coverage || tracks.length === 0) return "";
  return tracks.map((track) => `${PRICE_TRACK_LABELS_CS[track]}: chybí u ${coverage.missingRows[track]} položek${coverage.missingSurcharges[track] ? ` a ${coverage.missingSurcharges[track]} doplatků` : ""}`).join("; ") + " — v tomto režimu bude cena „k nacenění“ (nic se nedopočítává).";
}

/** Tracks a version cannot fully price (any fixed row or surcharge missing). */
export function uncoveredTracks(coverage: TrackCoverage | undefined): readonly PriceTrack[] {
  if (!coverage) return [];
  return PRICE_TRACKS.filter((track) => coverage.missingRows[track] > 0 || coverage.missingSurcharges[track] > 0);
}

// ============================================================================
// Event assignments (explicit, never by date)
// ============================================================================

export function currentEventAssignment(assignments: readonly EventPriceAssignment[], eventId: string, listKind: SalePriceListKind): EventPriceAssignment | undefined {
  return assignments.find((assignment) => assignment.eventId === eventId && assignment.listKind === listKind && !assignment.replacedAt);
}

/** Newest first. */
export function eventAssignmentHistory(assignments: readonly EventPriceAssignment[], eventId: string): readonly EventPriceAssignment[] {
  return assignments.filter((assignment) => assignment.eventId === eventId).slice().sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
}

/** Events currently using a version (so the UI can say "used by FOR BEAUTY 2026"). */
export function eventsUsingVersion(assignments: readonly EventPriceAssignment[], versionId: string): readonly string[] {
  return [...new Set(assignments.filter((assignment) => !assignment.replacedAt && assignment.priceListVersionId === versionId).map((assignment) => assignment.eventId))];
}

/** Only a published version may be assigned, and only to the matching slot. */
export function assignmentIssue(list: Pick<VersionedPriceList, "kind"> | undefined, version: Pick<PriceListVersion, "status"> | undefined, listKind: SalePriceListKind): string | undefined {
  if (!version || !list) return "Verze ceníku nebyla nalezena.";
  if (list.kind !== listKind) return "Druh ceníku neodpovídá přiřazení (základní / elektřina).";
  if (version.status !== "published") return "Veletrhu lze přiřadit jen publikovanou verzi ceníku.";
  return undefined;
}

// ============================================================================
// Purchase prices
// ============================================================================

export type PurchasePriceBook = Readonly<{
  list: VersionedPriceList;
  version: PriceListVersion;
  entries: readonly PurchasePriceEntry[];
}>;

export type PurchasePriceResult = Readonly<{
  status: "priced" | "missing";
  amountCzk?: number;
  unitCode?: string;
  listId?: string;
  versionId?: string;
  versionNo?: number;
  entryId?: string;
}>;

export function resolvePurchasePrice(book: PurchasePriceBook | undefined, catalogItemId: string, variantId?: string): PurchasePriceResult {
  if (!book || book.list.kind !== "purchase") return { status: "missing" };
  const entry =
    (variantId ? book.entries.find((candidate) => candidate.catalogItemId === catalogItemId && candidate.variantId === variantId) : undefined) ??
    book.entries.find((candidate) => candidate.catalogItemId === catalogItemId && !candidate.variantId);
  if (!entry) return { status: "missing", listId: book.list.id, versionId: book.version.id, versionNo: book.version.versionNo };
  return {
    status: "priced",
    amountCzk: entry.purchaseCzk,
    ...(entry.unitCode ? { unitCode: entry.unitCode } : {}),
    listId: book.list.id,
    versionId: book.version.id,
    versionNo: book.version.versionNo,
    entryId: entry.id,
  };
}

/** The purchase list a realization firm buys by (MVP: one active list per firm). */
export function purchaseListIdForCompany(links: readonly PurchaseListCompany[], realizationCompanyId: string): string | undefined {
  return links.find((link) => link.isActive && link.realizationCompanyId === realizationCompanyId)?.priceListId;
}

/** Newest published version of a list — a UI default only; nothing pricing-relevant picks a version this way. */
export function latestPublishedVersion(versions: readonly PriceListVersion[], priceListId: string): PriceListVersion | undefined {
  return versions
    .filter((version) => version.priceListId === priceListId && version.status === "published")
    .sort((a, b) => b.versionNo - a.versionNo)[0];
}

// ============================================================================
// Publish checks (the DB repeats the hard ones)
// ============================================================================

export type PublishCheckItem = Readonly<{ id: string; displayName: string; priceCategory: PriceCategory; lifecycleStatus?: string }>;

export type PublishCheck = Readonly<{ errors: readonly string[]; warnings: readonly string[] }>;

/** Whether two informational validity ranges overlap (open ends count as infinite). */
export function validityOverlaps(a: Pick<PriceListVersion, "validFrom" | "validTo">, b: Pick<PriceListVersion, "validFrom" | "validTo">): boolean {
  const aFrom = a.validFrom ?? "0000-01-01";
  const aTo = a.validTo ?? "9999-12-31";
  const bFrom = b.validFrom ?? "0000-01-01";
  const bTo = b.validTo ?? "9999-12-31";
  return aFrom <= bTo && bFrom <= aTo;
}

export function validateVersionForPublish(input: Readonly<{
  list: VersionedPriceList;
  version: PriceListVersion;
  rowCount: number;
  saleEntries?: readonly SalePriceEntry[];
  surcharges?: readonly PriceSurcharge[];
  otherVersions?: readonly PriceListVersion[];
  items: readonly PublishCheckItem[];
}>): PublishCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (input.version.status !== "draft") errors.push("Publikovat lze jen koncept.");
  if (input.rowCount === 0) errors.push("Prázdnou verzi ceníku nelze publikovat.");
  if (!(input.version.eurRate > 0)) errors.push("Kurz EUR musí být kladné číslo.");
  const itemById = new Map(input.items.map((item) => [item.id, item]));
  if (input.list.kind === "electricity") {
    const foreign = (input.saleEntries ?? []).filter((entry) => itemById.get(entry.catalogItemId)?.priceCategory !== "electricity");
    if (foreign.length) errors.push(`Ceník elektřiny smí obsahovat jen položky kategorie Elektřina (${foreign.map((entry) => itemById.get(entry.catalogItemId)?.displayName ?? entry.catalogItemId).join(", ")}).`);
  }
  // Every fixed row needs all three prices (CZK, EUR_SK, EUR_WORLD) — decision 8.1.
  const incomplete = (input.saleEntries ?? []).filter((entry) => entry.priceMode === "fixed" && missingTracks(entry, input.version).length > 0);
  if (incomplete.length) {
    errors.push(`Každá položka s pevnou cenou musí mít CZK, EUR SK i EUR WORLD. Chybí u: ${incomplete.map((entry) => `${itemById.get(entry.catalogItemId)?.displayName ?? entry.catalogItemId} (${missingTracks(entry, input.version).join(", ")})`).join("; ")}.`);
  }
  const incompleteSurcharges = (input.surcharges ?? []).filter((surcharge) => missingTracks({ saleCzk: surcharge.amountCzk, eurMode: surcharge.eurMode, saleEur: surcharge.amountEur, saleEurWorld: surcharge.amountEurWorld }, input.version).length > 0);
  if (incompleteSurcharges.length) errors.push(`Každý doplatek musí mít částku CZK, EUR SK i EUR WORLD (neúplných: ${incompleteSurcharges.length}).`);
  const archived = (input.saleEntries ?? []).filter((entry) => {
    const status = itemById.get(entry.catalogItemId)?.lifecycleStatus;
    return status === "archived" || status === "inactive";
  });
  if (archived.length) warnings.push(`Verze obsahuje archivované nebo neaktivní karty: ${archived.map((entry) => itemById.get(entry.catalogItemId)?.displayName ?? entry.catalogItemId).join(", ")}.`);
  if (!input.version.validFrom) warnings.push("Verze nemá vyplněnou evidenční platnost od.");
  const overlapping = (input.otherVersions ?? []).filter((other) => other.id !== input.version.id && other.priceListId === input.version.priceListId && other.status === "published" && validityOverlaps(other, input.version));
  if (overlapping.length) warnings.push(`Evidenční platnost se překrývá s verzí ${overlapping.map((other) => `v${other.versionNo}`).join(", ")}. Nevadí to: veletrh používá jen výslovně přiřazenou verzi.`);
  return { errors, warnings };
}

/** Which of the three prices a fixed row (or surcharge) lacks. Legacy direct / none rows count as incomplete for a new publish. */
export function missingTracks(row: Pick<SalePriceEntry, "saleCzk" | "eurMode" | "saleEur" | "saleEurWorld">, rule: EurRule): readonly PriceTrack[] {
  const missing: PriceTrack[] = [];
  if (row.saleCzk === undefined) missing.push("CZK");
  if ((row.eurMode !== "derived" && row.eurMode !== "manual") || resolveAmount({ czk: row.saleCzk, eurMode: row.eurMode, eur: row.saleEur }, "EUR_SK", rule).amount === undefined) missing.push("EUR_SK");
  if (row.saleEurWorld === undefined) missing.push("EUR_WORLD");
  return missing;
}

// ============================================================================
// Input parsing (server routes)
// ============================================================================

export class InvalidPriceVersionInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPriceVersionInputError";
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;
const LIST_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]*$/u;
const LINE_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/u;

function fail(message: string): never {
  throw new InvalidPriceVersionInputError(message);
}

function optionalText(value: unknown, field: string, max = 500): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") fail(`Pole ${field} musí být text.`);
  const trimmed = value.trim();
  if (trimmed.length > max) fail(`Pole ${field} je delší než ${max} znaků.`);
  return trimmed || undefined;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) fail(`Pole ${field} musí být platné ID.`);
  return value;
}

function optionalUuid(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return uuid(value, field);
}

/** Accepts 516, "516", "516,50", "1 234,5". Empty = undefined (never 0). */
/** Product-line key of a sale row (same shape as catalog_variants.series: REVEXPO, PODIUM-PLAT). */
function optionalSeries(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !/^[A-Z0-9][A-Z0-9_-]*$/u.test(value.trim()) || value.trim().length > 64) fail(`Pole ${field} smí obsahovat jen velká písmena, číslice, - a _.`);
  return value.trim();
}

export function parsePriceAmount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(/\s/gu, "").replace(",", ".")) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) fail(`Pole ${field} musí být nezáporné číslo.`);
  if (Math.round(parsed * 100) / 100 !== parsed) fail(`Pole ${field} smí mít nejvýš dvě desetinná místa.`);
  return parsed;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], field: string, fallback?: T): T {
  if ((value === undefined || value === null || value === "") && fallback !== undefined) return fallback;
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) fail(`Pole ${field} má neplatnou hodnotu.`);
  return value as T;
}

function optionalDate(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !DATE_PATTERN.test(value) || Number.isNaN(Date.parse(value))) fail(`Pole ${field} musí být datum RRRR-MM-DD.`);
  return value;
}

export type PriceListInput = Readonly<{ id?: string; code: string; name: string; kind: PriceListKind; isActive: boolean; note?: string }>;

export function parsePriceListInput(raw: unknown, allowedKinds: readonly PriceListKind[]): PriceListInput {
  if (!raw || typeof raw !== "object") fail("Chybí údaje ceníku.");
  const body = raw as Record<string, unknown>;
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!LIST_CODE_PATTERN.test(code) || code.length > 64) fail("Kód ceníku smí obsahovat jen velká písmena, číslice, - a _ (max. 64 znaků).");
  const name = optionalText(body.name, "název", 200);
  if (!name) fail("Ceník musí mít název.");
  const kind = oneOf(body.kind, allowedKinds, "druh");
  const note = optionalText(body.note, "poznámka", 2000);
  return { ...(optionalUuid(body.id, "id") ? { id: body.id as string } : {}), code, name, kind, isActive: body.isActive !== false, ...(note ? { note } : {}) };
}

export type PriceVersionHeaderInput = Readonly<{
  label?: string;
  validFrom?: string;
  validTo?: string;
  eurRate: number;
  eurRoundingMode: EurRoundingMode;
  eurRoundingStep: EurRoundingStep;
  note?: string;
}>;

export function parsePriceVersionHeaderInput(raw: unknown): PriceVersionHeaderInput {
  if (!raw || typeof raw !== "object") fail("Chybí hlavička verze.");
  const body = raw as Record<string, unknown>;
  const rate = typeof body.eurRate === "string" ? Number(body.eurRate.replace(",", ".")) : body.eurRate;
  if (typeof rate !== "number" || !Number.isFinite(rate) || rate <= 0 || rate > 1000) fail("Kurz EUR musí být kladné číslo (CZK za 1 EUR).");
  if (Math.round(rate * 10_000) / 10_000 !== rate) fail("Kurz EUR smí mít nejvýš čtyři desetinná místa.");
  const step = typeof body.eurRoundingStep === "string" ? Number(body.eurRoundingStep) : body.eurRoundingStep;
  if (!isEurRoundingStep(step)) fail("Krok zaokrouhlení EUR musí být 0,01 / 0,1 / 0,5 / 1 / 5 / 10.");
  const validFrom = optionalDate(body.validFrom, "platnost od");
  const validTo = optionalDate(body.validTo, "platnost do");
  if (validFrom && validTo && validTo < validFrom) fail("Platnost do nesmí být dříve než platnost od.");
  const label = optionalText(body.label, "označení", 120);
  const note = optionalText(body.note, "poznámka", 2000);
  return {
    ...(label ? { label } : {}),
    ...(validFrom ? { validFrom } : {}),
    ...(validTo ? { validTo } : {}),
    eurRate: rate,
    eurRoundingMode: oneOf(body.eurRoundingMode, EUR_ROUNDING_MODES, "zaokrouhlení", DEFAULT_EUR_ROUNDING_MODE),
    eurRoundingStep: step,
    ...(note ? { note } : {}),
  };
}

export type SaleEntryInput = Omit<SalePriceEntry, "id" | "versionId">;

/**
 * Checks one sale row of a DRAFT. A fixed row always has CZK; EUR_SK is derived from it or entered by
 * hand (manual, saleEur); EUR_WORLD is its own price and may still be empty in a draft — publishing
 * requires it (validateVersionForPublish). New rows never use the legacy direct / none modes.
 */
export function parseSaleEntryInput(raw: unknown, index: number): SaleEntryInput {
  if (!raw || typeof raw !== "object") fail(`Řádek ${index + 1}: chybí údaje.`);
  const body = raw as Record<string, unknown>;
  const at = `Řádek ${index + 1}`;
  const catalogItemId = uuid(body.catalogItemId, `${at} položka`);
  const variantId = optionalUuid(body.variantId, `${at} varianta`);
  const variantSeries = optionalSeries(body.variantSeries, `${at} řada`);
  if (variantId && variantSeries) fail(`${at}: řádek platí buď pro jednu variantu, nebo pro celou řadu — ne pro obojí.`);
  const priceMode = oneOf(body.priceMode, SALE_PRICE_MODES, `${at} režim ceny`, "fixed");
  const saleCzk = parsePriceAmount(body.saleCzk, `${at} cena CZK`);
  const saleEur = parsePriceAmount(body.saleEur, `${at} ruční cena EUR SK`);
  const saleEurWorld = parsePriceAmount(body.saleEurWorld, `${at} cena EUR WORLD`);
  const unitCode = optionalText(body.unitCode, `${at} jednotka`, 32);
  const note = optionalText(body.note, `${at} poznámka`, 1000);
  if (priceMode !== "fixed") {
    if (saleCzk !== undefined || saleEur !== undefined || saleEurWorld !== undefined) fail(`${at}: cena na dotaz ani zahrnutá položka nemá částku.`);
    return { catalogItemId, ...(variantId ? { variantId } : {}), ...(variantSeries ? { variantSeries } : {}), priceMode, eurMode: "none", ...(unitCode ? { unitCode } : {}), ...(note ? { note } : {}) };
  }
  const eurMode = oneOf(body.eurMode, EUR_SK_MODES, `${at} režim EUR SK`, "derived");
  if (saleCzk === undefined) fail(`${at}: chybí cena CZK.`);
  if (eurMode === "manual" && saleEur === undefined) fail(`${at}: chybí ruční cena EUR SK.`);
  return {
    catalogItemId,
    ...(variantId ? { variantId } : {}),
    ...(variantSeries ? { variantSeries } : {}),
    priceMode,
    saleCzk,
    eurMode,
    ...(eurMode === "manual" ? { saleEur } : {}),
    ...(saleEurWorld !== undefined ? { saleEurWorld } : {}),
    ...(unitCode ? { unitCode } : {}),
    ...(note ? { note } : {}),
  };
}

export type SurchargeInput = Omit<PriceSurcharge, "id" | "versionId">;

/** Surcharge amounts: CZK, EUR_SK (derived or manual) and EUR_WORLD — same rules as a sale row. */
export function parseSurchargeInput(raw: unknown, index: number): SurchargeInput {
  if (!raw || typeof raw !== "object") fail(`Doplatek ${index + 1}: chybí údaje.`);
  const body = raw as Record<string, unknown>;
  const at = `Doplatek ${index + 1}`;
  const targetKind = oneOf(body.targetKind, ["variant", "substitute"] as const, `${at} druh`);
  const amountCzk = parsePriceAmount(body.amountCzk, `${at} částka CZK`);
  const eurMode = oneOf(body.eurMode, EUR_SK_MODES, `${at} režim EUR SK`, "derived");
  const amountEur = parsePriceAmount(body.amountEur, `${at} ruční částka EUR SK`);
  const amountEurWorld = parsePriceAmount(body.amountEurWorld, `${at} částka EUR WORLD`);
  const note = optionalText(body.note, `${at} poznámka`, 1000);
  if (amountCzk === undefined) fail(`${at}: chybí částka CZK.`);
  if (eurMode === "manual" && amountEur === undefined) fail(`${at}: chybí ruční částka EUR SK.`);
  const amounts = { amountCzk, eurMode, ...(eurMode === "manual" ? { amountEur } : {}), ...(amountEurWorld !== undefined ? { amountEurWorld } : {}), ...(note ? { note } : {}) };
  if (targetKind === "variant") return { targetKind, variantId: uuid(body.variantId, `${at} varianta`), ...amounts };
  const lineKey = typeof body.lineKey === "string" ? body.lineKey.trim() : "";
  if (!LINE_KEY_PATTERN.test(lineKey)) fail(`${at}: chybí klíč řádku kompletu.`);
  const substituteVariantId = optionalUuid(body.substituteVariantId, `${at} varianta náhrady`);
  return {
    targetKind,
    kitItemId: uuid(body.kitItemId, `${at} komplet`),
    lineKey,
    substituteItemId: uuid(body.substituteItemId, `${at} náhrada`),
    ...(substituteVariantId ? { substituteVariantId } : {}),
    ...amounts,
  };
}

export type PurchaseEntryInput = Omit<PurchasePriceEntry, "id" | "versionId">;

export function parsePurchaseEntryInput(raw: unknown, index: number): PurchaseEntryInput {
  if (!raw || typeof raw !== "object") fail(`Řádek ${index + 1}: chybí údaje.`);
  const body = raw as Record<string, unknown>;
  const at = `Řádek ${index + 1}`;
  const purchaseCzk = parsePriceAmount(body.purchaseCzk, `${at} nákupní cena CZK`);
  if (purchaseCzk === undefined) fail(`${at}: chybí nákupní cena.`);
  const variantId = optionalUuid(body.variantId, `${at} varianta`);
  const unitCode = optionalText(body.unitCode, `${at} jednotka`, 32);
  const note = optionalText(body.note, `${at} poznámka`, 1000);
  return { catalogItemId: uuid(body.catalogItemId, `${at} položka`), ...(variantId ? { variantId } : {}), purchaseCzk, ...(unitCode ? { unitCode } : {}), ...(note ? { note } : {}) };
}

/** Duplicate (card, variant) rows would violate the unique index — reported up front. */
export function duplicateRowKeys<T extends Readonly<{ catalogItemId: string; variantId?: string; variantSeries?: string }>>(rows: readonly T[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const row of rows) {
    const key = `${row.catalogItemId}|${row.variantId ?? ""}|${row.variantSeries ?? ""}`;
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

export function surchargeKey(surcharge: Pick<PriceSurcharge, "targetKind" | "variantId" | "kitItemId" | "lineKey" | "substituteItemId" | "substituteVariantId">): string {
  return [surcharge.targetKind, surcharge.variantId ?? "", surcharge.kitItemId ?? "", surcharge.lineKey ?? "", surcharge.substituteItemId ?? "", surcharge.substituteVariantId ?? ""].join("|");
}

// ============================================================================
// Display helpers of the price tables (read from the catalog card; never stored in a price list)
// ============================================================================

export type CatalogCodeSource = Readonly<{ abfCode?: string | null; internalCode?: string | null }>;

/** Code shown in the first column: ABF code, else the generator code of an internal item, else none. */
export function priceItemCode(item: CatalogCodeSource | undefined): Readonly<{ code: string; kind: "abf" | "generator" }> | undefined {
  const abf = item?.abfCode?.trim();
  if (abf) return { code: abf, kind: "abf" };
  const generator = item?.internalCode?.trim();
  return generator ? { code: generator, kind: "generator" } : undefined;
}

/** Case- and diacritics-insensitive search in the code and the name. */
export function matchesPriceItemSearch(item: (CatalogCodeSource & Readonly<{ displayName: string }>) | undefined, query: string): boolean {
  const normalize = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("cs");
  const needle = normalize(query.trim());
  if (!needle) return true;
  if (!item) return false;
  return [item.abfCode, item.internalCode, item.displayName].some((value) => value && normalize(value).includes(needle));
}

/** Code order with numbers compared naturally (L2 < L10); rows without a code go last, then by name. */
export function comparePriceItemsByCode(
  a: (CatalogCodeSource & Readonly<{ displayName: string }>) | undefined,
  b: (CatalogCodeSource & Readonly<{ displayName: string }>) | undefined,
): number {
  const codeA = priceItemCode(a)?.code;
  const codeB = priceItemCode(b)?.code;
  if (codeA && !codeB) return -1;
  if (!codeA && codeB) return 1;
  const byCode = codeA && codeB ? codeA.localeCompare(codeB, "cs", { numeric: true, sensitivity: "base" }) : 0;
  return byCode || (a?.displayName ?? "").localeCompare(b?.displayName ?? "", "cs");
}
