import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server.js";
import {
  applyCatalogItemEdit,
  buildCatalogItemDuplicateDocument,
  documentCatalogPublication,
  InvalidCatalogItemAdminEditError,
  parseCatalogItemAdminEdit,
  type CatalogItemAdmin,
} from "../domain/catalogItemsAdmin.ts";
import type { CatalogPackageItem } from "../domain/catalogPackages.ts";
import type { PricingEntrySummary } from "../domain/catalogPricing.ts";
import {
  DEFAULT_CUSTOMER_CATALOG_EXPORT_OPTIONS,
  buildCustomerCatalogDocument,
  buildCustomerCatalogEntries,
  buildCustomerCatalogFileName,
  catalogCardCodeLine,
  catalogCardPriceLine,
  eventPriceListsForCurrency,
  filterCustomerCatalogEntries,
  formatCatalogPrice,
  isPublishedInCustomerCatalog,
  normalizeCustomerCatalogPresetConfig,
  orderCustomerCatalogCategories,
  parseCustomerCatalogPresetInput,
  resolveCatalogPriceList,
  sortCustomerCatalogEntries,
  InvalidCustomerCatalogPresetError,
  type CustomerCatalogExportOptions,
  type CustomerCatalogPreset,
  type CustomerCatalogPresetInput,
  type CustomerCatalogPresetRepository,
  type CustomerCatalogPriceContext,
} from "../domain/customerCatalog.ts";
import type { StoredAsset } from "../domain/assets.ts";
import type { CatalogItemKind, CatalogItemStatus, CatalogItemType } from "../domain/models.ts";
import type { PriceList } from "../domain/organizations.ts";
import {
  handleCustomerCatalogPresetsDelete,
  handleCustomerCatalogPresetsList,
  handleCustomerCatalogPresetsSave,
} from "../app/api/customer-catalog/presets/route.ts";
import { CustomerCatalogPresetsNotMigratedError } from "../lib/db/customerCatalogPresetRepository.supabase.ts";
import { createSessionToken } from "../lib/auth/session.ts";

const SECRET = "customer-catalog-test-session-secret-32";
(process.env as Record<string, string | undefined>).APP_SESSION_SECRET = SECRET;

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------

const KIND_BY_TYPE: Readonly<Record<CatalogItemType, CatalogItemKind>> = { PRODUCT: "furniture", SERVICE: "service", BOOTH: "booth", INTERNAL_COMPONENT: "booth_component" };

function photo(id: string): StoredAsset {
  return { id, storageKey: `catalog/${id}.jpg`, originalFileName: `${id}.jpg`, mimeType: "image/jpeg", size: 1000, createdAt: "2026-10-01T00:00:00.000Z", category: "catalog-photo" };
}

function item(input: Readonly<{
  id: string;
  itemType: CatalogItemType;
  name: string;
  category?: string | null;
  status?: CatalogItemStatus;
  visible?: boolean;
  abfCode?: string;
  internalCode?: string;
  unit?: string;
  document?: Record<string, unknown>;
  publication?: Record<string, unknown>;
  packageItems?: readonly CatalogPackageItem[];
}>): CatalogItemAdmin {
  return {
    id: input.id,
    internalCode: input.internalCode ?? null,
    abfCode: input.abfCode ?? null,
    itemType: input.itemType,
    kind: KIND_BY_TYPE[input.itemType],
    lifecycleStatus: input.status ?? "needs_review",
    displayName: input.name,
    officialName: null,
    category: input.category === undefined ? "Nábytek" : input.category,
    unit: input.unit ?? "ks",
    document: { ...input.document, catalogPublication: { visible: input.visible ?? true, ...input.publication } },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...(input.packageItems ? { packageItems: input.packageItems } : {}),
  };
}

const EVENT_A = { id: "event-a", name: "FOR BEAUTY 2026", venue: "PVA EXPO PRAHA", eventFrom: "2026-10-16", eventTo: "2026-10-18", priceListIds: ["pl-a-czk", "pl-a-eur"], defaultPriceListId: "pl-a-czk", realizationCompanyId: undefined };
const EVENT_B = { id: "event-b", name: "FOR ARCH 2026", venue: "", priceListIds: ["pl-b-czk"], defaultPriceListId: "pl-b-czk", realizationCompanyId: undefined };

