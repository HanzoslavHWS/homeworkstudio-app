import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { createSessionToken } from "../lib/auth/session.ts";
import { CATALOG_UNITS, catalogUnitLabel, normalizeCatalogUnit } from "../domain/catalogUnits.ts";
import {
  abfCodeWarning,
  assertNoCrossCodeCollision,
  assertUniqueAbfCode,
  CATALOG_ITEM_KINDS_BY_TYPE,
  CrossCodeCollisionError,
  defaultItemTypeForKind,
  DuplicateAbfCodeError,
  itemTypeExpectsAbfCode,
  normalizeAbfCode,
  normalizeInternalCode,
} from "../domain/catalogItemTypes.ts";
import { CATALOG_FIELDS_BY_TYPE, CATALOG_SHEET_BY_TYPE, catalogTypeHasField, validateCatalogIdentity } from "../domain/catalogItemFields.ts";
import {
  applyCatalogItemEdit,
  buildCatalogItemCreateDocument,
  InvalidCatalogItemAdminCreateInputError,
  InvalidCatalogItemAdminEditError,
  parseCatalogItemAdminCreateInput,
  parseCatalogItemAdminEdit,
  resolveTypeAndKindEdit,
} from "../domain/catalogItemsAdmin.ts";
import { assertUniqueInternalCode, DuplicateInternalCodeError } from "../domain/catalogReadiness.ts";
import {
  normalizeCatalogAliasText,
  parseCatalogItemAliasInputs,
  planCatalogItemAliasChanges,
  validateCatalogItemAliases,
  type CatalogItemAlias,
} from "../domain/catalogItemAliases.ts";
import { withCatalogAliases } from "../domain/settlementService.ts";
import { CUSTOMER_CATALOG_ITEM_TYPES } from "../domain/customerCatalog.ts";
import { CATALOG_ITEM_TYPES } from "../domain/models.ts";
import { handleCatalogAliasesGet, handleCatalogAliasesSave } from "../app/api/catalog-admin/items/aliases/route.ts";
import { InvalidCatalogAliasesError } from "../domain/catalogItemAliases.ts";

// =========================================================================================
// V1-DATA-03 — final identity of catalog items: units, codes, item types incl. KIT, fields per
// type (Excel-ready), aliases per realization company, settlement use of aliases, migration.
// =========================================================================================

const SECRET = "catalog-identity-test-session-secret-0032";
(process.env as Record<string, string | undefined>).APP_SESSION_SECRET = SECRET;
const MIGRATION = "supabase/migrations/20261021120000_catalog_identity.sql";

async function migrationSql(): Promise<string> {
  const sql = await readFile(new URL(`../${MIGRATION}`, import.meta.url), "utf8");
  return sql.split("\n").map((line) => line.replace(/--.*$/u, "")).join("\n");
}

// ---------------------------------------------------------------------------
// units
// ---------------------------------------------------------------------------

test("jednotky: bezpečné ekvivalenty se sjednotí (m2/m², ks/kus, bm/b.m., m3/m³, paušál/pausal, den/dny)", () => {
  const cases: readonly [string, string][] = [
    ["m2", "m2"], ["m²", "m2"], ["M 2", "m2"], ["ks", "ks"], ["kus", "ks"], ["Kusy.", "ks"], ["pcs", "ks"],
    ["bm", "bm"], ["b. m.", "bm"], ["m3", "m3"], ["m³", "m3"], ["paušál", "pausal"], ["pausal", "pausal"], ["den", "den"], ["dny", "den"],
  ];
  for (const [raw, code] of cases) {
    const result = normalizeCatalogUnit(raw);
    assert.equal(result.status === "known" && result.code, code, raw);
  }
  assert.equal(catalogUnitLabel("m2", "m2"), "m²");
  assert.equal(catalogUnitLabel(null, "ks/den"), "ks/den", "nepřevedená jednotka zůstává jako původní text");
});

