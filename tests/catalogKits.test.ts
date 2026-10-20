import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createSessionToken } from "../lib/auth/session.ts";
import {
  assignKitLineKeys,
  buildKitLinesRpcPayload,
  InvalidCatalogPackageError,
  isLegacyCompatibleKit,
  kitTypeChangeIssue,
  packageItemToInput,
  parseCatalogPackageItemsInput,
  slugifyLineKey,
  validateKitLines,
  type CatalogPackageItem,
  type CatalogPackageItemInput,
} from "../domain/catalogPackages.ts";
import { priceKit, summarizeKitComponents, type KitPriceResolver } from "../domain/catalogKitPricing.ts";
import {
  allocateKitPrintAllowance,
  chargedQuantityByTypeAndUnit,
  kitPrintAllowanceIssues,
  legacyKitPrintAllowances,
  usagesFromBoothAssignments,
  usagesFromPrintSurfaceItems,
} from "../domain/catalogKitPrintAllowance.ts";
import {
  InvalidCatalogVariantSetError,
  parseCatalogVariantSetInput,
  validateCatalogVariantSet,
  variantForLegacyFinish,
  type CatalogVariantSet,
} from "../domain/catalogVariants.ts";
import {
  buildCustomerCatalogCard,
  buildCustomerCatalogEntries,
  canPublishInCustomerCatalog,
  DEFAULT_CUSTOMER_CATALOG_EXPORT_OPTIONS,
  isPublishedInCustomerCatalog,
} from "../domain/customerCatalog.ts";
import { boothIncludesPrintSurface, computePrintSurfaceAssignments } from "../domain/technicalServices.ts";
import type { CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";
import type { CatalogItemType } from "../domain/models.ts";
import { boothTypes } from "../data/booths.ts";
import { carpetFinishVariants } from "../domain/finishes.ts";
import {
  CatalogSchemaNotMigratedError,
  duplicateCatalogItemAdmin,
  readCatalogItemsAdmin,
  readCatalogVariantSets,
  saveCatalogItemAdmin,
  saveCatalogPackageItems,
  saveCatalogVariantSet,
} from "../lib/db/catalogItemsAdmin.supabase.ts";
import { handleCatalogAdminPackageSave } from "../app/api/catalog-admin/items/package/route.ts";
import { handleCatalogVariantSetSave, handleCatalogVariantSetsGet } from "../app/api/catalog-admin/variant-sets/route.ts";

// =========================================================================================
// V1-DATA-04 — kits, variants and substitutes: kit lines shared by BOOTH and KIT, free text
// lines (A16), substitutes with surcharge rules (A4), swatch books (A12), no nested kits (A14),
// included graphics with overflow (A17), KIT in the customer catalog, migration M6 + M7.
// =========================================================================================

const SECRET = "catalog-kits-test-session-secret-000032";
(process.env as Record<string, string | undefined>).APP_SESSION_SECRET = SECRET;
const MIGRATION = "supabase/migrations/20261021130000_catalog_kits_variants.sql";

async function migrationSql(): Promise<string> {
  const sql = await readFile(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
  return sql.split("\n").map((line) => line.replace(/--.*$/u, "")).join("\n");
}

// ---------------------------------------------------------------------------------------
// Fake Supabase client WITH the V1-DATA-04 migration: tables + replace_catalog_kit_lines()
// emulated with the same semantics as the SQL function (match by line_key, keep ids, remove
// missing lines with their substitutes, replace each line's substitutes).
// ---------------------------------------------------------------------------------------
type FakeRow = Record<string, unknown>;

function createKitClient(seed: Readonly<Record<string, readonly FakeRow[]>> = {}) {
  const tables = new Map<string, FakeRow[]>(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  let nextId = 1;
  const calls: string[] = [];

  function from(tableName: string) {
    let op: "select" | "insert" | "update" | "delete" = "select";
    let payload: FakeRow | FakeRow[] | undefined;
    const filters: [string, unknown][] = [];
    let single = false;
    const builder = {
      select(_cols = "*") { return builder; },
      insert(row: FakeRow | FakeRow[]) { op = "insert"; payload = row; return builder; },
      update(patch: FakeRow) { op = "update"; payload = patch; return builder; },
      delete() { op = "delete"; return builder; },
      eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
      order() { return builder; },
      limit() { return builder; },
      single() { single = true; return run(); },
      maybeSingle() { single = true; return run(); },
      then(resolve: (value: { data: unknown; error: unknown }) => unknown, reject?: (reason: unknown) => unknown) { return run().then(resolve, reject); },
    };
    async function run(): Promise<{ data: unknown; error: unknown }> {
      calls.push(`${op}:${tableName}`);
      const rows = table(tableName);
      const matches = (row: FakeRow) => filters.every(([column, value]) => row[column] === value);
      if (op === "select") {
        const matched = rows.filter(matches);
        return { data: single ? matched[0] ?? null : matched, error: null };
      }
      if (op === "insert") {
        const list = (Array.isArray(payload) ? payload : [payload!]).map((row) => ({ updated_at: "2026-10-20T00:00:00.000Z", created_at: "2026-10-20T00:00:00.000Z", ...row, id: row.id ?? `${tableName}-${nextId++}` }));
        rows.push(...list);
        return { data: single ? list[0] : list, error: null };
      }
      if (op === "update") {
        const matched = rows.filter(matches);
        for (const row of matched) Object.assign(row, payload, { updated_at: `2026-10-20T00:00:${String(nextId++).padStart(2, "0")}.000Z` });
        return { data: matched, error: null };
      }
      tables.set(tableName, rows.filter((row) => !matches(row)));
      return { data: null, error: null };
    }
    return builder;
  }

  async function rpc(name: string, args: { p_package_item_id: string; p_lines: FakeRow[] }) {
    calls.push(`rpc:${name}`);
    if (name !== "replace_catalog_kit_lines") return { data: null, error: { code: "PGRST202" } };
    const lines = table("catalog_item_package_items");
    const keys = new Set(args.p_lines.map((line) => line.line_key));
    const removed = lines.filter((line) => line.package_item_id === args.p_package_item_id && !keys.has(line.line_key)).map((line) => line.id);
    tables.set("catalog_item_package_items", lines.filter((line) => !removed.includes(line.id)));
    tables.set("catalog_kit_line_substitutes", table("catalog_kit_line_substitutes").filter((sub) => !removed.includes(sub.kit_line_id)));
    for (const [index, line] of args.p_lines.entries()) {
      const { substitutes, ...columns } = line as FakeRow & { substitutes: FakeRow[] };
      let stored = table("catalog_item_package_items").find((candidate) => candidate.package_item_id === args.p_package_item_id && candidate.line_key === line.line_key);
      if (stored) Object.assign(stored, columns, { sort_order: index });
      else {
        stored = { id: `line-${nextId++}`, package_item_id: args.p_package_item_id, ...columns, sort_order: index };
        table("catalog_item_package_items").push(stored);
      }
      const lineId = stored.id;
      tables.set("catalog_kit_line_substitutes", table("catalog_kit_line_substitutes").filter((sub) => sub.kit_line_id !== lineId));
      for (const [subIndex, sub] of (substitutes ?? []).entries()) {
        table("catalog_kit_line_substitutes").push({ id: `sub-${nextId++}`, kit_line_id: lineId, ...sub, is_active: true, sort_order: subIndex });
      }
    }
    return { data: null, error: null };
  }
  return { from, rpc, tables, calls };
}

function row(overrides: FakeRow): FakeRow {
  return {
    id: "row-id",
    internal_code: null,
    abf_code: null,
    item_type: "PRODUCT",
    kind: "furniture",
    lifecycle_status: "active",
    display_name: "Položka",
    official_name: null,
    category: "other",
    unit: "ks",
    document: { displayName: "Položka", name: "Položka" },
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const P86 = row({ id: "p86", internal_code: "P86", abf_code: "P86", item_type: "BOOTH", kind: "booth", display_name: "Kóje 2 × 2 m (P86)" });
const KIT_FURNITURE = row({ id: "kit-nabytek", item_type: "KIT", kind: "other", display_name: "Balíček nábytku", lifecycle_status: "needs_review" });
const M01 = row({ id: "m01", internal_code: "M01", abf_code: "M01", display_name: "Koberec šedý 1 m²", unit: "m²" });
const M02 = row({ id: "m02", internal_code: "M02", abf_code: "M02", display_name: "Koberec jiné barvy 1 m²", unit: "m²" });
const L02 = row({ id: "l02", internal_code: "L02", abf_code: "L02", item_type: "SERVICE", kind: "service", display_name: "Přípojka el. energie - 2kW" });
const L03 = row({ id: "l03", internal_code: "L03", abf_code: "L03", item_type: "SERVICE", kind: "service", display_name: "Přípojka el. energie - 3kW" });
const L05 = row({ id: "l05", internal_code: "L05", abf_code: "L05", item_type: "SERVICE", kind: "service", display_name: "Přípojka el. energie - 5kW" });
const PANEL = row({ id: "panel", item_type: "INTERNAL_COMPONENT", kind: "booth_component", display_name: "Panel 950" });
const CHAIR = row({ id: "m57", internal_code: "M57", abf_code: "M57", display_name: "Židle kovová čalouněná" });
const FASCIA_GRAPHICS = row({ id: "grafika-limec", internal_code: "GRAPHICS-FASCIA", item_type: "SERVICE", kind: "graphics_service", display_name: "Grafika na límec", unit: "bm" });

const CATALOG = [P86, KIT_FURNITURE, M01, M02, L02, L03, L05, PANEL, CHAIR, FASCIA_GRAPHICS];

const CARPET_SET_ROWS = {
  catalog_variant_sets: [{ id: "set-koberce", code: "KOBERCE-2026", name: "Koberce 2026", kind: "carpet", is_active: true, note: null }],
  catalog_variants: [
    { id: "v-seda", variant_set_id: "set-koberce", code: "SEDA", name: "Šedá", name_en: null, swatch_color: "#8d9092", price_item_id: "m01", surcharge_rule: "none", surcharge_unit_code: null, legacy_finish_id: "carpet-grey", is_active: true, sort_order: 0, note: null },
    { id: "v-cervena", variant_set_id: "set-koberce", code: "CERVENA", name: "Červená", name_en: null, swatch_color: "#8b3d3d", price_item_id: "m02", surcharge_rule: "per_unit", surcharge_unit_code: "m2", legacy_finish_id: "carpet-red", is_active: true, sort_order: 1, note: null },
    { id: "v-modra", variant_set_id: "set-koberce", code: "MODRA", name: "Modrá", name_en: null, swatch_color: "#355f84", price_item_id: "m02", surcharge_rule: "per_unit", surcharge_unit_code: "m2", legacy_finish_id: "carpet-blue", is_active: true, sort_order: 2, note: null },
    { id: "v-cerna", variant_set_id: "set-koberce", code: "CERNA", name: "Černá", name_en: null, swatch_color: "#282828", price_item_id: "m02", surcharge_rule: "price_difference", surcharge_unit_code: null, legacy_finish_id: "carpet-black", is_active: true, sort_order: 3, note: null },
  ],
};

function kitClient(extra: Readonly<Record<string, readonly FakeRow[]>> = {}) {
  return createKitClient({ catalog_items: CATALOG, ...CARPET_SET_ROWS, ...extra });
}

const P86_LINES: readonly CatalogPackageItemInput[] = [
  { lineKey: "koberec", childItemId: "m01", quantity: 4, unitCode: "m2", includedInPackage: true, variantSetId: "set-koberce", defaultVariantId: "v-seda" },
  { lineKind: "text", label: "Stavba stánku", quantity: 2, unitCode: "m2", includedInPackage: true },
  { lineKey: "elektro", childItemId: "l02", quantity: 1, unitCode: "ks", includedInPackage: true, substitutes: [
    { substituteItemId: "l03", surchargeRule: "price_difference", quantityFactor: 1 },
    { substituteItemId: "l05", surchargeRule: "price_difference", quantityFactor: 1 },
  ] },
  { lineKey: "grafika-limec", childItemId: "grafika-limec", quantity: 2, unitCode: "bm", includedInPackage: true, printAllowance: [{ surfaceTypeId: "fascia", printSurfaceIds: ["fascia-print"], unitCode: "bm", includedQuantity: 2 }] },
];

function request(url: string, init: Readonly<{ token?: string; body?: unknown; method?: string }> = {}) {
  const headers: Record<string, string> = {};
  if (init.token) headers.Cookie = `homeworkstudio_session=${init.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest(url, { method: init.method ?? "POST", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}

// =========================================================================================
// MIGRATION
// =========================================================================================

test("migrace: číslo navazuje na 20261021120000 a je poslední; nic nemaže ani nepřepisuje historická data", async () => {
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(migrations.at(-1), "20261021130000_catalog_kits_variants.sql");
  assert.equal(migrations.at(-2), "20261021120000_catalog_identity.sql");
  const sql = (await migrationSql()).toLowerCase();
  assert.doesNotMatch(sql, /drop\s+table|truncate|delete\s+from\s+catalog_items|update\s+projects/u);
  // The only delete is inside replace_catalog_kit_lines (lines of the kit being saved and their substitutes).
  assert.deepEqual([...sql.matchAll(/delete from (\w+)/gu)].map((match) => match[1]), ["catalog_item_package_items", "catalog_kit_line_substitutes"]);
  assert.match(sql, /drop constraint catalog_item_package_items_unique_child/u, "stejná komponenta smí být v kompletu vícekrát");
  assert.match(sql, /unique \(package_item_id, line_key\)/u);
  assert.match(sql, /set line_key = left\(keyed\.base, 56\)/u, "stávající řádky dostanou line_key z kódu komponenty");
  assert.match(sql, /alter column line_key set not null/u);
});

test("migrace: textové řádky, A14 trigger, varianty se nemažou, RLS a funkce jen pro service_role", async () => {
  const sql = (await migrationSql()).toLowerCase();
  for (const table of ["catalog_variant_sets", "catalog_variants", "catalog_kit_line_substitutes"]) {
    assert.match(sql, new RegExp(`create table ${table} \\(`, "u"));
    assert.match(sql, new RegExp(`alter table ${table} enable row level security`, "u"));
  }
  assert.match(sql, /\(line_kind = 'item'\) = \(child_item_id is not null\)/u);
  assert.match(sql, /line_kind = 'item'\s+or \(btrim\(coalesce\(label, ''\)\) <> '' and included_in_package/u, "textový řádek je vždy v ceně a nemá variantu ani grafiku");
  assert.match(sql, /child_type in \('booth', 'kit'\)/u, "komplet v kompletu je zakázaný");
  assert.match(sql, /catalog_variants_prevent_delete/u);
  assert.match(sql, /revoke all on function replace_catalog_kit_lines\(uuid, jsonb\) from public, anon, authenticated/u);
  assert.match(sql, /grant execute on function replace_catalog_kit_lines\(uuid, jsonb\) to service_role/u);
  assert.doesNotMatch(sql, /difference_floor_zero/u, "A4: záporný rozdíl se nikdy nedobropisuje, žádná výjimka v datech");
});

// =========================================================================================
// BOOTH / KIT CONTENT — save, reopen, edit
// =========================================================================================

test("BOOTH s obsahem kompletu: uloží se, po znovunačtení je obsah stejný a klíče řádků se nemění", async () => {
  const client = kitClient();
  const { packageItems, warnings } = await saveCatalogPackageItems(client as never, "p86", P86_LINES);
  assert.deepEqual(warnings, []);
  assert.deepEqual(packageItems.map((line) => [line.lineKey, line.lineKind, line.childItemId, line.quantity]), [
    ["koberec", "item", "m01", 4],
    ["stavba-stanku", "text", null, 2],
    ["elektro", "item", "l02", 1],
    ["grafika-limec", "item", "grafika-limec", 2],
  ]);
  const reopened = (await readCatalogItemsAdmin(client as never)).find((item) => item.id === "p86")!;
  const electricity = reopened.packageItems!.find((line) => line.lineKey === "elektro")!;
  assert.deepEqual(electricity.substitutes!.map((sub) => [sub.substituteItemId, sub.surchargeRule]), [["l03", "price_difference"], ["l05", "price_difference"]]);
  assert.equal(reopened.packageItems!.find((line) => line.lineKey === "koberec")!.defaultVariantId, "v-seda");
  assert.deepEqual(reopened.packageItems!.find((line) => line.lineKey === "grafika-limec")!.printAllowance, [{ surfaceTypeId: "fascia", printSurfaceIds: ["fascia-print"], unitCode: "bm", includedQuantity: 2 }]);

  // Edit: reorder, change quantity, drop the 5 kW alternative. Line ids and keys survive.
  const electricityId = electricity.id;
  const edited = reopened.packageItems!.map((line) => packageItemToInput(line));
  const [koberec, text, elektro, grafika] = edited;
  const { packageItems: afterEdit } = await saveCatalogPackageItems(client as never, "p86", [
    elektro!,
    { ...koberec!, quantity: 6 },
    text!,
    { ...grafika!, substitutes: undefined },
  ].map((line) => (line.lineKey === "elektro" ? { ...line, substitutes: line.substitutes!.slice(0, 1) } : line)));
  assert.deepEqual(afterEdit.map((line) => line.lineKey), ["elektro", "koberec", "stavba-stanku", "grafika-limec"]);
  assert.equal(afterEdit.find((line) => line.lineKey === "elektro")!.id, electricityId, "řádek zůstává týž (id), mění se jen pořadí");
  assert.equal(afterEdit.find((line) => line.lineKey === "koberec")!.quantity, 6);
  assert.deepEqual(afterEdit.find((line) => line.lineKey === "elektro")!.substitutes!.map((sub) => sub.substituteItemId), ["l03"]);
  assert.ok(client.calls.includes("rpc:replace_catalog_kit_lines"));
});

test("samostatný KIT: lze založit obsah; KIT ani BOOTH nemůže být uvnitř jiného kompletu (A14)", async () => {
  const client = kitClient();
  const { packageItems } = await saveCatalogPackageItems(client as never, "kit-nabytek", [
    { childItemId: "m57", quantity: 4, unitCode: "ks", includedInPackage: true },
    { lineKind: "text", label: "Montáž a doprava", quantity: 1, includedInPackage: true, note: "v ceně balíčku" },
  ]);
  assert.deepEqual(packageItems.map((line) => [line.lineKey, line.childItemId ?? line.label]), [["m57", "m57"], ["montaz-a-doprava", "Montáž a doprava"]]);
  await assert.rejects(() => saveCatalogPackageItems(client as never, "kit-nabytek", [{ childItemId: "p86", quantity: 1, includedInPackage: true }]), /A14/u);
  await assert.rejects(() => saveCatalogPackageItems(client as never, "p86", [{ childItemId: "kit-nabytek", quantity: 1, includedInPackage: true }]), /A14/u);
  await assert.rejects(() => saveCatalogPackageItems(client as never, "m57", [{ childItemId: "m01", quantity: 1, includedInPackage: true }]), /jen u karty typu Stánek nebo Komplet/u);
});

test("stejná komponenta dvakrát: dva samostatné řádky s vlastním klíčem, náhrada se váže k řádku", async () => {
  const client = kitClient();
  const { packageItems, warnings } = await saveCatalogPackageItems(client as never, "p86", [
    { childItemId: "panel", quantity: 2, includedInPackage: true, note: "zadní stěna" },
    { childItemId: "panel", quantity: 1, includedInPackage: true, note: "boční stěna", substitutes: [{ substituteItemId: "m57", surchargeRule: "none", quantityFactor: 1 }] },
  ]);
  assert.deepEqual(packageItems.map((line) => [line.lineKey, line.childItemId, line.quantity]), [["panel-950", "panel", 2], ["panel-950-2", "panel", 1]]);
  assert.equal(packageItems[0]!.substitutes, undefined);
  assert.equal(packageItems[1]!.substitutes!.length, 1);
  assert.deepEqual(warnings, [], "řádky se liší účelem (náhrada) — žádné varování");
  const quantityOnly = validateKitLines("p86", assignKitLineKeys([
    { childItemId: "panel", quantity: 2, includedInPackage: true },
    { childItemId: "panel", quantity: 1, includedInPackage: true },
  ], new Map([["panel", { id: "panel", displayName: "Panel 950" }]])), { itemsById: new Map([["p86", { id: "p86", itemType: "BOOTH" as CatalogItemType }], ["panel", { id: "panel", itemType: "INTERNAL_COMPONENT" as CatalogItemType, displayName: "Panel 950" }]]), variantSets: [] });
  assert.match(quantityOnly[0]!, /liší jen množstvím/u);
});

test("volný textový řádek: vlastní název, množství, jednotka a poznámka; nikdy cena, náhrada, varianta ani grafika (A16)", () => {
  const [parsed] = parseCatalogPackageItemsInput([{ lineKind: "text", label: "Stavba stánku", quantity: 2, unitCode: "m2", note: "systém Octanorm", includedInPackage: false }]);
  assert.equal(parsed!.includedInPackage, true, "textová položka je vždy v ceně kompletu");
  assert.equal(parsed!.childItemId, undefined);
  assert.throws(() => parseCatalogPackageItemsInput([{ lineKind: "text", quantity: 1 }]), /musí mít název/u);
  const itemsById = new Map([["p86", { id: "p86", itemType: "BOOTH" as CatalogItemType }], ["l03", { id: "l03", itemType: "SERVICE" as CatalogItemType }]]);
  assert.throws(
    () => validateKitLines("p86", [{ lineKey: "text", lineKind: "text", label: "Text", quantity: 1, includedInPackage: true, substitutes: [{ substituteItemId: "l03", surchargeRule: "fixed", quantityFactor: 1 }] }], { itemsById, variantSets: [] }),
    /nemůže mít náhrady ani doplatky/u,
  );
  const priced = priceKit({ kitPriceNet: 3640, lines: [{ id: "t", packageItemId: "p86", lineKey: "stavba", lineKind: "text", childItemId: null, label: "Stavba stánku", quantity: 2, includedInPackage: true, sortOrder: 0, note: null }], resolver: { unitPrice: () => ({ priceMode: "fixed", salePrice: 999 }) } });
  assert.deepEqual([priced.lines[0]!.status, priced.lines[0]!.totalNet, priced.totalNet], ["included", 0, 3640]);
  assert.equal(summarizeKitComponents(priced.lines).length, 0, "textové řádky nejsou ve výrobních sumách");
});

// =========================================================================================
// SUBSTITUTES — electricity
// =========================================================================================

/** Fixed TEST prices only — never real ABF amounts. Electricity prices come from the event's electricity price list in V1-DATA-05. */
const TEST_PRICES: Record<string, number> = { l02: 1000, l03: 1500, l05: 2600, m01: 100, m02: 160, l01: 700 };
const testResolver = (surcharges: Record<string, number> = {}): KitPriceResolver => ({
  unitPrice: (itemId) => (TEST_PRICES[itemId] !== undefined ? { priceMode: "fixed", salePrice: TEST_PRICES[itemId] } : undefined),
  surchargeAmount: (ref) => surcharges[ref.kind === "variant" ? ref.variantId : `${ref.lineKey}:${ref.substituteItemId}`],
});

function kitLine(overrides: Partial<CatalogPackageItem> & Pick<CatalogPackageItem, "lineKey">): CatalogPackageItem {
  return { id: `id-${overrides.lineKey}`, packageItemId: "p86", lineKind: "item", childItemId: null, quantity: 1, includedInPackage: true, sortOrder: 0, note: null, ...overrides };
}

const ELECTRICITY_LINE = kitLine({
  lineKey: "elektro",
  childItemId: "l02",
  unitCode: "ks",
  substitutes: [
    { substituteItemId: "l03", surchargeRule: "price_difference", quantityFactor: 1 },
    { substituteItemId: "l05", surchargeRule: "price_difference", quantityFactor: 1 },
    { substituteItemId: "l01", surchargeRule: "price_difference", quantityFactor: 1 },
  ],
});

test("náhrada elektřiny: 2 kW → 5 kW doplatí kladný rozdíl a přípojku NAHRADÍ, nepřidá druhou", () => {
  const result = priceKit({ kitPriceNet: 3640, lines: [ELECTRICITY_LINE], selections: [{ lineKey: "elektro", substituteItemId: "l05" }], resolver: testResolver() });
  assert.equal(result.lines.length, 1, "pořád jedna přípojka");
  const [line] = result.lines;
  assert.deepEqual([line!.originalItemId, line!.effectiveItemId, line!.substituted], ["l02", "l05", true]);
  assert.deepEqual(line!.surcharge, { source: "substitute", rule: "price_difference", amountNet: 1600 });
  assert.equal(result.totalNet, 3640 + 1600);
  assert.deepEqual(summarizeKitComponents(result.lines).map((entry) => [entry.itemId, entry.quantity]), [["l05", 1]]);
  const threeKw = priceKit({ kitPriceNet: 3640, lines: [ELECTRICITY_LINE], selections: [{ lineKey: "elektro", substituteItemId: "l03" }], resolver: testResolver() });
  assert.equal(threeKw.lines[0]!.surcharge!.amountNet, 500);
});

test("náhrada elektřiny se záporným rozdílem: doplatek je nula, žádný dobropis (A4)", () => {
  const result = priceKit({ kitPriceNet: 3640, lines: [ELECTRICITY_LINE], selections: [{ lineKey: "elektro", substituteItemId: "l01" }], resolver: testResolver() });
  assert.deepEqual(result.lines[0]!.surcharge, { source: "substitute", rule: "price_difference", amountNet: 0, reason: "floor_zero" });
  assert.equal(result.totalNet, 3640);
});

test("náhrada: nepovolená volba se ignoruje a nahlásí; chybějící cena nevymyslí částku, komplet potřebuje nacenit", () => {
  const notAllowed = priceKit({ kitPriceNet: 3640, lines: [ELECTRICITY_LINE], selections: [{ lineKey: "elektro", substituteItemId: "l09" }], resolver: testResolver() });
  assert.equal(notAllowed.lines[0]!.effectiveItemId, "l02");
  assert.equal(notAllowed.issues.length, 1);
  const noPrices = priceKit({ kitPriceNet: 3640, lines: [ELECTRICITY_LINE], selections: [{ lineKey: "elektro", substituteItemId: "l05" }], resolver: { unitPrice: () => undefined } });
  assert.deepEqual([noPrices.lines[0]!.status, noPrices.lines[0]!.surcharge!.reason, noPrices.needsQuote, noPrices.totalNet], ["missing", "missing_price", true, 3640]);
  const fixedRule = kitLine({ lineKey: "elektro", childItemId: "l02", substitutes: [{ substituteItemId: "l05", surchargeRule: "fixed", quantityFactor: 1 }] });
  assert.equal(priceKit({ kitPriceNet: 0, lines: [fixedRule], selections: [{ lineKey: "elektro", substituteItemId: "l05" }], resolver: testResolver({ "elektro:l05": 1200 }) }).totalNet, 1200);
});

// =========================================================================================
// CARPET VARIANTS
// =========================================================================================

test("koberec: barvy sdílející M02 mají rozdílný příplatek za m²; černá účtuje rozdíl M02 − M01; šedá je v ceně", async () => {
  const sets = await readCatalogVariantSets(kitClient() as never);
  const carpet = kitLine({ lineKey: "koberec", childItemId: "m01", quantity: 4, unitCode: "m2", variantSetId: "set-koberce", defaultVariantId: "v-seda" });
  const resolver = testResolver({ "v-cervena": 45, "v-modra": 30 });
  const price = (variantId?: string) => priceKit({ kitPriceNet: 3640, lines: [carpet], variantSets: sets, selections: variantId ? [{ lineKey: "koberec", variantId }] : [], resolver });
  assert.equal(price().totalNet, 3640, "výchozí šedá je v ceně kóje");
  assert.equal(price().lines[0]!.variantId, "v-seda");
  const red = price("v-cervena");
  const blue = price("v-modra");
  assert.deepEqual([red.lines[0]!.surcharge!.amountNet, blue.lines[0]!.surcharge!.amountNet], [180, 120], "4 m² × 45 Kč vs. 4 m² × 30 Kč");
  assert.equal(sets[0]!.variants.find((variant) => variant.id === "v-cervena")!.priceItemId, sets[0]!.variants.find((variant) => variant.id === "v-modra")!.priceItemId, "obě barvy jsou ABF M02");
  assert.equal(price("v-cerna").lines[0]!.surcharge!.amountNet, 240, "(160 − 100) × 4 m²");
  const missing = priceKit({ kitPriceNet: 3640, lines: [carpet], variantSets: sets, selections: [{ lineKey: "koberec", variantId: "v-modra" }], resolver: testResolver() });
  assert.equal(missing.needsQuote, true, "příplatek bez ceny se nevymyslí");
  const wrongUnit = priceKit({ kitPriceNet: 0, lines: [{ ...carpet, unitCode: "bm" }], variantSets: sets, selections: [{ lineKey: "koberec", variantId: "v-modra" }], resolver });
  assert.equal(wrongUnit.lines[0]!.surcharge!.reason, "unit_mismatch");
});

test("koberec: starší carpetFinishId projektu najde variantu vzorníku (kompatibilita)", async () => {
  const sets = await readCatalogVariantSets(kitClient() as never);
  for (const finish of carpetFinishVariants.filter((candidate) => candidate.swatchColor)) {
    assert.ok(variantForLegacyFinish(sets, finish.id), `${finish.id} má variantu`);
  }
  assert.equal(variantForLegacyFinish(sets, "carpet-grey")!.code, "SEDA");
  assert.equal(variantForLegacyFinish(sets, "none"), undefined);
});

test("vzorník: uloží se nový i upravený; variantu nelze odebrat, kód barvy ani starší ID se nesmí opakovat", async () => {
  const client = kitClient();
  const created = await saveCatalogVariantSet(client as never, parseCatalogVariantSetInput({ code: "barvy stěn", name: "Barvy stěn", kind: "color", variants: [{ code: "bílá", name: "Bílá", swatchColor: "#ffffff" }] }));
  assert.equal(created.code, "BARVY-STEN");
  assert.deepEqual(created.variants.map((variant) => variant.code), ["BILA"]);
  const sets = await readCatalogVariantSets(client as never);
  const carpet = sets.find((set) => set.code === "KOBERCE-2026")!;
  const withoutRed = { ...parseCatalogVariantSetInput({ ...carpet, variants: carpet.variants.filter((variant) => variant.code !== "CERVENA") }) };
  await assert.rejects(() => saveCatalogVariantSet(client as never, withoutRed), /nelze odebrat, lze ji jen deaktivovat/u);
  const deactivated = await saveCatalogVariantSet(client as never, parseCatalogVariantSetInput({ ...carpet, variants: carpet.variants.map((variant) => (variant.code === "CERVENA" ? { ...variant, isActive: false } : variant)) }));
  assert.equal(deactivated.variants.find((variant) => variant.code === "CERVENA")!.isActive, false);
  assert.throws(() => parseCatalogVariantSetInput({ code: "X", name: "X", variants: [{ code: "A", name: "A", legacyFinishId: "carpet-grey" }, { code: "A", name: "B", legacyFinishId: "carpet-grey" }] }), InvalidCatalogVariantSetError);
  assert.throws(() => parseCatalogVariantSetInput({ code: "X", name: "X", variants: [{ code: "A", name: "A", surchargeRule: "per_unit" }] }), /potřebuje jednotku/u);
  assert.deepEqual(validateCatalogVariantSet(parseCatalogVariantSetInput({ code: "KOBERCE-2026", name: "Duplicita" }), { sets, knownItemIds: new Set() }), ["Kód vzorníku KOBERCE-2026 už používá jiný vzorník."]);
});

// =========================================================================================
// INCLUDED GRAPHICS (A17)
// =========================================================================================

test("grafika v ceně P86: 2 bm límce zahrnuto, nad rozsah se účtuje jen přesah", () => {
  const allowances = [{ lineKey: "grafika-limec", surfaceTypeId: "fascia" as const, unitCode: "bm" as const, includedQuantity: 2 }];
  const exact = allocateKitPrintAllowance(allowances, [{ surfaceId: "a", typeId: "fascia", unitCode: "bm", quantity: 2 }]);
  assert.deepEqual(exact.surfaces.map((surface) => [surface.status, surface.includedQuantity, surface.chargedQuantity]), [["included_in_kit", 2, 0]]);
  const over = allocateKitPrintAllowance(allowances, [{ surfaceId: "a", typeId: "fascia", unitCode: "bm", quantity: 3.5 }]);
  assert.deepEqual(over.surfaces.map((surface) => [surface.status, surface.includedQuantity, surface.chargedQuantity, surface.lineKeys]), [["kit_overflow", 2, 1.5, ["grafika-limec"]]]);
  assert.deepEqual(over.buckets.map((bucket) => [bucket.usedQuantity, bucket.remainingQuantity]), [[2, 0]]);
  const two = allocateKitPrintAllowance(allowances, [
    { surfaceId: "a", typeId: "fascia", unitCode: "bm", quantity: 1.5 },
    { surfaceId: "b", typeId: "fascia", unitCode: "bm", quantity: 1.5 },
  ]);
  assert.deepEqual(two.surfaces.map((surface) => [surface.includedQuantity, surface.chargedQuantity]), [[1.5, 0], [0.5, 1]]);
});

test("grafika: různé typy ploch a jednotky se nikdy neodečítají; jedna plocha na více vizualizacích se počítá jednou", () => {
  const allowances = [{ lineKey: "grafika-limec", surfaceTypeId: "fascia" as const, unitCode: "bm" as const, includedQuantity: 2 }];
  const mixed = allocateKitPrintAllowance(allowances, [
    { surfaceId: "panel-1", typeId: "panel", unitCode: "m2", quantity: 2.4 },
    { surfaceId: "custom-bm", typeId: "custom", unitCode: "bm", quantity: 1 },
    { surfaceId: "limec", typeId: "fascia", unitCode: "bm", quantity: 1 },
  ]);
  assert.deepEqual(mixed.surfaces.map((surface) => [surface.surfaceId, surface.status, surface.chargedQuantity]), [["panel-1", "charged", 2.4], ["custom-bm", "charged", 1], ["limec", "included_in_kit", 0]]);
  assert.deepEqual([...chargedQuantityByTypeAndUnit(mixed)], [["panel|m2", 2.4], ["custom|bm", 1]]);

  // Tiskové plochy: one physical item pinned on three views is ONE usage (items, never placements).
  const items = [{ id: "item-a", typeId: "fascia" as const, quantity: 1 }, { id: "item-b", typeId: "panel" as const, quantity: 2 }];
  const sizes: Record<string, { widthMm: number; heightMm: number }> = { "item-a": { widthMm: 3000, heightMm: 300 }, "item-b": { widthMm: 1000, heightMm: 2500 } };
  const { usages, unresolved } = usagesFromPrintSurfaceItems(items, (id) => sizes[id]);
  assert.deepEqual(usages.map((usage) => [usage.surfaceId, usage.unitCode, usage.quantity]), [["item-a", "bm", 3], ["item-b", "m2", 5]]);
  assert.deepEqual(unresolved, []);
  const pinnedThreeTimes = allocateKitPrintAllowance(allowances, [usages[0]!, usages[0]!, usages[0]!, usages[1]!]);
  assert.equal(pinnedThreeTimes.duplicateUsagesIgnored, 2);
  assert.deepEqual(pinnedThreeTimes.surfaces.map((surface) => [surface.surfaceId, surface.includedQuantity, surface.chargedQuantity]), [["item-a", 2, 1], ["item-b", 0, 5]]);
  assert.deepEqual(kitPrintAllowanceIssues([{ unitCode: "bm", includedQuantity: 2 }]), ["Grafika 1: vyberte typ tiskové plochy nebo konkrétní plochu."]);
});

test("grafika: dnešní P86 print-allowance dává stejný výsledek jako boothIncludesPrintSurface (existující projekty)", () => {
  const p86 = boothTypes.find((booth) => booth.internalCode === "P86")!;
  const legacy = legacyKitPrintAllowances(p86);
  assert.deepEqual(legacy, [{ lineKey: "p86-fascia-print", printSurfaceIds: ["fascia-print"], unitCode: "bm", includedQuantity: 2 }]);
  const assignments = computePrintSurfaceAssignments(p86, "default", []);
  const allocation = allocateKitPrintAllowance(legacy, usagesFromBoothAssignments(p86, assignments));
  for (const surface of allocation.surfaces) {
    assert.equal(surface.status === "included_in_kit", boothIncludesPrintSurface(p86, surface.surfaceId), `${surface.surfaceId}: stejné zařazení jako dosud`);
  }
  assert.ok(allocation.surfaces.some((surface) => surface.surfaceId === "fascia-print" && surface.status === "included_in_kit"));
});

// =========================================================================================
// ARCHIVAL, TYPE CHANGES, LEGACY ROWS
// =========================================================================================

test("archivace komponenty: komplet ji dál drží, uloží se znovu a náhrady zůstanou", async () => {
  const client = kitClient();
  await saveCatalogPackageItems(client as never, "p86", P86_LINES);
  const archived = await saveCatalogItemAdmin(client as never, "l05", { lifecycleStatus: "archived" }, null);
  assert.equal(archived.lifecycleStatus, "archived");
  const p86 = (await readCatalogItemsAdmin(client as never)).find((item) => item.id === "p86")!;
  assert.deepEqual(p86.packageItems!.find((line) => line.lineKey === "elektro")!.substitutes!.map((sub) => sub.substituteItemId), ["l03", "l05"]);
  const { packageItems } = await saveCatalogPackageItems(client as never, "p86", p86.packageItems!.map((line) => packageItemToInput(line)));
  assert.equal(packageItems.length, 4, "uložení s archivovanou alternativou projde, nic se neztratí");
});

test("změna typu karty nesmí porušit komplety: komponenta v kompletu se nestane kompletem, komplet s obsahem zůstane BOOTH/KIT", async () => {
  const client = kitClient();
  await saveCatalogPackageItems(client as never, "p86", P86_LINES);
  const links = (await readCatalogItemsAdmin(client as never)).flatMap((item) => item.packageItems ?? []);
  assert.match(kitTypeChangeIssue("l03", "KIT", links)!, /A14/u, "l03 je náhradou v kompletu");
  assert.match(kitTypeChangeIssue("p86", "PRODUCT", links)!, /obsah kompletu/u);
  assert.equal(kitTypeChangeIssue("p86", "KIT", links), undefined);
  await assert.rejects(() => saveCatalogItemAdmin(client as never, "m01", { itemType: "KIT" }, null), /A14|Aktivní položce/u);
});

test("kopie karty: obsah kompletu se zkopíruje včetně klíčů, textových řádků a náhrad", async () => {
  const client = kitClient();
  await saveCatalogPackageItems(client as never, "p86", P86_LINES);
  const copy = await duplicateCatalogItemAdmin(client as never, "p86");
  assert.deepEqual(copy.packageItems!.map((line) => line.lineKey), ["koberec", "stavba-stanku", "elektro", "grafika-limec"]);
  assert.equal(copy.packageItems!.find((line) => line.lineKey === "elektro")!.substitutes!.length, 2);
});

test("existující data: řádek bez line_key (před migrací) dostane stabilní klíč při čtení; DB bez migrace uloží jen to, co umí", async () => {
  const client = createKitClient({ catalog_items: CATALOG, catalog_item_package_items: [{ id: "8f3a2c10-aaaa", package_item_id: "p86", child_item_id: "m57", quantity: 2, included_in_package: true, sort_order: 0, note: null }] });
  const [line] = (await readCatalogItemsAdmin(client as never)).find((item) => item.id === "p86")!.packageItems!;
  assert.equal(line!.lineKey, `polozka-${slugifyLineKey("8f3a2c10-aaaa").slice(0, 8)}`);
  assert.equal(line!.lineKind, "item");
  assert.ok(isLegacyCompatibleKit(assignKitLineKeys([{ childItemId: "m57", quantity: 2, includedInPackage: true }], new Map())));
  assert.ok(!isLegacyCompatibleKit(assignKitLineKeys([{ childItemId: "m57", quantity: 1, includedInPackage: true }, { childItemId: "m57", quantity: 1, includedInPackage: true }], new Map())));
  const noRpc = { ...kitClient(), rpc: async () => ({ data: null, error: { code: "PGRST202" } }) };
  await assert.rejects(() => saveCatalogPackageItems(noRpc as never, "p86", P86_LINES), CatalogSchemaNotMigratedError);
});

test("payload funkce replace_catalog_kit_lines: textový řádek bez komponenty a vždy v ceně, náhrady jen u komponent", () => {
  const payload = buildKitLinesRpcPayload(assignKitLineKeys(P86_LINES, new Map()));
  assert.deepEqual(payload.map((line) => [line.line_key, line.line_kind, line.child_item_id, line.included_in_package]), [
    ["koberec", "item", "m01", true],
    ["stavba-stanku", "text", null, true],
    ["elektro", "item", "l02", true],
    ["grafika-limec", "item", "grafika-limec", true],
  ]);
  assert.equal((payload[2]!.substitutes as unknown[]).length, 2);
  assert.deepEqual(payload[1]!.substitutes, []);
});

// =========================================================================================
// CUSTOMER CATALOG — KIT published manually, contents never priced
// =========================================================================================

function adminItem(id: string, itemType: CatalogItemType, name: string, extra: Partial<CatalogItemAdmin> = {}, visible = true): CatalogItemAdmin {
  return {
    id,
    internalCode: null,
    abfCode: null,
    itemType,
    kind: itemType === "KIT" ? "other" : itemType === "INTERNAL_COMPONENT" ? "booth_component" : itemType === "SERVICE" ? "service" : "furniture",
    lifecycleStatus: "active",
    displayName: name,
    officialName: null,
    category: "Nábytek",
    unit: "ks",
    document: { catalogPublication: { visible } },
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...extra,
  };
}

test("zákaznický katalog: KIT jde publikovat ručně, sám se nezveřejní; obsah je vidět bez vlastních cen a bez interních komponent", () => {
  const lines: CatalogPackageItem[] = [
    kitLine({ lineKey: "zidle", packageItemId: "kit", childItemId: "chair", quantity: 4, unitCode: "ks" }),
    kitLine({ lineKey: "panel", packageItemId: "kit", childItemId: "panel", quantity: 2, sortOrder: 1 }),
    kitLine({ lineKey: "montaz", packageItemId: "kit", lineKind: "text", label: "Montáž", quantity: 1, sortOrder: 2 }),
    kitLine({ lineKey: "stul", packageItemId: "kit", childItemId: "table", quantity: 1, includedInPackage: false, sortOrder: 3 }),
  ];
  const kit = adminItem("kit", "KIT", "Balíček nábytku", { packageItems: lines });
  const hiddenKit = adminItem("kit-hidden", "KIT", "Nezveřejněný komplet", {}, false);
  const items = [kit, hiddenKit, adminItem("chair", "PRODUCT", "Židle"), adminItem("panel", "INTERNAL_COMPONENT", "Panel 950"), adminItem("table", "PRODUCT", "Stůl")];
  assert.ok(canPublishInCustomerCatalog(kit));
  assert.ok(!isPublishedInCustomerCatalog(hiddenKit), "bez ručního zapnutí se KIT nezobrazí");
  assert.ok(!canPublishInCustomerCatalog(items[3]!), "interní komponenta nikdy");
  const entries = buildCustomerCatalogEntries(items, {
    event: undefined,
    priceList: { id: "pl", currency: "CZK", realizationCompanyId: undefined },
    currency: "CZK",
    entries: [
      { id: "1", catalogItemId: "kit", priceListId: "pl", eventId: null, realizationCompanyId: null, currency: "CZK", salePrice: 5900, priceMode: "fixed" },
      { id: "2", catalogItemId: "chair", priceListId: "pl", eventId: null, realizationCompanyId: null, currency: "CZK", salePrice: 300, priceMode: "fixed" },
    ],
  });
  const kitEntry = entries.find((entry) => entry.id === "kit")!;
  assert.equal(entries.some((entry) => entry.id === "kit-hidden"), false);
  assert.deepEqual(kitEntry.packageContents, [
    { childItemId: "chair", name: "Židle", quantity: 4, unit: "ks" },
    { childItemId: null, name: "Montáž", quantity: 1, unit: null },
  ]);
  const card = buildCustomerCatalogCard(kitEntry, DEFAULT_CUSTOMER_CATALOG_EXPORT_OPTIONS);
  assert.equal(card.layout, "booth");
  assert.deepEqual(card.contents, ["4× Židle", "Montáž"]);
  assert.equal(card.priceLabel!.replace(/\s/gu, " "), "5 900 Kč bez DPH", "jediná prodejní cena je cena kompletu");
  assert.ok(!card.contents.some((line) => /Kč/u.test(line)), "obsah kompletu nevytváří další prodejní cenu");
});

// =========================================================================================
// API
// =========================================================================================

test("POST /api/catalog-admin/items/package vrací varování; chyby validace se vrací všechny", async () => {
  const token = await createSessionToken(SECRET);
  const ok = await handleCatalogAdminPackageSave(
    request("http://localhost/api/catalog-admin/items/package", { token, body: { packageItemId: "p86", items: [{ childItemId: "m57", quantity: 1 }] } }),
    async () => ({ packageItems: [], warnings: ["Řádky 1, 2 se liší jen množstvím."] }),
  );
  assert.equal(ok.status, 200);
  assert.deepEqual((await ok.json()).warnings, ["Řádky 1, 2 se liší jen množstvím."]);
  const invalid = await handleCatalogAdminPackageSave(
    request("http://localhost/api/catalog-admin/items/package", { token, body: { packageItemId: "p86", items: [{ childItemId: "m57", quantity: 1 }] } }),
    async () => { throw new InvalidCatalogPackageError("Řádek 1: chyba", ["Řádek 1: chyba", "Řádek 2: chyba"]); },
  );
  assert.equal(invalid.status, 400);
  assert.deepEqual((await invalid.json()).issues, ["Řádek 1: chyba", "Řádek 2: chyba"]);
});

test("/api/catalog-admin/variant-sets: bez přihlášení 401, neplatný vzorník 400, uložení vrací vzorník", async () => {
  const sets: CatalogVariantSet[] = [];
  const dependencies = { readSets: async () => sets, saveSet: async (input: Parameters<typeof validateCatalogVariantSet>[0]) => ({ id: "new", ...input, isActive: true, variants: [] }) as CatalogVariantSet };
  assert.equal((await handleCatalogVariantSetsGet(request("http://localhost/api/catalog-admin/variant-sets", { method: "GET" }), dependencies)).status, 401);
  const token = await createSessionToken(SECRET);
  assert.equal((await handleCatalogVariantSetsGet(request("http://localhost/api/catalog-admin/variant-sets", { method: "GET", token }), dependencies)).status, 200);
  assert.equal((await handleCatalogVariantSetSave(request("http://localhost/api/catalog-admin/variant-sets", { token, body: { variantSet: { code: "", name: "" } } }), dependencies)).status, 400);
  const saved = await handleCatalogVariantSetSave(request("http://localhost/api/catalog-admin/variant-sets", { token, body: { variantSet: { code: "KOBERCE-2026", name: "Koberce" } } }), dependencies);
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).variantSet.code, "KOBERCE-2026");
});