function priceList(id: string, currency: "CZK" | "EUR", active = true): PriceList {
  return { id, name: id, code: id.toUpperCase(), currency, year: 2026, active };
}
const PRICE_LISTS = [priceList("pl-a-czk", "CZK"), priceList("pl-a-eur", "EUR"), priceList("pl-b-czk", "CZK")];

function priceEntry(catalogItemId: string, priceListId: string, eventId: string, currency: "CZK" | "EUR", salePrice: number | null, priceMode: PricingEntrySummary["priceMode"] = "fixed"): PricingEntrySummary {
  return { id: `${catalogItemId}-${priceListId}`, catalogItemId, priceListId, eventId, realizationCompanyId: null, currency, salePrice, priceMode };
}

const ALL_ENTRIES: readonly PricingEntrySummary[] = [
  priceEntry("chair", "pl-a-czk", "event-a", "CZK", 1250),
  priceEntry("chair", "pl-a-eur", "event-a", "EUR", 52),
  priceEntry("chair", "pl-b-czk", "event-b", "CZK", 990),
  priceEntry("booth-e", "pl-a-czk", "event-a", "CZK", 24900),
  priceEntry("electricity", "pl-a-czk", "event-a", "CZK", null, "individual"),
];

/** Mirrors the page: only the chosen price list's entries are loaded (readPricingEntriesForPriceList). */
function context(event: typeof EVENT_A | typeof EVENT_B | undefined, currency: "CZK" | "EUR", preferredPriceListId?: string): CustomerCatalogPriceContext {
  const resolved = resolveCatalogPriceList(event, PRICE_LISTS, currency, preferredPriceListId);
  return { event, priceList: resolved, currency, entries: ALL_ENTRIES.filter((entry) => entry.priceListId === resolved?.id) };
}

const CHAIR = item({ id: "chair", itemType: "PRODUCT", name: "Židle M57 interní", abfCode: "M57", internalCode: "INT-M57", document: { widthMm: 450, depthMm: 500, heightMm: 820, photoAsset: photo("chair") }, publication: { name: "Židle konferenční", shortDescription: "Čalouněná židle.", sortOrder: 20 } });
const TABLE = item({ id: "table", itemType: "PRODUCT", name: "Stůl", abfCode: "M10", publication: { sortOrder: 10 } });
const ELECTRICITY = item({ id: "electricity", itemType: "SERVICE", name: "Elektrická přípojka", abfCode: "L02", category: "T. služby", document: { serviceTechnical: { powerKw: 3, parameters: [{ key: "Napětí", value: "230 V" }] } } });
const PANEL = item({ id: "panel", itemType: "INTERNAL_COMPONENT", name: "INT-PANEL-950", internalCode: "INT-PANEL-950", category: "Panely / stěny" });
const POST = item({ id: "post", itemType: "INTERNAL_COMPONENT", name: "INT-SLOUPEK", category: "Sloupky", visible: false });
const CARPET = item({ id: "carpet", itemType: "PRODUCT", name: "Koberec", category: "Podlaha", visible: false });

function link(childItemId: string, quantity: number, sortOrder: number, includedInPackage = true): CatalogPackageItem {
  return { id: `link-${childItemId}`, packageItemId: "booth-e", childItemId, quantity, includedInPackage, sortOrder, note: null };
}
const BOOTH = item({
  id: "booth-e",
  itemType: "BOOTH",
  name: "Stánek E",
  abfCode: "T04",
  category: "Typovky",
  document: { widthMm: 3000, depthMm: 2000, heightMm: 2500 },
  packageItems: [link("table", 1, 0), link("chair", 2, 1), link("panel", 6, 2), link("post", 8, 3), link("carpet", 1, 4), link("electricity", 1, 5, false)],
});

const CATALOG = [CHAIR, TABLE, ELECTRICITY, PANEL, POST, CARPET, BOOTH];