test("jednotky: kombinované (ks/d, m2/ak, m²/den) se neslučují se základní jednotkou, neznámé (m, mm) se nehádají", () => {
  for (const raw of ["ks/d", "m2/ak", "m²/den", "ks / den"]) assert.equal(normalizeCatalogUnit(raw).status, "combined", raw);
  for (const raw of ["m", "mm", "Chybí jednotka"]) assert.equal(normalizeCatalogUnit(raw).status, "unknown", raw);
  assert.equal(normalizeCatalogUnit("  ").status, "empty");
});

test("jednotky: číselník v doméně odpovídá seedu migrace (kódy, symboly i aliasy)", async () => {
  const sql = await migrationSql();
  for (const unit of CATALOG_UNITS) {
    const aliases = unit.aliases.map((alias) => `'${alias}'`).join(", ");
    assert.ok(sql.includes(`('${unit.code}', '${unit.symbol}', '${unit.nameCs}', '${unit.nameEn}', '${unit.quantityKind}', array[${aliases}]`), unit.code);
  }
  for (const code of ["ks", "m2", "bm", "m3", "den", "pausal"]) assert.ok(CATALOG_UNITS.some((unit) => unit.code === code), code);
});

// ---------------------------------------------------------------------------
// codes
// ---------------------------------------------------------------------------

test("kódy: shodný ABF a generátorový kód je povolený, cizí ABF kód jako generátorový kód ne (a naopak)", () => {
  const items = [
    { id: "a", internalCode: "M57", abfCode: "M57", displayName: "Židle" },
    { id: "b", internalCode: "INT-PANEL-950", abfCode: null, displayName: "Panel" },
  ];
  assert.doesNotThrow(() => assertNoCrossCodeCollision(items, { internalCode: "M57", abfCode: "M57" }, "a"), "vlastní shodné kódy");
  assert.doesNotThrow(() => assertNoCrossCodeCollision(items, { internalCode: "HWS-STUL-01", abfCode: "S10" }), "rozdílné kódy");
  assert.throws(() => assertNoCrossCodeCollision(items, { internalCode: "m57" }), CrossCodeCollisionError);
  assert.throws(() => assertNoCrossCodeCollision(items, { abfCode: "INT-PANEL-950" }), CrossCodeCollisionError);
});

test("kódy: duplicitní ABF i generátorový kód (bez ohledu na velikost písmen) a neplatné znaky jsou odmítnuty", () => {
  assert.throws(() => assertUniqueAbfCode([{ id: "a", abfCode: "M57" }], "m57"), DuplicateAbfCodeError);
  assert.throws(() => assertUniqueInternalCode([{ internalCode: "INT-PANEL-950" }], "int-panel-950"), DuplicateInternalCodeError);
  for (const bad of ["M 57", "M57\"", "<M57>", "-M57", "M57;"]) assert.equal(normalizeAbfCode(bad), null, bad);
  for (const bad of ["INT PANEL", "INT'1", "a".repeat(65)]) assert.equal(normalizeInternalCode(bad), null, bad);
  assert.equal(normalizeAbfCode(" m8a "), "M8A");
  assert.equal(normalizeInternalCode("INT-SLOUPEK-2500"), "INT-SLOUPEK-2500");
  assert.equal(abfCodeWarning("M57"), undefined);
  assert.match(abfCodeWarning("GRAPHICS-FASCIA")!, /nemá standardní tvar/u);
});

test("interní komponenta: bez ABF kódu, ABF kód se nikdy negeneruje", () => {
  const input = parseCatalogItemAdminCreateInput({ itemType: "INTERNAL_COMPONENT", displayName: "Sloupek 2500", category: "construction", internalCode: "INT-SLOUPEK-2500" });
  assert.equal(input.abfCode, undefined);
  assert.equal(input.internalCode, "INT-SLOUPEK-2500");
  assert.equal(itemTypeExpectsAbfCode("INTERNAL_COMPONENT"), false);
  assert.equal(validateCatalogIdentity("INTERNAL_COMPONENT", { displayName: "Sloupek", category: "construction" }, "create").length, 0);
});

// ---------------------------------------------------------------------------
// item types incl. KIT, create/edit of all five
// ---------------------------------------------------------------------------

