import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { handleCatalogItemsList } from "../app/api/catalog/items/route.ts";
import { handlePricingEntriesList } from "../app/api/pricing/entries/route.ts";
import { readCatalogItems, readPricingEntriesForPriceList } from "../lib/db/catalogPricing.supabase.ts";
import {
  buildTechnicalCatalogItems,
  computeGeneratorEligible,
  findCatalogItemByInternalCode,
  type CatalogItemSummary,
  type PricingEntrySummary,
} from "../domain/catalogPricing.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import { SupabaseConfigurationError } from "../lib/db/supabase.server.ts";
import { selectPricingEntry, derivePricingAvailability } from "../domain/catalog.ts";
import { resolveEventPriceListForCurrency, normalizeExhibition } from "../domain/organizations.ts";
import type { PriceList } from "../domain/organizations.ts";
import { priceElectricity, ELECTRICITY_POWER_INTERNAL_CODES, CLEANING_INTERNAL_CODES } from "../domain/technicalServices.ts";
import { createDefaultTechnicalRequirements } from "../domain/project.ts";
import { createCustomerCalculationViewModel } from "../domain/calculationExport.ts";
import { readFileSync } from "node:fs";

const SECRET = "catalog-pricing-test-session-secret-32c";
const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.APP_SESSION_SECRET = SECRET;

function authenticatedRequest(token: string | undefined, url: string) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `homeworkstudio_session=${token}`;
  return new NextRequest(url, { method: "GET", headers });
}

// ---------------------------------------------------------------------------------------
// Minimal fake Supabase query builder — supports exactly the "select" / "select().eq()"
// chain that readCatalogItems/readPricingEntriesForPriceList use. Never touches real Supabase.
// ---------------------------------------------------------------------------------------
type FakeRow = Record<string, unknown>;