function entriesFor(items: readonly CatalogItemAdmin[] = CATALOG, priceContext = context(EVENT_A, "CZK")) {
  return buildCustomerCatalogEntries(items, priceContext);
}

function documentFor(overrides: Partial<CustomerCatalogExportOptions> = {}, items: readonly CatalogItemAdmin[] = CATALOG, priceContext = context(EVENT_A, "CZK")) {
  return buildCustomerCatalogDocument({ entries: entriesFor(items, priceContext), options: { ...DEFAULT_CUSTOMER_CATALOG_EXPORT_OPTIONS, ...overrides }, currency: priceContext.currency, event: EVENT_A });
}

function cardOf(catalog: ReturnType<typeof documentFor>, id: string) {
  const card = catalog.sections.flatMap((section) => section.cards).find((candidate) => candidate.id === id);
  assert.ok(card, `card ${id} expected in the document`);
  return card;
}

// ---------------------------------------------------------------------------------------
// Publishability
// ---------------------------------------------------------------------------------------

test("PUBLISHABILITY: INTERNAL_COMPONENT is never offered, even with catalog_visible switched on", () => {
  assert.equal(isPublishedInCustomerCatalog(PANEL), false);
  assert.deepEqual(entriesFor().map((entry) => entry.id).sort(), ["booth-e", "chair", "electricity", "table"]);
});

test("PUBLISHABILITY: an archived item is not published by default", () => {
  const archived = item({ id: "old", itemType: "PRODUCT", name: "Stará židle", status: "archived" });
  assert.equal(isPublishedInCustomerCatalog(archived), false);
  assert.equal(entriesFor([archived]).length, 0);
});

test("PUBLISHABILITY: catalog_visible = false hides the item; an item without the section is not published", () => {
  assert.equal(isPublishedInCustomerCatalog(CARPET), false);
  const untouched: CatalogItemAdmin = { ...TABLE, id: "fresh", document: {} };
  assert.equal(isPublishedInCustomerCatalog(untouched), false);
  assert.equal(isPublishedInCustomerCatalog(TABLE), true);
});

test("PUBLISHABILITY: generator readiness/lifecycle other than archived does not gate the catalog", () => {
  for (const status of ["draft", "needs_review", "active", "inactive"] as const) {
    assert.equal(isPublishedInCustomerCatalog(item({ id: status, itemType: "SERVICE", name: "Úklid", status })), true, status);
  }
});

// ---------------------------------------------------------------------------------------
// Publication metadata edit (administrace komponent)
// ---------------------------------------------------------------------------------------

test("PUBLICATION EDIT: merge patch keeps untouched fields and every other part of the document", () => {
  const before = { sourceSystem: "ABF", parts: [1, 2], catalogPublication: { visible: true, name: "Židle", sortOrder: 5 } };
  const edit = parseCatalogItemAdminEdit({ catalogPublication: { shortDescription: "  Popis  ", sortOrder: null } });
  const after = applyCatalogItemEdit(before, edit);
  assert.deepEqual(documentCatalogPublication(after), { visible: true, name: "Židle", shortDescription: "Popis" });
  assert.equal(after.sourceSystem, "ABF");
  assert.deepEqual(after.parts, [1, 2]);
});

test("PUBLICATION EDIT: null resets the section; markup and bad sort order are rejected", () => {
  const after = applyCatalogItemEdit({ catalogPublication: { visible: true } }, parseCatalogItemAdminEdit({ catalogPublication: null }));
  assert.equal("catalogPublication" in after, false);
  assert.throws(() => parseCatalogItemAdminEdit({ catalogPublication: { name: "<b>Židle</b>" } }), InvalidCatalogItemAdminEditError);
  assert.throws(() => parseCatalogItemAdminEdit({ catalogPublication: { sortOrder: -1 } }), InvalidCatalogItemAdminEditError);
  assert.throws(() => parseCatalogItemAdminEdit({ catalogPublication: { sortOrder: 1.5 } }), InvalidCatalogItemAdminEditError);
});