test("typy: všech pět typů lze založit; KIT má vlastní typ, BOOTH zůstává stánkem", () => {
  assert.deepEqual([...CATALOG_ITEM_TYPES], ["PRODUCT", "SERVICE", "BOOTH", "INTERNAL_COMPONENT", "KIT"]);
  const created = CATALOG_ITEM_TYPES.map((itemType) => parseCatalogItemAdminCreateInput({ itemType, displayName: `Test ${itemType}`, category: "other", unitCode: "ks" }));
  assert.deepEqual(created.map((input) => [input.itemType, input.kind]), [
    ["PRODUCT", "furniture"], ["SERVICE", "service"], ["BOOTH", "booth"], ["INTERNAL_COMPONENT", "booth_component"], ["KIT", "other"],
  ]);
  assert.deepEqual(CATALOG_ITEM_KINDS_BY_TYPE.BOOTH, ["booth"], "BOOTH se nepřevádí na KIT");
  assert.equal(defaultItemTypeForKind("other"), "PRODUCT", "mapování kind → typ pro starší zápisy beze změny");
  // V1-DATA-04: KIT is published manually like any product (tests/catalogKits.test.ts); INTERNAL_COMPONENT never.
  assert.ok(!(CUSTOMER_CATALOG_ITEM_TYPES as readonly string[]).includes("INTERNAL_COMPONENT"), "interní komponenta se zákazníkovi nikdy nenabízí");
});

test("založení: oficiální názvy CZ/EN, jednotka z číselníku a parametry se uloží; kombinovaná jednotka je odmítnuta", () => {
  const input = parseCatalogItemAdminCreateInput({
    itemType: "PRODUCT", displayName: "Židle černá", category: "furniture", abfCode: "m57", internalCode: "M57",
    officialName: "ŽIDLE KOVOVÁ ČALOUNĚNÁ", officialNameEn: "UPHOLSTERED METAL CHAIR", unitCode: "kus", attributes: { color: "černá", material: "kov", extra: [{ key: "Výška sedáku", value: "45 cm" }, { key: "", value: "x" }] },
  });
  assert.equal(input.abfCode, "M57");
  assert.equal(input.unitCode, "ks");
  assert.equal(input.unit, "ks");
  assert.equal(input.officialNameEn, "UPHOLSTERED METAL CHAIR");
  const document = buildCatalogItemCreateDocument(input);
  assert.deepEqual(document.attributes, { color: "černá", material: "kov", extra: [{ key: "Výška sedáku", value: "45 cm" }] });
  assert.throws(() => parseCatalogItemAdminCreateInput({ itemType: "SERVICE", displayName: "Pronájem", category: "service", unitCode: "ks/d" }), InvalidCatalogItemAdminCreateInputError);
});

test("úprava: jednotka, oficiální názvy a parametry; ostatní obsah dokumentu zůstává beze změny", () => {
  const edit = parseCatalogItemAdminEdit({ unitCode: "m²", officialName: "  KOBEREC  ", officialNameEn: "", attributes: { color: "šedá" }, unknownKey: "ignored" });
  assert.deepEqual(edit, { officialName: "KOBEREC", officialNameEn: null, unitCode: "m2", attributes: { color: "šedá" } });
  const next = applyCatalogItemEdit({ unit: "m2", parts: [{ id: "p1" }], pricingEntries: [{ id: "x" }], attributes: { material: "x" } }, edit);
  assert.equal(next.unit, "m²");
  assert.deepEqual(next.attributes, { color: "šedá" });
  assert.deepEqual(next.parts, [{ id: "p1" }]);
  assert.deepEqual(next.pricingEntries, [{ id: "x" }]);
  const cleared = applyCatalogItemEdit({ unit: "ks", attributes: { color: "x" } }, parseCatalogItemAdminEdit({ unitCode: null, attributes: null }));
  assert.equal("unit" in cleared, false);
  assert.equal("attributes" in cleared, false);
  assert.throws(() => parseCatalogItemAdminEdit({ unitCode: "m2/ak" }), InvalidCatalogItemAdminEditError);
});

test("typ KIT: změna typu u neaktivní karty převede druh na 'other'; aktivní kartě typ změnit nelze", () => {
  assert.deepEqual(resolveTypeAndKindEdit({ itemType: "PRODUCT", kind: "furniture", lifecycleStatus: "needs_review" }, { itemType: "KIT" }), { itemType: "KIT", kind: "other" });
  assert.throws(() => resolveTypeAndKindEdit({ itemType: "PRODUCT", kind: "furniture", lifecycleStatus: "active" }, { itemType: "KIT" }), InvalidCatalogItemAdminEditError);
});

