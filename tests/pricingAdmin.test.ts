import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server.js";
import {
  buildBulkEdits,
  buildPricingEditPreview,
  filterPriceListsForAdmin,
  planDuplicatedPricingEntries,
  resolvedSalePriceForEdit,
  summarizeSaveResults,
  validateNewPriceListCode,
  type PricingEntryAdmin,
  type PricingEntryEdit,
} from "../domain/pricingAdmin.ts";
import { normalizeExhibition } from "../domain/organizations.ts";
import type { PriceList } from "../domain/organizations.ts";
import {
  DuplicatePriceListCodeError,
  duplicatePriceListAdmin,
  PriceListNotFoundError,
  readPricingEntriesAdmin,
  saveManyPricingEntriesAdmin,
} from "../lib/db/pricingAdmin.supabase.ts";
import { handlePricingAdminEntriesList } from "../app/api/pricing-admin/entries/route.ts";
import { handlePricingAdminEntriesSave } from "../app/api/pricing-admin/entries/save/route.ts";
import { handlePricingAdminDuplicatePriceList } from "../app/api/pricing-admin/price-lists/duplicate/route.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import { readCatalogItems, readPricingEntriesForPriceList } from "../lib/db/catalogPricing.supabase.ts";

const SECRET = "pricing-admin-test-session-secret-32chars";
const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.APP_SESSION_SECRET = SECRET;