test("PUBLICATION EDIT: an unrelated save never touches the section, and a duplicate is not published", () => {
  const document = { catalogPublication: { visible: true, name: "Židle" } };
  assert.deepEqual(applyCatalogItemEdit(document, parseCatalogItemAdminEdit({ unit: "ks" })).catalogPublication, document.catalogPublication);
  const copy = buildCatalogItemDuplicateDocument({ document, displayName: "Židle" }, "Židle (kopie)");
  assert.equal(documentCatalogPublication(copy).visible, false);
});

test("PUBLICATION: the catalog name wins over the technical name; the item's photo is the image fallback", () => {
  const entries = entriesFor();
  const chair = entries.find((entry) => entry.id === "chair")!;
  assert.equal(chair.name, "Židle konferenční");
  assert.equal(chair.imageAsset?.storageKey, "catalog/chair.jpg");
  assert.equal(entries.find((entry) => entry.id === "table")!.name, "Stůl");
  const withOwnImage = item({ id: "x", itemType: "PRODUCT", name: "X", document: { photoAsset: photo("own") }, publication: { image: photo("catalog") } });
  assert.equal(entriesFor([withOwnImage])[0]!.imageAsset?.id, "catalog");
});

// ---------------------------------------------------------------------------------------
// Prices: Event → PriceList → PricingEntry, currency of the pricing model, bez DPH
// ---------------------------------------------------------------------------------------

test("PRICES: the chosen event uses its own price list", () => {
  const forA = entriesFor(CATALOG, context(EVENT_A, "CZK")).find((entry) => entry.id === "chair")!;
  const forB = entriesFor(CATALOG, context(EVENT_B, "CZK")).find((entry) => entry.id === "chair")!;
  assert.deepEqual(forA.price, { status: "fixed", amount: 1250, currency: "CZK" });
  assert.deepEqual(forB.price, { status: "fixed", amount: 990, currency: "CZK" });
});

test("PRICES: entries of another event's price list are never used, even when present in the context", () => {
  const leaked: CustomerCatalogPriceContext = { event: EVENT_B, priceList: PRICE_LISTS[2], currency: "CZK", entries: ALL_ENTRIES.filter((entry) => entry.priceListId === "pl-a-czk") };
  assert.deepEqual(entriesFor(CATALOG, leaked).find((entry) => entry.id === "chair")!.price, { status: "missing" });
});

test("CURRENCY: EUR reads the event's EUR price list as stored — no conversion", () => {
  assert.equal(resolveCatalogPriceList(EVENT_A, PRICE_LISTS, "EUR")?.id, "pl-a-eur");
  const chair = entriesFor(CATALOG, context(EVENT_A, "EUR")).find((entry) => entry.id === "chair")!;
  assert.deepEqual(chair.price, { status: "fixed", amount: 52, currency: "EUR" });
});

test("CURRENCY: an event without a price list in the currency has no prices — never the other currency's", () => {
  assert.deepEqual(eventPriceListsForCurrency(EVENT_B, PRICE_LISTS, "EUR"), []);
  const entries = entriesFor(CATALOG, context(EVENT_B, "EUR"));
  assert.ok(entries.length > 0);
  assert.ok(entries.every((entry) => entry.price.status === "missing"));
  const mismatched: CustomerCatalogPriceContext = { event: EVENT_A, priceList: PRICE_LISTS[0], currency: "EUR", entries: ALL_ENTRIES };
  assert.ok(entriesFor(CATALOG, mismatched).every((entry) => entry.price.status === "missing"));
});