test("pole podle typu (příprava Excelu): samostatný list pro každý typ, prázdná nepovinná pole nic neblokují", () => {
  for (const itemType of CATALOG_ITEM_TYPES) {
    assert.ok(CATALOG_SHEET_BY_TYPE[itemType], itemType);
    assert.deepEqual(CATALOG_FIELDS_BY_TYPE[itemType].filter((field) => field.required).map((field) => field.key), ["display_name", "category"], itemType);
  }
  assert.equal(catalogTypeHasField("SERVICE", "width_mm"), false);
  assert.equal(catalogTypeHasField("PRODUCT", "material"), true);
  assert.deepEqual(validateCatalogIdentity("PRODUCT", {}, "update"), [], "update: prázdné = beze změny");
  assert.deepEqual(validateCatalogIdentity("PRODUCT", { displayName: "x", category: "furniture" }, "create"), []);
  assert.deepEqual(validateCatalogIdentity("SERVICE", {}, "create").map((issue) => issue.field), ["display_name", "category"]);
  const issues = validateCatalogIdentity("PRODUCT", { abfCode: "GRAPHICS-FASCIA", internalCode: "A B", unitCode: "ks/d", widthMm: -5 }, "update");
  assert.deepEqual(issues.map((issue) => [issue.field, issue.severity]), [["internal_code", "error"], ["abf_code", "warning"], ["unit_code", "error"], ["width_mm", "error"]]);
});

// ---------------------------------------------------------------------------
// aliases
// ---------------------------------------------------------------------------

function alias(partial: Partial<CatalogItemAlias> & Pick<CatalogItemAlias, "id" | "catalogItemId" | "aliasText">): CatalogItemAlias {
  const aliasKind = partial.aliasKind ?? "name";
  return { aliasKind, normalizedText: normalizeCatalogAliasText(aliasKind, partial.aliasText), source: "manual", status: "confirmed", isActive: true, ...partial };
}

const COMPANIES = new Set(["creativ-expo", "gendai"]);

test("aliasy: normalizace názvů (bez diakritiky, malá písmena) a kódů (velká písmena, bez mezer)", () => {
  assert.equal(normalizeCatalogAliasText("name", "  Židle   ČALOUNĚNÁ "), "zidle calounena");
  assert.equal(normalizeCatalogAliasText("code", " cr-zid 01 "), "CR-ZID01");
});

test("aliasy: více názvů i kódů pro jednu realizačku; stejný text u různých firem vede na různé položky", () => {
  const existing = [alias({ id: "x1", catalogItemId: "stool", realizationCompanyId: "gendai", aliasText: "Židle čalouněná" })];
  const inputs = parseCatalogItemAliasInputs([
    { realizationCompanyId: "creativ-expo", aliasKind: "name", aliasText: "Židle čalouněná" },
    { realizationCompanyId: "creativ-expo", aliasKind: "name", aliasText: "Židle černá" },
    { realizationCompanyId: "creativ-expo", aliasKind: "code", aliasText: "cr-zid-01" },
    { aliasKind: "name", aliasText: "Konferenční židle" },
  ]);
  assert.deepEqual(validateCatalogItemAliases("chair", inputs, { aliases: existing, companyIds: COMPANIES }), []);
});