function authenticatedRequest(token: string | undefined, url: string, init: Readonly<{ method?: string; body?: unknown }> = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `homeworkstudio_session=${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest(url, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}

// ---------------------------------------------------------------------------------------
// Minimal fake Supabase query builder supporting select/eq/in/maybeSingle/single/insert/
// update against in-memory tables — enough for pricingAdmin.supabase.ts's read/save/
// duplicate paths. Never touches a real Supabase project.
// ---------------------------------------------------------------------------------------
type FakeRow = Record<string, unknown>;

function createFakeSupabaseClient(seed: Readonly<Record<string, readonly FakeRow[]>> = {}) {
  const tables = new Map<string, FakeRow[]>(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  let counter = 0;

  function getTable(name: string): FakeRow[] {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }

  function from(tableName: string) {
    type Op = "select" | "insert" | "update";
    let op: Op = "select";
    let filters: Array<["eq" | "in", string, unknown]> = [];
    let payload: FakeRow | readonly FakeRow[] | undefined;
    let singleMode: "none" | "maybeSingle" | "single" = "none";

    function matches(row: FakeRow): boolean {
      return filters.every(([kind, column, value]) => kind === "eq" ? row[column] === value : (value as readonly unknown[]).includes(row[column]));
    }

    const builder = {
      select(_columns?: string) { return builder; },
      insert(row: FakeRow | readonly FakeRow[]) { op = "insert"; payload = row; return builder; },
      update(patch: FakeRow) { op = "update"; payload = patch; return builder; },
      eq(column: string, value: unknown) { filters = [...filters, ["eq", column, value]]; return builder; },
      in(column: string, values: readonly unknown[]) { filters = [...filters, ["in", column, values]]; return builder; },
      maybeSingle() { singleMode = "maybeSingle"; return execute(); },
      single() { singleMode = "single"; return execute(); },
      then(onFulfilled: (value: { data: unknown; error: unknown }) => unknown, onRejected?: (reason: unknown) => unknown) {
        return execute().then(onFulfilled, onRejected);
      },
    };

    async function execute(): Promise<{ data: unknown; error: unknown }> {
      const rows = getTable(tableName);
      if (op === "select") {
        const matched = rows.filter(matches);
        if (singleMode === "maybeSingle") return { data: matched[0] ?? null, error: null };
        if (singleMode === "single") return matched[0] ? { data: matched[0], error: null } : { data: null, error: { message: "not found" } };
        return { data: matched, error: null };
      }
      if (op === "insert") {
        const items = (Array.isArray(payload) ? payload : [payload as FakeRow]).map((item) => {
          counter += 1;
          return { id: `fake-${tableName}-${counter}`, created_at: "2026-08-15T00:00:00.000Z", ...item };
        });
        rows.push(...items);
        return singleMode === "single" ? { data: items[0], error: null } : { data: items, error: null };
      }
      if (op === "update") {
        const matched = rows.filter(matches);
        for (const row of matched) Object.assign(row, payload);
        return singleMode === "single" ? { data: matched[0] ?? null, error: null } : { data: matched, error: null };
      }
      return { data: null, error: null };
    }

    return builder;
  }

  return { from, tables };
}

const BEAUTY_CZK_LIST_ID = "list-beauty-czk";
const BEAUTY_EUR_LIST_ID = "list-beauty-eur";
const DECOR_CZK_LIST_ID = "list-decor-czk";
const L02_ID = "catalog-l02";
const L03_ID = "catalog-l03";

function priceListRow(overrides: Partial<FakeRow> & { id: string; code: string; currency: string }): FakeRow {
  return {
    name: overrides.name ?? overrides.code,
    event_id: null,
    year: 2026,
    edition: null,
    realization_company_id: null,
    valid_from: null,
    valid_to: null,
    active: true,
    document: { id: overrides.id, name: overrides.name ?? overrides.code, code: overrides.code, currency: overrides.currency, year: 2026, active: true },
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function pricingEntryRow(overrides: Partial<FakeRow> & { id: string; catalog_item_id: string; price_list_id: string; currency: string }): FakeRow {
  return {
    event_id: "beauty",
    realization_company_id: null,
    sale_price: null,
    purchase_price: null,
    valid_from: null,
    valid_to: null,
    price_mode: "fixed",
    created_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// -----------------------------------------------------------------------------------------
// PRICE LIST DETAIL — section 19
// -----------------------------------------------------------------------------------------

test("readPricingEntriesAdmin: načte pricing entries konkrétního ceníku (priceListIds filter)", async () => {
  const client = createFakeSupabaseClient({
    pricing_entries: [
      pricingEntryRow({ id: "e1", catalog_item_id: L02_ID, price_list_id: BEAUTY_CZK_LIST_ID, currency: "CZK", sale_price: 5100 }),
      pricingEntryRow({ id: "e2", catalog_item_id: L02_ID, price_list_id: DECOR_CZK_LIST_ID, currency: "CZK", sale_price: 4900 }),
    ],
  });
  const entries = await readPricingEntriesAdmin(client as never, { priceListIds: [BEAUTY_CZK_LIST_ID] });
  assert.equal(entries.length, 1);
  assert.equal(entries[0]?.priceListId, BEAUTY_CZK_LIST_ID);
  assert.equal(entries[0]?.salePrice, 5100);
});

test("saveManyPricingEntriesAdmin: fixed update změní existující cenu", async () => {
  const client = createFakeSupabaseClient({
    pricing_entries: [pricingEntryRow({ id: "e1", catalog_item_id: L02_ID, price_list_id: BEAUTY_CZK_LIST_ID, currency: "CZK", sale_price: 5100 })],
  });
  const summary = await saveManyPricingEntriesAdmin(client as never, [
    { catalogItemId: L02_ID, priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", currency: "CZK", priceMode: "fixed", salePrice: 5300 },
  ]);
  assert.equal(summary.succeededCount, 1);
  assert.equal(summary.failedCount, 0);
  const reloaded = await readPricingEntriesAdmin(client as never, { priceListIds: [BEAUTY_CZK_LIST_ID] });
  assert.equal(reloaded[0]?.salePrice, 5300);
});

test("saveManyPricingEntriesAdmin: individual mode nikdy neuloží číselnou cenu", async () => {
  const client = createFakeSupabaseClient({ pricing_entries: [] });
  await saveManyPricingEntriesAdmin(client as never, [
    { catalogItemId: L02_ID, priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", currency: "CZK", priceMode: "individual" },
  ]);
  const reloaded = await readPricingEntriesAdmin(client as never, { priceListIds: [BEAUTY_CZK_LIST_ID] });
  assert.equal(reloaded[0]?.priceMode, "individual");
  assert.equal(reloaded[0]?.salePrice, undefined);
});

test("saveManyPricingEntriesAdmin: included mode uloží 0, ne 'chybějící'", async () => {
  const client = createFakeSupabaseClient({ pricing_entries: [] });
  await saveManyPricingEntriesAdmin(client as never, [
    { catalogItemId: L02_ID, priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", currency: "CZK", priceMode: "included" },
  ]);
  const reloaded = await readPricingEntriesAdmin(client as never, { priceListIds: [BEAUTY_CZK_LIST_ID] });
  assert.equal(reloaded[0]?.priceMode, "included");
  assert.equal(reloaded[0]?.salePrice, 0);
});

test("missing cena se nikdy nezobrazí jako 0 — chybějící řádek zůstává absencí, ne 0", async () => {
  const client = createFakeSupabaseClient({ pricing_entries: [] });
  const entries = await readPricingEntriesAdmin(client as never, { priceListIds: [BEAUTY_CZK_LIST_ID] });
  assert.equal(entries.length, 0);
  // resolvedSalePriceForEdit itself never fabricates a numeric price for a missing/individual edit:
  assert.equal(resolvedSalePriceForEdit({ priceMode: "individual" }), undefined);
});

test("readPricingEntriesAdmin: bez catalogItemIds i priceListIds odmítne načíst vše (section 16)", async () => {
  const client = createFakeSupabaseClient({ pricing_entries: [] });
  await assert.rejects(() => readPricingEntriesAdmin(client as never, {}));
});

// -----------------------------------------------------------------------------------------
// COMPONENT PRICE VIEW — section 19
// -----------------------------------------------------------------------------------------

test("readPricingEntriesAdmin: jedna komponenta napříč více ceníky (catalogItemIds filter)", async () => {
  const client = createFakeSupabaseClient({
    pricing_entries: [
      pricingEntryRow({ id: "e1", catalog_item_id: L02_ID, price_list_id: BEAUTY_CZK_LIST_ID, currency: "CZK", sale_price: 5100 }),
      pricingEntryRow({ id: "e2", catalog_item_id: L02_ID, price_list_id: BEAUTY_EUR_LIST_ID, currency: "EUR", sale_price: 231 }),
      pricingEntryRow({ id: "e3", catalog_item_id: L03_ID, price_list_id: BEAUTY_CZK_LIST_ID, currency: "CZK", sale_price: 5900 }),
    ],
  });
  const entries = await readPricingEntriesAdmin(client as never, { catalogItemIds: [L02_ID] });
  assert.equal(entries.length, 2);
  assert.ok(entries.every((entry) => entry.catalogItemId === L02_ID));
});

const beautyEvent = normalizeExhibition({ id: "beauty", name: "Beauty", year: 2026, priceListIds: [BEAUTY_CZK_LIST_ID, BEAUTY_EUR_LIST_ID] });
const decorEvent = normalizeExhibition({ id: "decor", name: "Decor", year: 2027, priceListIds: [DECOR_CZK_LIST_ID] });
const beautyCzkList: PriceList = { id: BEAUTY_CZK_LIST_ID, name: "Beauty 2026 CZK", code: "BEAUTY-2026-CZK", currency: "CZK", year: 2026, active: true };
const beautyEurList: PriceList = { id: BEAUTY_EUR_LIST_ID, name: "Beauty 2026 EUR", code: "BEAUTY-2026-EUR", currency: "EUR", year: 2026, active: true };
const decorCzkList: PriceList = { id: DECOR_CZK_LIST_ID, name: "Decor 2027 CZK", code: "DECOR-2027-CZK", currency: "CZK", year: 2027, active: true };
const allPriceLists = [beautyCzkList, beautyEurList, decorCzkList];
const allEvents = [beautyEvent, decorEvent];

test("Component Price View filtr: Rok zúží ceníky na konkrétní rok", () => {
  const result = filterPriceListsForAdmin(allPriceLists, allEvents, { year: "2027", eventIds: [], currency: "", priceListIds: [], priceMode: "" });
  assert.deepEqual(result.map((list) => list.id), [DECOR_CZK_LIST_ID]);
});

test("Component Price View filtr: Event zúží ceníky na vybraný event", () => {
  const result = filterPriceListsForAdmin(allPriceLists, allEvents, { year: "", eventIds: ["decor"], currency: "", priceListIds: [], priceMode: "" });
  assert.deepEqual(result.map((list) => list.id), [DECOR_CZK_LIST_ID]);
});

test("Component Price View filtr: Měna=CZK vyloučí EUR ceníky", () => {
  const result = filterPriceListsForAdmin(allPriceLists, allEvents, { year: "", eventIds: [], currency: "CZK", priceListIds: [], priceMode: "" });
  assert.ok(result.every((list) => list.currency === "CZK"));
  assert.ok(!result.some((list) => list.id === BEAUTY_EUR_LIST_ID));
});

test("Component Price View filtr: Měna=EUR vyloučí CZK ceníky", () => {
  const result = filterPriceListsForAdmin(allPriceLists, allEvents, { year: "", eventIds: [], currency: "EUR", priceListIds: [], priceMode: "" });
  assert.deepEqual(result.map((list) => list.id), [BEAUTY_EUR_LIST_ID]);
});

test("Component Price View filtry se kombinují: Rok=2026 + Měna=CZK + Event=Beauty", () => {
  const result = filterPriceListsForAdmin(allPriceLists, allEvents, { year: "2026", eventIds: ["beauty"], currency: "CZK", priceListIds: [], priceMode: "" });
  assert.deepEqual(result.map((list) => list.id), [BEAUTY_CZK_LIST_ID]);
});

// -----------------------------------------------------------------------------------------
// PRICING MATRIX — section 19
// -----------------------------------------------------------------------------------------

const l02Entry: PricingEntryAdmin = { id: "e1", catalogItemId: L02_ID, priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", realizationCompanyId: null, currency: "CZK", salePrice: 5100, purchasePrice: undefined, priceMode: "fixed" };

test("Pricing Matrix: buildBulkEdits vytvoří edity pro více komponent × více ceníků", () => {
  const edits = buildBulkEdits([L02_ID, L03_ID], [{ id: BEAUTY_CZK_LIST_ID, currency: "CZK", eventId: "beauty" }, { id: DECOR_CZK_LIST_ID, currency: "CZK", eventId: "decor" }], { priceMode: "fixed", salePriceByCurrency: { CZK: 6000 } });
  assert.equal(edits.length, 4);
  assert.ok(edits.every((edit) => edit.salePrice === 6000));
});

test("Pricing Matrix: úprava jedné buňky uloží jen tu jednu entry", async () => {
  const client = createFakeSupabaseClient({ pricing_entries: [{ id: "e1", catalog_item_id: L02_ID, price_list_id: BEAUTY_CZK_LIST_ID, event_id: "beauty", currency: "CZK", sale_price: 5100, price_mode: "fixed", realization_company_id: null, purchase_price: null, valid_from: null, valid_to: null, created_at: "2026-01-01T00:00:00.000Z" }] });
  const summary = await saveManyPricingEntriesAdmin(client as never, [{ catalogItemId: L02_ID, priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", currency: "CZK", priceMode: "fixed", salePrice: 5200 }]);
  assert.equal(summary.succeededCount, 1);
  const other = await readPricingEntriesAdmin(client as never, { catalogItemIds: [L03_ID] }).catch(() => []);
  assert.deepEqual(other, []);
});

test("Pricing Matrix: uložení více buněk najednou vrátí souhrn se všemi výsledky", async () => {
  const client = createFakeSupabaseClient({ pricing_entries: [] });
  const edits: PricingEntryEdit[] = [
    { catalogItemId: L02_ID, priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", currency: "CZK", priceMode: "fixed", salePrice: 5100 },
    { catalogItemId: L03_ID, priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", currency: "CZK", priceMode: "fixed", salePrice: 5900 },
  ];
  const summary = await saveManyPricingEntriesAdmin(client as never, edits);
  assert.equal(summary.succeededCount, 2);
  assert.equal(summary.results.length, 2);
});

test("currency isolation: buildBulkEdits nikdy neaplikuje CZK hodnotu na EUR ceník (chybějící měna se přeskočí)", () => {
  const edits = buildBulkEdits([L02_ID], [{ id: BEAUTY_CZK_LIST_ID, currency: "CZK", eventId: "beauty" }, { id: BEAUTY_EUR_LIST_ID, currency: "EUR", eventId: "beauty" }], { priceMode: "fixed", salePriceByCurrency: { CZK: 5100 } });
  assert.equal(edits.length, 1);
  assert.equal(edits[0]?.priceListId, BEAUTY_CZK_LIST_ID);
});

test("no conversion: zadání CZK i EUR hodnoty zvlášť aplikuje KAŽDOU jen na její vlastní měnu", () => {
  const edits = buildBulkEdits([L02_ID], [{ id: BEAUTY_CZK_LIST_ID, currency: "CZK", eventId: "beauty" }, { id: BEAUTY_EUR_LIST_ID, currency: "EUR", eventId: "beauty" }], { priceMode: "fixed", salePriceByCurrency: { CZK: 5100, EUR: 231 } });
  const czkEdit = edits.find((edit) => edit.priceListId === BEAUTY_CZK_LIST_ID);
  const eurEdit = edits.find((edit) => edit.priceListId === BEAUTY_EUR_LIST_ID);
  assert.equal(czkEdit?.salePrice, 5100);
  assert.equal(eurEdit?.salePrice, 231);
  assert.notEqual(czkEdit?.salePrice, eurEdit?.salePrice);
});

// -----------------------------------------------------------------------------------------
// BULK EDIT — section 19
// -----------------------------------------------------------------------------------------

test("Bulk: edituje jen vybrané komponenty, nikdy položky mimo výběr", () => {
  const edits = buildBulkEdits([L02_ID], [{ id: BEAUTY_CZK_LIST_ID, currency: "CZK", eventId: "beauty" }], { priceMode: "fixed", salePriceByCurrency: { CZK: 5000 } });
  assert.ok(edits.every((edit) => edit.catalogItemId === L02_ID));
  assert.ok(!edits.some((edit) => edit.catalogItemId === L03_ID));
});

test("Bulk: edituje jen vybrané price lists, nikdy ceníky mimo výběr", () => {
  const edits = buildBulkEdits([L02_ID], [{ id: BEAUTY_CZK_LIST_ID, currency: "CZK", eventId: "beauty" }], { priceMode: "fixed", salePriceByCurrency: { CZK: 5000 } });
  assert.ok(edits.every((edit) => edit.priceListId === BEAUTY_CZK_LIST_ID));
  assert.ok(!edits.some((edit) => edit.priceListId === DECOR_CZK_LIST_ID));
});

test("Bulk preview: buildPricingEditPreview ukáže původní i novou hodnotu před zápisem", () => {
  const edits = buildBulkEdits([L02_ID], [{ id: BEAUTY_CZK_LIST_ID, currency: "CZK", eventId: "beauty" }], { priceMode: "fixed", salePriceByCurrency: { CZK: 5300 } });
  const preview = buildPricingEditPreview([l02Entry], edits, { catalogItem: () => "L02 Elektřina 2kW", priceList: () => "Beauty 2026 CZK" });
  assert.equal(preview.length, 1);
  assert.equal(preview[0]?.before?.salePrice, 5100);
  assert.equal(preview[0]?.after.salePrice, 5300);
});

test("Bulk preview: chybějící buňka (žádná existující entry) má before=undefined, nikdy fabrikovanou nulu", () => {
  const edits = buildBulkEdits([L03_ID], [{ id: BEAUTY_CZK_LIST_ID, currency: "CZK", eventId: "beauty" }], { priceMode: "fixed", salePriceByCurrency: { CZK: 100 } });
  const preview = buildPricingEditPreview([l02Entry], edits, { catalogItem: () => "L03", priceList: () => "Beauty 2026 CZK" });
  assert.equal(preview[0]?.before, undefined);
});

test("Bulk: žádná nezamýšlená aktualizace mimo (component, priceList) selection páry", () => {
  const edits = buildBulkEdits([L02_ID, L03_ID], [{ id: BEAUTY_CZK_LIST_ID, currency: "CZK", eventId: "beauty" }, { id: BEAUTY_EUR_LIST_ID, currency: "EUR", eventId: "beauty" }], { priceMode: "fixed", salePriceByCurrency: { CZK: 100, EUR: 5 } });
  // 2 components × 2 price lists = exactly 4 edits, never more/fewer
  assert.equal(edits.length, 4);
  const pairs = new Set(edits.map((edit) => `${edit.catalogItemId}::${edit.priceListId}`));
  assert.equal(pairs.size, 4);
});

// -----------------------------------------------------------------------------------------
// DUPLICATE PRICE LIST — section 19
// -----------------------------------------------------------------------------------------

test("duplicatePriceListAdmin: vytvoří nový PriceList s novým id/kódem a zkopíruje entries", async () => {
  const client = createFakeSupabaseClient({
    price_lists: [priceListRow({ id: DECOR_CZK_LIST_ID, code: "DECOR-2026-CZK", currency: "CZK", name: "Decor 2026 CZK", year: 2026, event_id: "decor" })],
    pricing_entries: [
      pricingEntryRow({ id: "e1", catalog_item_id: L02_ID, price_list_id: DECOR_CZK_LIST_ID, currency: "CZK", sale_price: 5100, event_id: "decor" }),
      pricingEntryRow({ id: "e2", catalog_item_id: L03_ID, price_list_id: DECOR_CZK_LIST_ID, currency: "CZK", sale_price: 5900, event_id: "decor" }),
    ],
  });
  const result = await duplicatePriceListAdmin(client as never, DECOR_CZK_LIST_ID, {
    name: "Decor 2027 CZK", code: "DECOR-2027-CZK", year: 2027, eventId: "decor", currency: "CZK", active: true,
  });
  assert.notEqual(result.priceList.id, DECOR_CZK_LIST_ID);
  assert.equal(result.priceList.code, "DECOR-2027-CZK");
  assert.equal(result.copiedCount, 2);
  assert.equal(result.skippedCount, 0);

  const originalEntries = await readPricingEntriesAdmin(client as never, { priceListIds: [DECOR_CZK_LIST_ID] });
  assert.equal(originalEntries.length, 2, "původní ceník musí zůstat beze změny");
  assert.equal(originalEntries.find((entry) => entry.catalogItemId === L02_ID)?.salePrice, 5100);

  const newEntries = await readPricingEntriesAdmin(client as never, { priceListIds: [result.priceList.id] });
  assert.equal(newEntries.length, 2);
  assert.ok(newEntries.every((entry) => entry.priceListId === result.priceList.id), "žádná zkopírovaná entry nesmí ukazovat na starý ceník");
  assert.ok(originalEntries.every((entry) => entry.priceListId === DECOR_CZK_LIST_ID), "žádná původní entry nesmí ukazovat na nový ceník");
});

test("duplicatePriceListAdmin: nový ceník má jinou DB identitu (id) než zdroj", async () => {
  const client = createFakeSupabaseClient({
    price_lists: [priceListRow({ id: DECOR_CZK_LIST_ID, code: "DECOR-2026-CZK", currency: "CZK", year: 2026 })],
    pricing_entries: [],
  });
  const result = await duplicatePriceListAdmin(client as never, DECOR_CZK_LIST_ID, { name: "Decor 2027", code: "DECOR-2027-CZK", year: 2027, currency: "CZK", active: true });
  assert.notEqual(result.priceList.id, DECOR_CZK_LIST_ID);
  assert.match(result.priceList.id, /^fake-price_lists-/);
});

test("duplicatePriceListAdmin: kolidující kód je odmítnut, STOP bez zápisu (žádný silent overwrite)", async () => {
  const client = createFakeSupabaseClient({
    price_lists: [
      priceListRow({ id: DECOR_CZK_LIST_ID, code: "DECOR-2026-CZK", currency: "CZK", year: 2026 }),
      priceListRow({ id: "list-other", code: "DECOR-2027-CZK", currency: "CZK", year: 2027 }),
    ],
    pricing_entries: [],
  });
  await assert.rejects(
    () => duplicatePriceListAdmin(client as never, DECOR_CZK_LIST_ID, { name: "Decor 2027", code: "DECOR-2027-CZK", year: 2027, currency: "CZK", active: true }),
    (error) => error instanceof DuplicatePriceListCodeError,
  );
  const priceLists = client.tables.get("price_lists") ?? [];
  assert.equal(priceLists.length, 2, "kolize nesmí vytvořit žádný nový řádek");
});

test("duplicatePriceListAdmin: kolize kódu je case-insensitive (decor-2027-czk == DECOR-2027-CZK)", () => {
  const validation = validateNewPriceListCode(["DECOR-2027-CZK"], "decor-2027-czk");
  assert.equal(validation.ok, false);
});

test("duplicatePriceListAdmin: neexistující zdrojový ceník vyhodí PriceListNotFoundError", async () => {
  const client = createFakeSupabaseClient({ price_lists: [], pricing_entries: [] });
  await assert.rejects(
    () => duplicatePriceListAdmin(client as never, "missing-id", { name: "X", code: "X-2027", year: 2027, currency: "CZK", active: true }),
    (error) => error instanceof PriceListNotFoundError,
  );
});

test("duplicatePriceListAdmin: zachová správnou měnu nového ceníku", async () => {
  const client = createFakeSupabaseClient({
    price_lists: [priceListRow({ id: BEAUTY_CZK_LIST_ID, code: "BEAUTY-2026-CZK", currency: "CZK", year: 2026 })],
    pricing_entries: [],
  });
  const result = await duplicatePriceListAdmin(client as never, BEAUTY_CZK_LIST_ID, { name: "Beauty 2026 EUR", code: "BEAUTY-2026-EUR", year: 2026, currency: "EUR", active: true });
  assert.equal(result.priceList.currency, "EUR");
});

test("planDuplicatedPricingEntries: fixed cena v jiné měně se NIKDY nezkopíruje jako fabrikovaná hodnota", () => {
  const czkEntry: PricingEntryAdmin = { id: "e1", catalogItemId: L02_ID, priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", realizationCompanyId: null, currency: "CZK", salePrice: 5100, purchasePrice: undefined, priceMode: "fixed" };
  const plan = planDuplicatedPricingEntries([czkEntry], { priceListId: "new-eur-list", eventId: "beauty", currency: "EUR" });
  assert.equal(plan.copied.length, 0);
  assert.equal(plan.skippedCurrencyMismatch.length, 1);
});

test("planDuplicatedPricingEntries: individual/included se kopírují i při změně měny (currency-independent)", () => {
  const individualEntry: PricingEntryAdmin = { id: "e1", catalogItemId: L02_ID, priceListId: BEAUTY_CZK_LIST_ID, eventId: "beauty", realizationCompanyId: null, currency: "CZK", salePrice: undefined, purchasePrice: undefined, priceMode: "individual" };
  const plan = planDuplicatedPricingEntries([individualEntry], { priceListId: "new-eur-list", eventId: "beauty", currency: "EUR" });
  assert.equal(plan.copied.length, 1);
  assert.equal(plan.copied[0]?.currency, "EUR");
});

// -----------------------------------------------------------------------------------------
// AUTH — section 19
// -----------------------------------------------------------------------------------------

test("neautentizovaný požadavek na /api/pricing-admin/entries je odmítnut s 401", async () => {
  const response = await handlePricingAdminEntriesList(authenticatedRequest(undefined, "http://localhost/api/pricing-admin/entries?catalogItemIds=x"), () => Promise.resolve([]));
  assert.equal(response.status, 401);
});

test("neautentizovaný požadavek na /api/pricing-admin/entries/save je odmítnut s 401", async () => {
  const response = await handlePricingAdminEntriesSave(authenticatedRequest(undefined, "http://localhost/api/pricing-admin/entries/save", { method: "POST", body: { edits: [] } }), () => Promise.resolve(summarizeSaveResults([])));
  assert.equal(response.status, 401);
});

test("neautentizovaný požadavek na /api/pricing-admin/price-lists/duplicate je odmítnut s 401", async () => {
  const response = await handlePricingAdminDuplicatePriceList(authenticatedRequest(undefined, "http://localhost/api/pricing-admin/price-lists/duplicate", { method: "POST", body: {} }));
  assert.equal(response.status, 401);
});

test("/api/pricing-admin/entries bez filtru vrátí 400", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handlePricingAdminEntriesList(authenticatedRequest(token, "http://localhost/api/pricing-admin/entries"), () => Promise.resolve([]));
  assert.equal(response.status, 400);
});

test("autentizovaný /api/pricing-admin/entries vrátí ceny z repository", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handlePricingAdminEntriesList(authenticatedRequest(token, "http://localhost/api/pricing-admin/entries?catalogItemIds=" + L02_ID), () => Promise.resolve([l02Entry]));
  assert.equal(response.status, 200);
  const body = await response.json() as { entries: PricingEntryAdmin[] };
  assert.equal(body.entries.length, 1);
});

test("autentizovaný /api/pricing-admin/price-lists/duplicate s kolizí kódu vrátí 409", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handlePricingAdminDuplicatePriceList(
    authenticatedRequest(token, "http://localhost/api/pricing-admin/price-lists/duplicate", { method: "POST", body: { sourcePriceListId: DECOR_CZK_LIST_ID, priceList: { name: "X", code: "DECOR-2027-CZK", year: 2027, currency: "CZK", active: true } } }),
    () => Promise.reject(new DuplicatePriceListCodeError("DECOR-2027-CZK")),
  );
  assert.equal(response.status, 409);
});

// -----------------------------------------------------------------------------------------
// CUSTOMER SAFETY — section 19/17
// -----------------------------------------------------------------------------------------

test("customer-safe catalogPricing.supabase.ts nikdy nečte purchase_price (admin-only pole nemůže uniknout na zákaznickou cestu)", () => {
  const source = readFileSync(new URL("../lib/db/catalogPricing.supabase.ts", import.meta.url), "utf8");
  assert.equal(/purchase_price/u.test(source), false);
});

test("PricingEntrySummary (customer-safe) typově neobsahuje purchasePrice/realizationCompanyId (admin-only pole zůstávají jen v PricingEntryAdmin)", async () => {
  const client = createFakeSupabaseClient({
    pricing_entries: [{ id: "e1", catalog_item_id: L02_ID, price_list_id: BEAUTY_CZK_LIST_ID, event_id: "beauty", currency: "CZK", sale_price: 5100, price_mode: "fixed" }],
  });
  const customerEntries = await readPricingEntriesForPriceList(client as never, BEAUTY_CZK_LIST_ID);
  const serialized = JSON.stringify(customerEntries);
  assert.doesNotMatch(serialized, /purchasePrice|purchase_price|realizationCompanyId/iu);
});

test("readCatalogItems (customer-safe) nikdy nevrací document/sourceKey ani u komponent použitých ve Správě cen", async () => {
  const client = createFakeSupabaseClient({
    catalog_items: [{ id: L02_ID, internal_code: "L02", kind: "service", lifecycle_status: "active", display_name: "Elektřina 2kW", category: "T. služby", unit: "ks", document: { id: L02_ID, name: "L02", type: "service", widthMm: 0, depthMm: 0, sourceKey: "abf-raw" } }],
  });
  const items = await readCatalogItems(client as never);
  const serialized = JSON.stringify(items);
  assert.doesNotMatch(serialized, /sourceKey|abf-raw/iu);
});