function fakeSupabaseClient(tables: Readonly<Record<string, readonly FakeRow[]>>) {
  return {
    from(tableName: string) {
      const rows = [...(tables[tableName] ?? [])];
      let filters: Array<[string, unknown]> = [];
      const builder = {
        select(_columns?: string) {
          return builder;
        },
        eq(column: string, value: unknown) {
          filters = [...filters, [column, value]];
          return builder;
        },
        then(onFulfilled: (value: { data: unknown; error: unknown }) => unknown, onRejected?: (reason: unknown) => unknown) {
          const matched = rows.filter((row) => filters.every(([column, value]) => row[column] === value));
          return Promise.resolve({ data: matched, error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
}

const BEAUTY_CZK_LIST_ID = "eddb21ec-de90-4867-98f8-4ec9ec32ba50";
const BEAUTY_EUR_LIST_ID = "12096bc6-79df-4319-8266-94bd9a24d073";
const L02_ID = "8381d599-31ee-4aab-bfdf-451a3933846a";

const l02Row: FakeRow = {
  id: L02_ID,
  internal_code: "L02",
  kind: "service",
  lifecycle_status: "active",
  display_name: "Elektrická energie – příkon do 2 kW / 230 V",
  category: "T. služby",
  unit: "ks",
  document: { id: L02_ID, name: "L02", type: "service", widthMm: 0, depthMm: 0 },
};

const needsReviewRow: FakeRow = {
  id: "needs-review-item-1",
  internal_code: "L97",
  kind: "service",
  lifecycle_status: "needs_review",
  display_name: "Přípojka el. energie - non-stop příplatek",
  category: "T. služby",
  unit: "ks",
  document: { id: "needs-review-item-1", name: "L97", type: "service", widthMm: 0, depthMm: 0, sourceKey: "abf-raw-987", sourceSystem: "abf-warehouse-import" },
};

// -----------------------------------------------------------------------------------------
// Section 12: API security
// -----------------------------------------------------------------------------------------

test("neautentizovaný požadavek na /api/catalog/items je odmítnut s 401", async () => {
  const response = await handleCatalogItemsList(authenticatedRequest(undefined, "http://localhost/api/catalog/items"), () => Promise.resolve([]));
  assert.equal(response.status, 401);
});

test("neautentizovaný požadavek na /api/pricing/entries je odmítnut s 401", async () => {
  const response = await handlePricingEntriesList(authenticatedRequest(undefined, `http://localhost/api/pricing/entries?priceListId=${BEAUTY_CZK_LIST_ID}`), () => Promise.resolve([]));
  assert.equal(response.status, 401);
});

test("/api/pricing/entries bez parametru priceListId vrátí 400", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handlePricingEntriesList(authenticatedRequest(token, "http://localhost/api/pricing/entries"), () => Promise.resolve([]));
  assert.equal(response.status, 400);
});

test("/api/catalog/items vrátí 503, pokud Supabase není nakonfigurováno", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogItemsList(authenticatedRequest(token, "http://localhost/api/catalog/items"), () => Promise.reject(new SupabaseConfigurationError(["SUPABASE_URL", "SUPABASE_SECRET_KEY"])));
  assert.equal(response.status, 503);
});

test("/api/catalog/items vrátí 502 při obecné chybě DB", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogItemsList(authenticatedRequest(token, "http://localhost/api/catalog/items"), () => Promise.reject(new Error("connection reset")));
  assert.equal(response.status, 502);
});

test("/api/pricing/entries vrátí 502 při obecné chybě DB", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handlePricingEntriesList(authenticatedRequest(token, `http://localhost/api/pricing/entries?priceListId=${BEAUTY_CZK_LIST_ID}`), () => Promise.reject(new Error("connection reset")));
  assert.equal(response.status, 502);
});

test("autentizovaný /api/catalog/items nikdy nevrátí SUPABASE_SECRET_KEY ani jinou serverovou konfiguraci", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogItemsList(authenticatedRequest(token, "http://localhost/api/catalog/items"), () => readCatalogItems(fakeSupabaseClient({ catalog_items: [l02Row] }) as never));
  assert.equal(response.status, 200);
  const raw = await response.text();
  assert.doesNotMatch(raw, /SUPABASE_SECRET_KEY|service_role/iu);
});

// -----------------------------------------------------------------------------------------
// Catalog / pricing DB round-trip (fake Supabase client, section 13)
// -----------------------------------------------------------------------------------------

test("readCatalogItems: DB round-trip mapuje řádek na CatalogItemSummary a nikdy nevrací document/sourceKey/sourceSystem", async () => {
  const client = fakeSupabaseClient({ catalog_items: [l02Row, needsReviewRow] });
  const items = await readCatalogItems(client as never);
  assert.equal(items.length, 2);
  const l02 = items.find((item) => item.internalCode === "L02");
  assert.equal(l02?.displayName, "Elektrická energie – příkon do 2 kW / 230 V");
  assert.equal(l02?.lifecycleStatus, "active");
  const serialized = JSON.stringify(items);
  assert.doesNotMatch(serialized, /sourceKey|sourceSystem|abf-raw-987|abf-warehouse-import/iu);
  assert.equal("document" in (items[0] as object), false);
});

test("readCatalogItems: needs_review položka má generatorEligible=false (DB existence != generator eligibility)", async () => {
  const client = fakeSupabaseClient({ catalog_items: [needsReviewRow] });
  const items = await readCatalogItems(client as never);
  assert.equal(items[0]?.generatorEligible, false);
});

test("computeGeneratorEligible: needs_review nikdy nevrátí true, bez ohledu na dokument", () => {
  const eligible = computeGeneratorEligible({ id: "x", name: "X", type: "service", category: "", widthMm: 0, depthMm: 0 } as never, "needs_review", "service");
  assert.equal(eligible, false);
});

test("readPricingEntriesForPriceList: DB round-trip je vždy omezený na JEDEN priceListId (žádné cross-list čtení)", async () => {
  const otherListRow: FakeRow = { id: "entry-other", catalog_item_id: L02_ID, price_list_id: "other-list", event_id: "arch", currency: "CZK", sale_price: 5500, price_mode: "fixed" };
  const beautyCzkRow: FakeRow = { id: "entry-beauty-czk", catalog_item_id: L02_ID, price_list_id: BEAUTY_CZK_LIST_ID, event_id: "beauty", currency: "CZK", sale_price: 5100, price_mode: "fixed" };
  const client = fakeSupabaseClient({ pricing_entries: [otherListRow, beautyCzkRow] });
  const entries = await readPricingEntriesForPriceList(client as never, BEAUTY_CZK_LIST_ID);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.id, "entry-beauty-czk");
  assert.equal(entries[0]?.salePrice, 5100);
});