test("aliasy: stejný text u stejné firmy pro jinou položku, duplicita na kartě, neznámá firma a jednotka jsou chyby", () => {
  const existing = [
    alias({ id: "x1", catalogItemId: "stool", realizationCompanyId: "gendai", aliasText: "Židle čalouněná" }),
    alias({ id: "x2", catalogItemId: "stool", aliasText: "Barová židle" }),
    alias({ id: "x3", catalogItemId: "stool", realizationCompanyId: "gendai", aliasText: "Stará židle", isActive: false }),
  ];
  const issues = validateCatalogItemAliases("chair", parseCatalogItemAliasInputs([
    { realizationCompanyId: "gendai", aliasKind: "name", aliasText: "ZIDLE calounena" },
    { aliasKind: "name", aliasText: "barová  židle" },
    { realizationCompanyId: "neexistuje", aliasKind: "name", aliasText: "x" },
    { realizationCompanyId: "gendai", aliasKind: "name", aliasText: "Stará židle" },
    { realizationCompanyId: "gendai", aliasKind: "name", aliasText: "stara zidle" },
    { aliasKind: "code", aliasText: "A1", unitCode: "ks/d" },
    { aliasKind: "name", aliasText: "   " },
  ]), { aliases: existing, companyIds: COMPANIES, itemNameById: new Map([["stool", "Barová stolička"]]) });
  assert.deepEqual(issues.map((issue) => [issue.index, issue.code]), [[0, "TAKEN"], [1, "TAKEN"], [2, "UNKNOWN_COMPANY"], [4, "DUPLICATE_ON_CARD"], [5, "UNKNOWN_UNIT"], [6, "EMPTY"]]);
  assert.match(issues[0]!.message, /u této realizačky patří položce „Barová stolička“/u);
});

test("aliasy: ponechaný se nemění, upravený = deaktivace + nový řádek, odebraný se jen deaktivuje", () => {
  const existing = [
    alias({ id: "keep", catalogItemId: "chair", realizationCompanyId: "gendai", aliasText: "A" }),
    alias({ id: "edit", catalogItemId: "chair", aliasText: "B" }),
    alias({ id: "drop", catalogItemId: "chair", aliasKind: "code", aliasText: "C1" }),
    alias({ id: "other", catalogItemId: "stool", aliasText: "D" }),
  ];
  const plan = planCatalogItemAliasChanges("chair", [
    { id: "keep", realizationCompanyId: "gendai", aliasKind: "name", aliasText: "A" },
    { id: "edit", aliasKind: "name", aliasText: "B2" },
    { realizationCompanyId: "creativ-expo", aliasKind: "code", aliasText: "CR-1" },
  ], existing);
  assert.deepEqual(plan.deactivateIds, ["edit", "drop"]);
  assert.deepEqual(plan.insert.map((entry) => [entry.realizationCompanyId ?? "obecný", entry.aliasKind, entry.normalizedText]), [["obecný", "name", "b2"], ["creativ-expo", "code", "CR-1"]]);
});

test("vyúčtování: alias firmy se použije jen u této firmy; existující mapování má přednost; obecný alias = další název položky", () => {
  const aliases = [
    alias({ id: "a1", catalogItemId: "chair", realizationCompanyId: "creativ-expo", aliasText: "Židle čalouněná", unitCode: "ks" }),
    alias({ id: "a2", catalogItemId: "table", realizationCompanyId: "creativ-expo", aliasText: "Stůl kulatý" }),
    alias({ id: "a3", catalogItemId: "stool", realizationCompanyId: "gendai", aliasText: "Židle čalouněná" }),
    alias({ id: "a4", catalogItemId: "chair", aliasText: "Konferenční židle" }),
    alias({ id: "a5", catalogItemId: "chair", realizationCompanyId: "creativ-expo", aliasKind: "code", aliasText: "CR-1" }),
  ];
  const ownMapping = { id: "m1", realizationCompanyId: "creativ-expo", sourceText: "Stůl kulatý", normalizedText: "stul kulaty", catalogItemId: "round-table", unit: null, status: "confirmed" as const, origin: "manual" as const, note: null, updatedAt: "" };
  const forCreativ = withCatalogAliases("creativ-expo", [ownMapping], [], aliases);
  assert.deepEqual(forCreativ.mappings.map((mapping) => [mapping.normalizedText, mapping.catalogItemId]), [["stul kulaty", "round-table"], ["zidle calounena", "chair"]]);
  assert.equal(forCreativ.mappings[1]!.unit, "ks");
  assert.deepEqual(forCreativ.catalogNames.map((name) => [name.catalogItemId, name.normalizedName]), [["chair", "konferencni zidle"]]);
  const forGendai = withCatalogAliases("gendai", [], [], aliases);
  assert.deepEqual(forGendai.mappings.map((mapping) => [mapping.normalizedText, mapping.catalogItemId]), [["zidle calounena", "stool"]]);
});

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