test("CURRENCY: no exchange rate is hardcoded in the catalog domain", () => {
  const source = readFileSync(new URL("../domain/customerCatalog.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /kurz|exchangeRate|rate\s*[:=]\s*\d|\*\s*2[4-6](\.\d+)?\b/iu);
});

test("CURRENCY: inactive price lists are not offered; the event default comes first", () => {
  const lists = [priceList("pl-a-eur", "EUR"), priceList("extra", "CZK"), priceList("pl-a-czk", "CZK"), priceList("off", "CZK", false)];
  const event = { priceListIds: ["extra", "off", "pl-a-czk", "pl-a-eur"], defaultPriceListId: "pl-a-czk" };
  assert.deepEqual(eventPriceListsForCurrency(event, lists, "CZK").map((entry) => entry.id), ["pl-a-czk", "extra"]);
  assert.equal(resolveCatalogPriceList(event, lists, "CZK", "extra")?.id, "extra");
  assert.equal(resolveCatalogPriceList(event, lists, "CZK", "off")?.id, "pl-a-czk");
});

test("NO PRICE: an item without a price stays in the catalog, is counted, and never becomes 0", () => {
  const catalog = documentFor();
  const table = cardOf(catalog, "table");
  assert.equal(table.priceLabel, undefined);
  assert.equal(table.priceMissing, true);
  assert.equal(catalog.missingPriceCount, 1);
  assert.doesNotMatch(JSON.stringify(catalog), /"0\s*Kč/u);
  assert.equal(documentFor({ showPrices: false }).missingPriceCount, 0);
});

test("NO PRICE: a real stored price of 0 is shown as a price", () => {
  const free = item({ id: "free", itemType: "SERVICE", name: "Registrace" });
  const priceContext: CustomerCatalogPriceContext = { event: EVENT_A, priceList: PRICE_LISTS[0], currency: "CZK", entries: [priceEntry("free", "pl-a-czk", "event-a", "CZK", 0)] };
  assert.equal(cardOf(documentFor({}, [free], priceContext), "free").priceLabel, "0 Kč bez DPH");
});

test("VAT: every numeric price is labelled bez DPH and no VAT variant exists", () => {
  assert.equal(formatCatalogPrice(1250, "CZK"), "1 250 Kč bez DPH");
  assert.equal(formatCatalogPrice(52, "EUR"), "€ 52 bez DPH");
  assert.equal(formatCatalogPrice(52.5, "EUR", "code"), "EUR 52,5 bez DPH");
  for (const currency of ["CZK", "EUR"] as const) {
    const cards = documentFor({}, CATALOG, context(EVENT_A, currency)).sections.flatMap((section) => section.cards);
    const numeric = cards.map((card) => card.priceLabel).filter((label): label is string => Boolean(label) && /\d/u.test(label!));
    assert.ok(numeric.length > 0);
    for (const label of numeric) assert.match(label, /bez DPH$/u);
  }
  const source = readFileSync(new URL("../domain/customerCatalog.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /s DPH|včetně DPH|vatRate|1\.21/iu);
});

test("PRICES: individual pricing is 'na vyžádání', not a missing price", () => {
  const catalog = documentFor();
  const electricity = cardOf(catalog, "electricity");
  assert.equal(electricity.priceLabel, "Cena na vyžádání");
  assert.equal(electricity.priceMissing, false);
});

// ---------------------------------------------------------------------------------------
// Cards per type + export options
// ---------------------------------------------------------------------------------------

test("CARDS: PRODUCT, SERVICE and BOOTH each get their own layout and data", () => {
  const catalog = documentFor();
  const chair = cardOf(catalog, "chair");
  assert.equal(chair.layout, "product");
  assert.equal(chair.hasImage, true);
  assert.equal(chair.dimensionsLabel, "450 × 500 × 820 mm");
  assert.equal(chair.description, "Čalouněná židle.");
  assert.equal(catalogCardPriceLine(chair), "1 250 Kč bez DPH / ks");
  assert.deepEqual(chair.contents, []);

  const electricity = cardOf(catalog, "electricity");
  assert.equal(electricity.layout, "service");
  assert.equal(electricity.hasImage, false);
  assert.deepEqual(electricity.parameters, [{ key: "Výkon", value: "3 kW" }, { key: "Napětí", value: "230 V" }]);

  const booth = cardOf(catalog, "booth-e");
  assert.equal(booth.layout, "booth");
  assert.equal(booth.dimensionsLabel, "3 × 2 m");
  assert.equal(booth.priceLabel, "24 900 Kč bez DPH");
});

test("BOOTH: package contents list customer items only — no internal construction components, no optional extras", () => {
  const booth = cardOf(documentFor(), "booth-e");
  assert.deepEqual(booth.contents, ["Stůl", "2× Židle konferenční", "Koberec"]);
  assert.doesNotMatch(booth.contents.join(" "), /INT-|PANEL|SLOUPEK/u);
  assert.deepEqual(cardOf(documentFor({ showPackageContents: false }), "booth-e").contents, []);
});

test("IMAGES: an item without an image still produces a complete card", () => {
  const table = cardOf(documentFor(), "table");
  assert.equal(table.hasImage, false);
  assert.equal(table.name, "Stůl");
  const entry = entriesFor().find((candidate) => candidate.id === "table")!;
  assert.equal(entry.imageAsset, undefined);
  assert.equal(entry.imageUrl, undefined);
});

test("OPTIONS: ABF code can be hidden; internal code is off by default and separately switchable", () => {
  assert.equal(catalogCardCodeLine(cardOf(documentFor(), "chair")), "ABF M57");
  assert.equal(DEFAULT_CUSTOMER_CATALOG_EXPORT_OPTIONS.showInternalCode, false);
  const hidden = cardOf(documentFor({ showAbfCode: false }), "chair");
  assert.equal(hidden.abfCode, undefined);
  assert.equal(catalogCardCodeLine(hidden), undefined);
  assert.equal(catalogCardCodeLine(cardOf(documentFor({ showInternalCode: true }), "chair")), "ABF M57 · INT-M57");
  assert.doesNotMatch(JSON.stringify(documentFor()), /INT-M57/u);
});

test("OPTIONS: prices can be hidden completely", () => {
  const catalog = documentFor({ showPrices: false });
  assert.equal(catalog.showPrices, false);
  for (const card of catalog.sections.flatMap((section) => section.cards)) {
    assert.equal(card.priceLabel, undefined);
    assert.equal(card.priceMissing, false);
  }
  assert.doesNotMatch(JSON.stringify(catalog), /Kč|DPH|1250|24900/u);
  assert.equal(catalogCardPriceLine(cardOf(catalog, "chair")), "Jednotka: ks");
});

test("OPTIONS: description, dimensions, unit and technical parameters each switch off independently", () => {
  const catalog = documentFor({ showDescription: false, showDimensions: false, showUnit: false, showTechnicalParameters: false });
  const chair = cardOf(catalog, "chair");
  assert.equal(chair.description, undefined);
  assert.equal(chair.dimensionsLabel, undefined);
  assert.equal(chair.unit, undefined);
  assert.equal(catalogCardPriceLine(chair), "1 250 Kč bez DPH");
  assert.deepEqual(cardOf(catalog, "electricity").parameters, []);
});

// ---------------------------------------------------------------------------------------
// Order, filters, file name
// ---------------------------------------------------------------------------------------

test("ORDER: fallback is category label then name; catalog_sort_order wins inside a category", () => {
  const sorted = sortCustomerCatalogEntries(entriesFor());
  assert.deepEqual(sorted.map((entry) => entry.id), ["table", "chair", "electricity", "booth-e"]);
  assert.deepEqual(documentFor().sections.map((section) => section.title), ["Nábytek", "Technické služby", "Typovky"]);
  const unordered = [item({ id: "b", itemType: "PRODUCT", name: "Beta" }), item({ id: "a", itemType: "PRODUCT", name: "Alfa" }), item({ id: "z", itemType: "PRODUCT", name: "Zeta", publication: { sortOrder: 1 } })];
  assert.deepEqual(sortCustomerCatalogEntries(entriesFor(unordered)).map((entry) => entry.id), ["z", "a", "b"]);
  assert.deepEqual(sortCustomerCatalogEntries(entriesFor([...unordered].reverse())).map((entry) => entry.id), ["z", "a", "b"]);
});

test("ORDER: an explicit category order is respected; unlisted categories follow alphabetically", () => {
  const entries = entriesFor();
  assert.deepEqual(orderCustomerCatalogCategories(entries, ["Typovky"]).map((category) => category.key), ["Typovky", "Nábytek", "T. služby"]);
  const catalog = buildCustomerCatalogDocument({ entries, options: DEFAULT_CUSTOMER_CATALOG_EXPORT_OPTIONS, currency: "CZK", categoryOrder: ["Typovky", "T. služby"] });
  assert.deepEqual(catalog.sections.map((section) => section.categoryKey), ["Typovky", "T. služby", "Nábytek"]);
});

test("FILTERS: by type, by category and by name / ABF code (diacritics-insensitive)", () => {
  const entries = entriesFor();
  assert.deepEqual(filterCustomerCatalogEntries(entries, { itemType: "SERVICE" }).map((entry) => entry.id), ["electricity"]);
  assert.deepEqual(filterCustomerCatalogEntries(entries, { itemType: "BOOTH" }).map((entry) => entry.id), ["booth-e"]);
  assert.deepEqual(filterCustomerCatalogEntries(entries, { category: "Nábytek" }).map((entry) => entry.id).sort(), ["chair", "table"]);
  assert.deepEqual(filterCustomerCatalogEntries(entries, { query: "zidle" }).map((entry) => entry.id), ["chair"]);
  assert.deepEqual(filterCustomerCatalogEntries(entries, { query: "l02" }).map((entry) => entry.id), ["electricity"]);
  assert.equal(filterCustomerCatalogEntries(entries, {}).length, entries.length);
});

test("DOCUMENT: carries the event for the cover and the default title", () => {
  const catalog = documentFor();
  assert.equal(catalog.title, "Katalog vybavení a služeb");
  assert.equal(catalog.eventName, "FOR BEAUTY 2026");
  assert.equal(catalog.eventVenue, "PVA EXPO PRAHA");
  assert.match(catalog.eventDateRange ?? "", /^\d+\.\s*10\.\s*2026\s–\s\d+\.\s*10\.\s*2026$/u);
  assert.equal(catalog.itemCount, 4);
});

test("FILE NAME: readable and filesystem-safe", () => {
  assert.equal(buildCustomerCatalogFileName({ eventName: "FOR BEAUTY 2026", currency: "CZK" }), "Katalog_FOR_BEAUTY_2026_CZK.pdf");
  assert.equal(buildCustomerCatalogFileName({ eventName: "FOR BEAUTY 2026", currency: "EUR" }), "Katalog_FOR_BEAUTY_2026_EUR.pdf");
  assert.equal(buildCustomerCatalogFileName({ eventName: " Veletrh: Dřevo/Stavby & „Design“ 2026 ", currency: "CZK" }), "Katalog_Veletrh_DrevoStavby_Design_2026_CZK.pdf");
  assert.equal(buildCustomerCatalogFileName({ currency: "CZK" }), "Katalog_CZK.pdf");
});

// ---------------------------------------------------------------------------------------
// Saved configurations
// ---------------------------------------------------------------------------------------

test("PRESET: config is normalized defensively", () => {
  const config = normalizeCustomerCatalogPresetConfig({ eventId: "event-a", currency: "USD", itemType: "INTERNAL_COMPONENT", selectedItemIds: ["a", "a", 5, "b"], options: { showPrices: false, showInternalCode: "yes" }, categoryOrder: ["Typovky"], junk: 1 });
  assert.deepEqual(config, {
    eventId: "event-a",
    currency: "CZK",
    itemType: "",
    selectedItemIds: ["a", "b"],
    options: { ...DEFAULT_CUSTOMER_CATALOG_EXPORT_OPTIONS, showPrices: false },
    categoryOrder: ["Typovky"],
  });
  assert.throws(() => parseCustomerCatalogPresetInput({ name: "  ", config: {} }), InvalidCustomerCatalogPresetError);
  assert.equal(parseCustomerCatalogPresetInput({ name: " FOR BEAUTY 2026 – kompletní katalog ", config: {} }).name, "FOR BEAUTY 2026 – kompletní katalog");
});

function fakePresetRepository(overrides: Partial<CustomerCatalogPresetRepository> = {}): CustomerCatalogPresetRepository {
  const stored: CustomerCatalogPreset = { id: "p1", name: "Uložený", config: normalizeCustomerCatalogPresetConfig({}), createdAt: "t", updatedAt: "t" };
  return {
    list: async () => [stored],
    save: async (input: CustomerCatalogPresetInput) => ({ ...stored, id: input.id ?? "new", name: input.name, config: input.config }),
    delete: async () => undefined,
    ...overrides,
  };
}

function request(token: string | undefined, url: string, init: Readonly<{ method?: string; body?: unknown }> = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `homeworkstudio_session=${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest(url, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}

const PRESETS_URL = "http://localhost/api/customer-catalog/presets";

test("PRESET API: every method requires a session", async () => {
  const repository = () => fakePresetRepository();
  assert.equal((await handleCustomerCatalogPresetsList(request(undefined, PRESETS_URL), repository)).status, 401);
  assert.equal((await handleCustomerCatalogPresetsSave(request(undefined, PRESETS_URL, { method: "POST", body: { name: "X", config: {} } }), repository)).status, 401);
  assert.equal((await handleCustomerCatalogPresetsDelete(request(undefined, `${PRESETS_URL}?id=p1`, { method: "DELETE" }), repository)).status, 401);
});

test("PRESET API: list, save (validated) and delete", async () => {
  const token = await createSessionToken(SECRET);
  const repository = () => fakePresetRepository();
  const listed = (await (await handleCustomerCatalogPresetsList(request(token, PRESETS_URL), repository)).json()) as { presets: CustomerCatalogPreset[] };
  assert.equal(listed.presets.length, 1);

  const saved = await handleCustomerCatalogPresetsSave(request(token, PRESETS_URL, { method: "POST", body: { name: "FOR BEAUTY 2026 – kompletní katalog", config: { currency: "EUR", selectedItemIds: ["chair"] } } }), repository);
  assert.equal(saved.status, 200);
  const body = (await saved.json()) as { preset: CustomerCatalogPreset };
  assert.equal(body.preset.config.currency, "EUR");
  assert.deepEqual(body.preset.config.selectedItemIds, ["chair"]);

  assert.equal((await handleCustomerCatalogPresetsSave(request(token, PRESETS_URL, { method: "POST", body: { name: "", config: {} } }), repository)).status, 400);
  assert.equal((await handleCustomerCatalogPresetsDelete(request(token, PRESETS_URL, { method: "DELETE" }), repository)).status, 400);
  assert.equal((await handleCustomerCatalogPresetsDelete(request(token, `${PRESETS_URL}?id=p1`, { method: "DELETE" }), repository)).status, 200);
});

test("PRESET API: a database without the presets migration answers 409 with a clear message", async () => {
  const token = await createSessionToken(SECRET);
  const repository = () => fakePresetRepository({ save: async () => { throw new CustomerCatalogPresetsNotMigratedError(); } });
  const response = await handleCustomerCatalogPresetsSave(request(token, PRESETS_URL, { method: "POST", body: { name: "X", config: {} } }), repository);
  assert.equal(response.status, 409);
  assert.match(((await response.json()) as { error: string }).error, /20261005120000_customer_catalog_presets\.sql/u);
});

// ---------------------------------------------------------------------------------------
// Wiring: separate menu item, existing admin untouched
// ---------------------------------------------------------------------------------------

test("NAVIGATION: 'Katalog' is its own menu item next to 'Katalog komponent'", () => {
  const sidebar = readFileSync(new URL("../components/AppSidebar.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /<span className="navLabel">Katalog<\/span>/u);
  assert.match(sidebar, /<span className="navLabel">Katalog komponent<\/span>/u);
  const generator = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  assert.match(generator, /workspaceSection === "customerCatalog"[\s\S]{0,120}<CustomerCatalogPage/u);
  assert.match(generator, /workspaceSection === "components"[\s\S]{0,120}<ComponentAdminPage/u);
});

test("ISOLATION: the catalog page only reads catalog items — it has no write path to them or to prices", () => {
  const page = readFileSync(new URL("../components/workflow/CustomerCatalogPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(page, /catalogRepository\s*\.\s*(save|create|duplicate|bulkLifecycle|savePackage)/u);
  assert.doesNotMatch(page, /pricing-admin|saveEntries|RemoteApiPricingAdminRepository/u);
});