// -----------------------------------------------------------------------------------------
// Section 5/11: BEAUTY + L02 flagship end-to-end resolution, modeled on the real remote
// Supabase values confirmed via a read-only sanity check (Beauty CZK L02 = 5100 CZK exactly
// 1 entry, Beauty EUR L02 = 231 EUR exactly 1 entry — see final report).
// -----------------------------------------------------------------------------------------

const beautyEvent = normalizeExhibition({ id: "beauty", name: "For Beauty", year: 2026, priceListIds: [BEAUTY_CZK_LIST_ID, BEAUTY_EUR_LIST_ID] });
const beautyCzkList: PriceList = { id: BEAUTY_CZK_LIST_ID, name: "For Beauty 2026 — CZK", code: "BEAUTY-2026-CZK", currency: "CZK", year: 2026, active: true };
const beautyEurList: PriceList = { id: BEAUTY_EUR_LIST_ID, name: "For Beauty 2026 — EUR", code: "BEAUTY-2026-EUR", currency: "EUR", year: 2026, active: true };
const beautyPriceLists = [beautyCzkList, beautyEurList];

const l02Summary: CatalogItemSummary = { id: L02_ID, internalCode: "L02", kind: "service", lifecycleStatus: "active", displayName: "Elektrická energie – příkon do 2 kW / 230 V", category: "T. služby", unit: "ks", generatorEligible: false };
const l02Entries: readonly PricingEntrySummary[] = [
  { id: "entry-czk", catalogItemId: L02_ID, priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", currency: "CZK", salePrice: 5100, priceMode: "fixed" },
  { id: "entry-eur", catalogItemId: L02_ID, priceListId: BEAUTY_EUR_LIST_ID, eventId: "beauty", currency: "EUR", salePrice: 231, priceMode: "fixed" },
];

test("Beauty CZK najde CZK PriceList podle event+currency (nikdy ne defaultPriceListId napevno)", () => {
  const resolved = resolveEventPriceListForCurrency(beautyEvent, beautyPriceLists, "CZK");
  assert.equal(resolved?.id, BEAUTY_CZK_LIST_ID);
  assert.equal(resolved?.currency, "CZK");
});

test("Beauty EUR najde EUR PriceList podle event+currency", () => {
  const resolved = resolveEventPriceListForCurrency(beautyEvent, beautyPriceLists, "EUR");
  assert.equal(resolved?.id, BEAUTY_EUR_LIST_ID);
  assert.equal(resolved?.currency, "EUR");
});

test("Beauty CZK + L02 resolvuje skutečnou CZK cenu (5100 CZK) přes buildTechnicalCatalogItems + selectPricingEntry", () => {
  const [technicalItem] = buildTechnicalCatalogItems([l02Summary], l02Entries);
  const priceList = resolveEventPriceListForCurrency(beautyEvent, beautyPriceLists, "CZK");
  const entry = selectPricingEntry(technicalItem!.pricingEntries ?? [], { priceListId: priceList?.id, exhibitionId: "beauty", currency: "CZK" });
  assert.equal(entry?.salePrice, 5100);
  assert.equal(derivePricingAvailability(entry), "fixed");
});

test("Beauty EUR + L02 resolvuje skutečnou EUR cenu (231 EUR) přes buildTechnicalCatalogItems + selectPricingEntry", () => {
  const [technicalItem] = buildTechnicalCatalogItems([l02Summary], l02Entries);
  const priceList = resolveEventPriceListForCurrency(beautyEvent, beautyPriceLists, "EUR");
  const entry = selectPricingEntry(technicalItem!.pricingEntries ?? [], { priceListId: priceList?.id, exhibitionId: "beauty", currency: "EUR" });
  assert.equal(entry?.salePrice, 231);
  assert.equal(derivePricingAvailability(entry), "fixed");
});

test("přepnutí měny CZK -> EUR skutečně změní resolvovanou cenu (žádná zamrzlá hodnota)", () => {
  const [technicalItem] = buildTechnicalCatalogItems([l02Summary], l02Entries);
  const czkPriceList = resolveEventPriceListForCurrency(beautyEvent, beautyPriceLists, "CZK");
  const eurPriceList = resolveEventPriceListForCurrency(beautyEvent, beautyPriceLists, "EUR");
  const czkEntry = selectPricingEntry(technicalItem!.pricingEntries ?? [], { priceListId: czkPriceList?.id, exhibitionId: "beauty", currency: "CZK" });
  const eurEntry = selectPricingEntry(technicalItem!.pricingEntries ?? [], { priceListId: eurPriceList?.id, exhibitionId: "beauty", currency: "EUR" });
  assert.notEqual(czkEntry?.salePrice, eurEntry?.salePrice);
  assert.equal(czkEntry?.salePrice, 5100);
  assert.equal(eurEntry?.salePrice, 231);
});

test("chybějící EUR cena NIKDY nepoužije CZK cenu jako náhradu (žádný cross-currency fallback)", () => {
  const czkOnlyEntries: readonly PricingEntrySummary[] = [{ id: "entry-czk-only", catalogItemId: L02_ID, priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", currency: "CZK", salePrice: 5100, priceMode: "fixed" }];
  const [technicalItem] = buildTechnicalCatalogItems([l02Summary], czkOnlyEntries);
  const eurPriceList = resolveEventPriceListForCurrency(beautyEvent, beautyPriceLists, "EUR");
  const entry = selectPricingEntry(technicalItem!.pricingEntries ?? [], { priceListId: eurPriceList?.id, exhibitionId: "beauty", currency: "EUR" });
  assert.equal(entry, undefined);
  assert.equal(derivePricingAvailability(entry), "missing");
});

test("chybějící CZK cena NIKDY nepoužije EUR cenu jako náhradu", () => {
  const eurOnlyEntries: readonly PricingEntrySummary[] = [{ id: "entry-eur-only", catalogItemId: L02_ID, priceListId: BEAUTY_EUR_LIST_ID, eventId: "beauty", currency: "EUR", salePrice: 231, priceMode: "fixed" }];
  const [technicalItem] = buildTechnicalCatalogItems([l02Summary], eurOnlyEntries);
  const czkPriceList = resolveEventPriceListForCurrency(beautyEvent, beautyPriceLists, "CZK");
  const entry = selectPricingEntry(technicalItem!.pricingEntries ?? [], { priceListId: czkPriceList?.id, exhibitionId: "beauty", currency: "CZK" });
  assert.equal(entry, undefined);
  assert.equal(derivePricingAvailability(entry), "missing");
});

test("chybějící cena se nikdy nezobrazí jako 0 — vždy 'missing', nikdy fabrikovaná nula", () => {
  const [technicalItem] = buildTechnicalCatalogItems([l02Summary], []);
  const entry = selectPricingEntry(technicalItem!.pricingEntries ?? [], { priceListId: BEAUTY_CZK_LIST_ID, exhibitionId: "beauty", currency: "CZK" });
  assert.equal(entry, undefined);
  assert.notEqual(derivePricingAvailability(entry), "fixed");
  assert.equal(derivePricingAvailability(entry), "missing");
});

test("žádná měnová konverze: CZK a EUR ceny jsou nezávislé DB hodnoty, nikdy přepočtené kurzem", () => {
  // 5100 CZK vs 231 EUR — no arithmetic relationship (a converted value would track a real
  // exchange rate); both are independently-stored fixed sale_price rows from Batch #2A.
  const [technicalItem] = buildTechnicalCatalogItems([l02Summary], l02Entries);
  const czkEntry = selectPricingEntry(technicalItem!.pricingEntries ?? [], { priceListId: BEAUTY_CZK_LIST_ID, exhibitionId: "beauty", currency: "CZK" });
  const eurEntry = selectPricingEntry(technicalItem!.pricingEntries ?? [], { priceListId: BEAUTY_EUR_LIST_ID, exhibitionId: "beauty", currency: "EUR" });
  assert.equal(czkEntry?.salePrice, 5100);
  assert.equal(eurEntry?.salePrice, 231);
  assert.equal(czkEntry?.salePrice! / eurEntry?.salePrice!, 5100 / 231);
});

test("findCatalogItemByInternalCode: L02 se hledá podle internalCode, nikdy podle displayName", () => {
  const found = findCatalogItemByInternalCode([l02Summary], "L02");
  assert.equal(found?.id, L02_ID);
  assert.equal(findCatalogItemByInternalCode([l02Summary], undefined), undefined);
  assert.equal(findCatalogItemByInternalCode([l02Summary], "L99"), undefined);
});

// -----------------------------------------------------------------------------------------
// Section 6/7 (2kW follow-up): 2kW now has its own Elektro dropdown option, using the same
// canonical L02 mapping already proven end-to-end. 3/5/9 kW must keep working unchanged.
// -----------------------------------------------------------------------------------------

test("priceElectricity: 2kw/3kw/5kw/9kw jsou napojené na reálné DB internalCode (L02/L03/L05/L09)", () => {
  assert.equal(ELECTRICITY_POWER_INTERNAL_CODES["2kw"], "L02");
  assert.equal(ELECTRICITY_POWER_INTERNAL_CODES["3kw"], "L03");
  assert.equal(ELECTRICITY_POWER_INTERNAL_CODES["5kw"], "L05");
  assert.equal(ELECTRICITY_POWER_INTERNAL_CODES["9kw"], "L09");
});

test("2 kW existuje jako volba v Elektro dropdownu (TechnicalRequirementsEditor)", () => {
  const source = readFileSync(new URL("../components/workflow/TechnicalRequirementsEditor.tsx", import.meta.url), "utf8");
  assert.match(source, /<option value="2kw">2 kW<\/option>/u);
});

test("výchozí technické požadavky mají powerOption stále '' — přidání 2kW neměnilo default", () => {
  assert.equal(createDefaultTechnicalRequirements().electricity.powerOption, "");
});

test("priceElectricity: 'custom' výkon nikdy nemá bezpečnou katalogovou identitu, zůstává needs-quote", () => {
  const requirements = { ...createDefaultTechnicalRequirements(), electricity: { status: "ordered" as const, note: "", powerOption: "custom" as const, customPower: "12kW" } };
  const result = priceElectricity(requirements, [], { currency: "CZK" });
  assert.equal(result?.status, "needs-quote");
});

test("priceElectricity: Beauty CZK + 2kw resolvuje skutečnou DB cenu L02 = 5100 CZK", () => {
  const requirements = { ...createDefaultTechnicalRequirements(), electricity: { status: "ordered" as const, note: "", powerOption: "2kw" as const, customPower: "" } };
  const technicalItems = buildTechnicalCatalogItems([l02Summary], l02Entries);
  const result = priceElectricity(requirements, technicalItems, { priceListId: BEAUTY_CZK_LIST_ID, exhibitionId: "beauty", currency: "CZK" });
  assert.equal(result?.status, "priced");
  assert.equal(result?.unitPriceNet, 5100);
  assert.equal(result?.totalNet, 5100);
});

test("priceElectricity: Beauty EUR + 2kw resolvuje skutečnou DB cenu L02 = 231 EUR", () => {
  const requirements = { ...createDefaultTechnicalRequirements(), electricity: { status: "ordered" as const, note: "", powerOption: "2kw" as const, customPower: "" } };
  const technicalItems = buildTechnicalCatalogItems([l02Summary], l02Entries);
  const result = priceElectricity(requirements, technicalItems, { priceListId: BEAUTY_EUR_LIST_ID, exhibitionId: "beauty", currency: "EUR" });
  assert.equal(result?.status, "priced");
  assert.equal(result?.unitPriceNet, 231);
  assert.equal(result?.totalNet, 231);
});

test("priceElectricity: přepnutí měny u 2kw skutečně vrátí jinou skutečnou PricingEntry (CZK 5100 vs EUR 231)", () => {
  const requirements = { ...createDefaultTechnicalRequirements(), electricity: { status: "ordered" as const, note: "", powerOption: "2kw" as const, customPower: "" } };
  const technicalItems = buildTechnicalCatalogItems([l02Summary], l02Entries);
  const czkResult = priceElectricity(requirements, technicalItems, { priceListId: BEAUTY_CZK_LIST_ID, exhibitionId: "beauty", currency: "CZK" });
  const eurResult = priceElectricity({ ...requirements }, technicalItems, { priceListId: BEAUTY_EUR_LIST_ID, exhibitionId: "beauty", currency: "EUR" });
  assert.equal(czkResult?.unitPriceNet, 5100);
  assert.equal(eurResult?.unitPriceNet, 231);
  assert.notEqual(czkResult?.unitPriceNet, eurResult?.unitPriceNet);
});

test("priceElectricity: 2kw pro event/měnu bez PricingEntry je needs-quote, nikdy 0 a nikdy fallback na jinou měnu", () => {
  const requirements = { ...createDefaultTechnicalRequirements(), electricity: { status: "ordered" as const, note: "", powerOption: "2kw" as const, customPower: "" } };
  const czkOnlyEntries: readonly PricingEntrySummary[] = [{ id: "entry-czk-only", catalogItemId: L02_ID, priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", currency: "CZK", salePrice: 5100, priceMode: "fixed" }];
  const technicalItems = buildTechnicalCatalogItems([l02Summary], czkOnlyEntries);
  const result = priceElectricity(requirements, technicalItems, { priceListId: BEAUTY_EUR_LIST_ID, exhibitionId: "beauty", currency: "EUR" });
  assert.equal(result?.status, "needs-quote");
  assert.notEqual(result?.unitPriceNet, 0);
  assert.equal(result?.unitPriceNet, undefined);
});

test("priceElectricity: 3kw stále resolvuje L03 se skutečnou cenou (nerozbité stávající zapojení)", () => {
  const l03: CatalogItemSummary = { id: "l03-id", internalCode: "L03", kind: "service", lifecycleStatus: "needs_review", displayName: "Přípojka el. energie - 3kW", category: "T. služby", unit: "ks", generatorEligible: false };
  const l03Entries: readonly PricingEntrySummary[] = [{ id: "entry-l03-czk", catalogItemId: "l03-id", priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", currency: "CZK", salePrice: 5900, priceMode: "fixed" }];
  const technicalItems = buildTechnicalCatalogItems([l03], l03Entries);
  const requirements = { ...createDefaultTechnicalRequirements(), electricity: { status: "ordered" as const, note: "", powerOption: "3kw" as const, customPower: "" } };
  const result = priceElectricity(requirements, technicalItems, { priceListId: BEAUTY_CZK_LIST_ID, exhibitionId: "beauty", currency: "CZK" });
  assert.equal(result?.status, "priced");
  assert.equal(result?.unitPriceNet, 5900);
});

test("priceElectricity: 5kw s reálnou DB cenou vrátí status priced a skutečnou cenu", () => {
  const l05: CatalogItemSummary = { id: "l05-id", internalCode: "L05", kind: "service", lifecycleStatus: "active", displayName: "Elektro 5kW", category: "T. služby", unit: "ks", generatorEligible: false };
  const l05Entries: readonly PricingEntrySummary[] = [{ id: "entry-l05-czk", catalogItemId: "l05-id", priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", currency: "CZK", salePrice: 6900, priceMode: "fixed" }];
  const technicalItems = buildTechnicalCatalogItems([l05], l05Entries);
  const requirements = { ...createDefaultTechnicalRequirements(), electricity: { status: "ordered" as const, note: "", powerOption: "5kw" as const, customPower: "" } };
  const result = priceElectricity(requirements, technicalItems, { priceListId: BEAUTY_CZK_LIST_ID, exhibitionId: "beauty", currency: "CZK" });
  assert.equal(result?.status, "priced");
  assert.equal(result?.unitPriceNet, 6900);
});

test("priceElectricity: 9kw stále resolvuje L09 se skutečnou cenou (nerozbité stávající zapojení)", () => {
  const l09: CatalogItemSummary = { id: "l09-id", internalCode: "L09", kind: "service", lifecycleStatus: "needs_review", displayName: "Přípojka el. energie - 9kW", category: "T. služby", unit: "ks", generatorEligible: false };
  const l09Entries: readonly PricingEntrySummary[] = [{ id: "entry-l09-czk", catalogItemId: "l09-id", priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", currency: "CZK", salePrice: 8900, priceMode: "fixed" }];
  const technicalItems = buildTechnicalCatalogItems([l09], l09Entries);
  const requirements = { ...createDefaultTechnicalRequirements(), electricity: { status: "ordered" as const, note: "", powerOption: "9kw" as const, customPower: "" } };
  const result = priceElectricity(requirements, technicalItems, { priceListId: BEAUTY_CZK_LIST_ID, exhibitionId: "beauty", currency: "CZK" });
  assert.equal(result?.status, "priced");
  assert.equal(result?.unitPriceNet, 8900);
});

test("priceCleaning: denní/jednorázový úklid zůstávají napojené na reálné DB internalCode U01/U05 (nerozbité 2kw změnou)", () => {
  assert.equal(CLEANING_INTERNAL_CODES.oneTime, "U05");
  assert.equal(CLEANING_INTERNAL_CODES.daily, "U01");
});

// -----------------------------------------------------------------------------------------
// Section 9/12/15: customer-facing calculation never leaks internalCode/sourceKey/
// purchasePrice/margin, even when the underlying technical-service catalog item carries them.
// -----------------------------------------------------------------------------------------

test("zákaznická kalkulace po objednání 2 kW vstoupí do Cena/CalculationPreview se skutečnou cenou, ale nikdy nezobrazí L02/internalCode/purchasePrice", () => {
  const [technicalItem] = buildTechnicalCatalogItems([l02Summary], l02Entries);
  const requirements = { ...createDefaultTechnicalRequirements(), electricity: { status: "ordered" as const, note: "", powerOption: "2kw" as const, customPower: "" } };
  const result = createCustomerCalculationViewModel({
    company: "Test s.r.o.",
    customerProjectNote: "",
    currency: "CZK",
    sceneObjects: [],
    requirements,
    printSurfaceAssignments: [],
    generatedPlanOutputs: [],
    visualizations: [],
    options: { includeVisuals: false, includePricingTable: true, includeVatSummary: true, includeContact: false, includeProjectNote: false, includeItemNotes: false, includeEventLogo: false, selectedOutputIds: [] } as never,
    catalogItems: [technicalItem!],
    priceLists: beautyPriceLists,
    event: beautyEvent,
    processedAt: "2026-08-14T10:00:00.000Z",
  });
  // Section 6: 2 kW after being ordered must land in the priced rows (→ Summary "Cena" totals
  // and Export → CalculationPreview both read priceRows/totals from this same view model).
  const electricityRow = result.priceRows.find((row) => row.unitPriceNet === 5100);
  assert.ok(electricityRow, "2kW řádek se skutečnou cenou 5100 CZK chybí v priceRows");
  assert.equal(electricityRow?.totalNet, 5100);
  assert.equal(result.totals.net, 5100);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, /internalCode|purchasePrice|"margin"|sourceKey|sourceSystem/iu);
  assert.doesNotMatch(serialized, /\bL02\b/u);
});

// -----------------------------------------------------------------------------------------
// Section 4: needs_review DB catalog items must never enter the generic ComponentLibrary.
// ComponentLibrary.tsx only ever imports the static componentCatalogItems seed directly and
// never receives DB catalog items as a prop — verified structurally via source scan (same
// pattern already used by tests/db.test.ts for priceListRepository.supabase.ts).
// -----------------------------------------------------------------------------------------

test("ComponentLibrary.tsx nikdy neimportuje DB katalog (technicalCatalogItems/catalogPricing) — needs_review položky se tam nemohou dostat", () => {
  const source = readFileSync(new URL("../components/configurator/ComponentLibrary.tsx", import.meta.url), "utf8");
  assert.equal(/catalogPricing|technicalCatalogItems/u.test(source), false);
  assert.match(source, /componentCatalogItems/u);
});