function request(token: string | undefined, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `homeworkstudio_session=${token}`;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest("http://localhost/api/catalog-admin/items/aliases", { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

test("API aliasů: bez přihlášení 401; výpis vrací i číselník jednotek a firmy z evidence; konflikt = 409", async () => {
  const token = await createSessionToken(SECRET);
  const dependencies = {
    readAliases: async () => [],
    listCompanies: async () => [{ id: "gendai", name: "Gendai", isActive: true }],
    saveAliases: async (): Promise<readonly CatalogItemAlias[]> => {
      throw new InvalidCatalogAliasesError([{ index: 0, code: "TAKEN", message: "Název už patří jiné položce." }]);
    },
  };
  assert.equal((await handleCatalogAliasesGet(request(undefined), dependencies)).status, 401);
  assert.equal((await handleCatalogAliasesSave(request(undefined, { catalogItemId: "x", aliases: [] }), dependencies)).status, 401);
  const list = await (await handleCatalogAliasesGet(request(token), dependencies)).json() as { units: { code: string }[]; companies: { id: string }[] };
  assert.deepEqual(list.units.map((unit) => unit.code), ["ks", "m2", "bm", "m3", "den", "pausal"]);
  assert.deepEqual(list.companies.map((company) => company.id), ["gendai"]);
  assert.equal((await handleCatalogAliasesSave(request(token, { catalogItemId: "x", aliases: [{ aliasKind: "name", aliasText: "A" }] }), dependencies)).status, 409);
  assert.equal((await handleCatalogAliasesSave(request(token, { aliases: [] }), dependencies)).status, 400);
});

// ---------------------------------------------------------------------------
// migration
// ---------------------------------------------------------------------------

test("MIGRACE: aditivní (žádné mazání tabulek, sloupců ani dat), jen rozšíření kontroly typu o KIT", async () => {
  const sql = await migrationSql();
  assert.doesNotMatch(sql, /drop (table|column)/iu);
  assert.doesNotMatch(sql, /\bdelete\s+from\b/iu);
  assert.deepEqual([...sql.matchAll(/drop constraint ([a-z_]+)/giu)].map((match) => match[1]), ["catalog_items_item_type_check"]);
  assert.match(sql, /check \(item_type in \('PRODUCT', 'SERVICE', 'BOOTH', 'INTERNAL_COMPONENT', 'KIT'\)\)/u);
  assert.match(sql, /add column official_name_en text,\s*add column unit_code text references catalog_units \(code\) on delete restrict/u);
});

test("MIGRACE: aliasy navázané na evidenci firem z V1-DATA-02, unikátní podle firmy, nemazatelné; RLS na nových tabulkách", async () => {
  const sql = await migrationSql();
  assert.match(sql, /realization_company_id text references print_surface_realization_companies \(id\) on delete restrict/u);
  assert.doesNotMatch(sql, /create table (realization_companies|companies) \(/u, "žádná druhá evidence firem");
  assert.match(sql, /on catalog_item_aliases \(coalesce\(realization_company_id, ''\), alias_kind, normalized_text\) where is_active/u);
  assert.match(sql, /before delete on catalog_item_aliases/u);
  for (const table of ["catalog_units", "catalog_item_aliases"]) assert.match(sql, new RegExp(`alter table ${table} enable row level security;`, "u"));
  assert.doesNotMatch(sql, /create policy/iu);
});

test("MIGRACE: převod jednotek jen u jednoznačných zápisů — kombinované a neznámé zůstanou bez unit_code", async () => {
  const sql = await migrationSql();
  const mapped = [...sql.matchAll(/when '([^']+)' then '([a-z0-9]+)'/gu)].map((match) => [match[1]!, match[2]!] as const);
  assert.ok(mapped.length >= 10);
  for (const [raw, code] of mapped) {
    const result = normalizeCatalogUnit(raw);
    assert.equal(result.status === "known" && result.code, code, `SQL převod ${raw} odpovídá doméně`);
  }
  assert.ok(!mapped.some(([raw]) => raw.includes("/")), "žádná kombinovaná jednotka");
});
