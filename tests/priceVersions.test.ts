import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import test from "node:test";
import { NextRequest } from "next/server.js";
import type { CatalogPackageItem } from "../domain/catalogPackages.ts";
import type { CatalogVariantSet } from "../domain/catalogVariants.ts";
import { applyExcelRowToSaleEntry, EXCEL_DELETE_MARKER, PRICE_VERSION_EXCEL_COLUMNS, saleEntryToExcelRow } from "../domain/priceVersionExcel.ts";
import {
  assignmentIssue,
  convertCzkToEur,
  currentEventAssignment,
  DEFAULT_EUR_RATE,
  DEFAULT_EUR_ROUNDING_MODE,
  DEFAULT_EUR_ROUNDING_STEP,
  eventAssignmentHistory,
  eventsUsingVersion,
  eurWorldOf,
  missingTracks,
  PRICE_TRACKS,
  uncoveredTracks,
  versionTrackCoverage,
  comparePriceItemsByCode,
  matchesPriceItemSearch,
  priceItemCode,
  InvalidPriceVersionInputError,
  parsePriceListInput,
  parsePriceVersionHeaderInput,
  parsePurchaseEntryInput,
  parseSaleEntryInput,
  parseSurchargeInput,
  priceKitVersioned,
  purchaseListIdForCompany,
  resolveAmount,
  resolvePurchasePrice,
  resolveSalePrice,
  resolveSurchargeAmount,
  roundEur,
  validateVersionForPublish,
  type EventPriceAssignment,
  type PriceListVersion,
  type PriceSurcharge,
  type PurchasePriceBook,
  type SalePriceBook,
  type SalePriceEntry,
  type VersionedPriceList,
  type VersionedPricingContext,
} from "../domain/priceVersions.ts";
import { PERMISSIONS, sessionPermissions, type Permission } from "../lib/auth/permissions.ts";
import { PriceVersionConflictError, type PriceVersionRepository, type PricingCatalogItem } from "../lib/db/priceVersions.supabase.ts";
import {
  handlePurchaseAction,
  handlePurchaseRegister,
  handlePurchaseRowsRead,
  handlePurchaseRowsSave,
  handleSaleAction,
  handleSaleRegister,
  handleSaleResolve,
  handleSaleRowsRead,
  handleSaleRowsSave,
  type PriceVersionsApiDependencies,
} from "../lib/priceVersions/priceVersionsApi.server.ts";

// V1-DATA-05 — versioned price lists: EUR conversion, explicit event versions, electricity by
// category, kits with versioned prices, purchase prices kept apart, publish rules, migration.

const MIGRATION = "supabase/migrations/20261022120000_price_list_versions.sql";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

const BASE_LIST: VersionedPriceList = { id: "list-base", code: "ZAKLADNI", name: "Základní ceník", kind: "base", isActive: true };
const EL_LIST: VersionedPriceList = { id: "list-el", code: "ELEKTRO-BEAUTY", name: "Elektřina FOR BEAUTY", kind: "electricity", isActive: true };
const PUR_LIST: VersionedPriceList = { id: "list-pur", code: "NAKUP", name: "Nákupní ceník", kind: "purchase", isActive: true };

function version(id: string, priceListId: string, patch: Partial<PriceListVersion> = {}): PriceListVersion {
  return { id, priceListId, versionNo: 1, revision: 1, status: "published", eurRate: DEFAULT_EUR_RATE, eurRoundingMode: "ceil", eurRoundingStep: 1, publishedAt: "2026-10-22T10:00:00Z", ...patch };
}

function entry(id: string, versionId: string, catalogItemId: string, patch: Partial<SalePriceEntry> = {}): SalePriceEntry {
  return { id, versionId, catalogItemId, priceMode: "fixed", eurMode: "derived", ...patch };
}

const ITEM = {
  chair: "11111111-1111-4111-8111-111111111111",
  carpetGrey: "22222222-2222-4222-8222-222222222222",
  carpetColour: "33333333-3333-4333-8333-333333333333",
  el2kw: "44444444-4444-4444-8444-444444444444",
  el5kw: "55555555-5555-4555-8555-555555555555",
  kit: "66666666-6666-4666-8666-666666666666",
  table: "77777777-7777-4777-8777-777777777777",
};
const VARIANT = { grey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", blue: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

const categories = new Map<string, "standard" | "electricity">([[ITEM.el2kw, "electricity"], [ITEM.el5kw, "electricity"]]);
const categoryOf = (id: string) => categories.get(id) ?? "standard";

function baseBook(patch: Partial<SalePriceBook> = {}): SalePriceBook {
  const v = version("v-base-1", BASE_LIST.id);
  return {
    list: BASE_LIST,
    version: v,
    entries: [
      entry("e-chair", v.id, ITEM.chair, { saleCzk: 516, saleEurWorld: 29 }),
      entry("e-grey", v.id, ITEM.carpetGrey, { saleCzk: 120, unitCode: "m2" }),
      entry("e-colour", v.id, ITEM.carpetColour, { saleCzk: 150, unitCode: "m2" }),
      entry("e-colour-blue", v.id, ITEM.carpetColour, { variantId: VARIANT.blue, saleCzk: 170, unitCode: "m2" }),
      entry("e-el2", v.id, ITEM.el2kw, { saleCzk: 2000 }),
      entry("e-kit", v.id, ITEM.kit, { saleCzk: 20000, saleEurWorld: 900 }),
      entry("e-table", v.id, ITEM.table, { priceMode: "individual", eurMode: "none" }),
    ],
    surcharges: [],
    ...patch,
  };
}

function electricityBook(): SalePriceBook {
  const v = version("v-el-1", EL_LIST.id);
  return { list: EL_LIST, version: v, entries: [entry("e-el2-beauty", v.id, ITEM.el2kw, { saleCzk: 2400, eurMode: "none" })], surcharges: [] };
}

function context(patch: Partial<VersionedPricingContext> = {}): VersionedPricingContext {
  return { track: "CZK", base: baseBook(), electricity: electricityBook(), priceCategoryOf: categoryOf, ...patch };
}

// ---------------------------------------------------------------------------------------------
// EUR conversion and rounding
// ---------------------------------------------------------------------------------------------

test("výchozí kurz 24,17 a zaokrouhlení nahoru na celé euro", () => {
  assert.equal(DEFAULT_EUR_RATE, 24.17);
  assert.equal(DEFAULT_EUR_ROUNDING_MODE, "ceil");
  assert.equal(DEFAULT_EUR_ROUNDING_STEP, 1);
  const rule = { eurRate: 24.17, eurRoundingMode: "ceil" as const, eurRoundingStep: 1 };
  assert.equal(convertCzkToEur(516, rule), 22, "516 / 24,17 = 21,35 € → 22 €");
  assert.equal(roundEur(21.35, "ceil", 1), 22);
  assert.equal(convertCzkToEur(483.4, rule), 20, "přesně 20,00 € se nezvedne na 21 kvůli plovoucí čárce");
  assert.equal(convertCzkToEur(0, rule), 0);
});

test("zaokrouhlení podle pravidla verze: směr i krok", () => {
  assert.equal(roundEur(21.35, "round", 1), 21);
  assert.equal(roundEur(21.35, "floor", 1), 21);
  assert.equal(roundEur(21.35, "ceil", 0.5), 21.5);
  assert.equal(roundEur(21.351, "ceil", 0.01), 21.36);
  assert.equal(roundEur(21.35, "ceil", 5), 25);
  assert.throws(() => convertCzkToEur(100, { eurRate: 0, eurRoundingMode: "ceil", eurRoundingStep: 1 }), RangeError);
});

test("tři ceny jedné položky současně: CZK 516, EUR SK 22 (odvozeno), EUR WORLD 29 (pevná)", () => {
  const rule = { eurRate: 24.17, eurRoundingMode: "ceil" as const, eurRoundingStep: 1 };
  const row = { czk: 516, eurMode: "derived" as const, eurWorld: 29 };
  assert.deepEqual(resolveAmount(row, "CZK", rule), { amount: 516 });
  assert.deepEqual(resolveAmount(row, "EUR_SK", rule), { amount: 22, eurSource: "derived" });
  assert.deepEqual(resolveAmount(row, "EUR_WORLD", rule), { amount: 29, eurSource: "world" });
  assert.deepEqual(resolveAmount({ czk: 516, eurMode: "manual", eur: 21, eurWorld: 29 }, "EUR_SK", rule), { amount: 21, eurSource: "manual", derivedEur: 22 }, "ruční EUR SK je zaznamenaná");
  assert.deepEqual(resolveAmount({ czk: 516, eurMode: "derived" }, "EUR_WORLD", rule), { missingReason: "no_eur_world_price" }, "chybějící EUR WORLD se nedopočítává z kurzu");
  assert.deepEqual(resolveAmount({ eurMode: "derived", eurWorld: 29 }, "EUR_SK", rule), { missingReason: "no_eur_sk_price" });
  assert.deepEqual(resolveAmount({ czk: 516, eurMode: "none" }, "EUR_SK", rule), { missingReason: "no_eur_sk_price" });
});

test("starší řádek „direct“ (před opravou): jeho EUR cena = EUR WORLD, EUR SK se odvodí z CZK", () => {
  const rule = { eurRate: 24.17, eurRoundingMode: "ceil" as const, eurRoundingStep: 1 };
  const legacy = { czk: 20000, eurMode: "direct" as const, eur: 850 };
  assert.deepEqual(resolveAmount(legacy, "EUR_WORLD", rule), { amount: 850, eurSource: "world" });
  assert.deepEqual(resolveAmount(legacy, "EUR_SK", rule), { amount: 828, eurSource: "derived" }, "20000 / 24,17 = 827,47 → 828");
  assert.equal(eurWorldOf({ eurMode: "direct", eur: 850, eurWorld: 900 }), 900, "nový sloupec má přednost");
});

test("změna CZK nebo kurzu mění jen EUR SK, nikdy EUR WORLD", () => {
  const rule = { eurRate: 24.17, eurRoundingMode: "ceil" as const, eurRoundingStep: 1 };
  const before = { czk: 516, eurMode: "derived" as const, eurWorld: 29 };
  const czkChanged = { ...before, czk: 600 };
  const rateChanged = { ...rule, eurRate: 25 };
  assert.equal(resolveAmount(czkChanged, "EUR_SK", rule).amount, 25, "600 / 24,17 = 24,82 → 25");
  assert.equal(resolveAmount(before, "EUR_SK", rateChanged).amount, 21, "516 / 25 = 20,64 → 21");
  for (const [row, r] of [[before, rule], [czkChanged, rule], [before, rateChanged]] as const) {
    assert.equal(resolveAmount(row, "EUR_WORLD", r).amount, 29);
  }
  assert.equal(resolveAmount({ ...before, eurMode: "manual", eur: 20 }, "EUR_SK", rateChanged).amount, 20, "ruční EUR SK kurz nemění");
});

test("cenový režim se volí výslovně; výsledek nese režim i měnu", () => {
  assert.deepEqual([...PRICE_TRACKS], ["CZK", "EUR_SK", "EUR_WORLD"]);
  for (const track of PRICE_TRACKS) {
    const result = resolveSalePrice(context({ track }), ITEM.chair);
    assert.equal(result.track, track);
    assert.equal(result.currency, track === "CZK" ? "CZK" : "EUR");
  }
  assert.deepEqual(PRICE_TRACKS.map((track) => resolveSalePrice(context({ track }), ITEM.chair).amountNet), [516, 22, 29]);
});

test("kurz se bere z verze: stejná CZK cena dá v jiné verzi jiné EUR, stará verze se nemění", () => {
  const v1 = baseBook();
  const v2: SalePriceBook = { ...v1, version: { ...v1.version, id: "v-base-2", versionNo: 2, eurRate: 25 } };
  assert.equal(resolveSalePrice(context({ track: "EUR_SK", base: v1 }), ITEM.chair).amountNet, 22);
  assert.equal(resolveSalePrice(context({ track: "EUR_SK", base: v2 }), ITEM.chair).amountNet, 21, "516 / 25 = 20,64 → 21");
  assert.equal(resolveSalePrice(context({ track: "EUR_SK", base: v1 }), ITEM.chair).amountNet, 22, "v1 zůstává 22");
  assert.equal(resolveSalePrice(context({ track: "EUR_WORLD", base: v2 }), ITEM.chair).amountNet, 29, "EUR WORLD na kurzu nezávisí");
});

// ---------------------------------------------------------------------------------------------
// Sale resolution
// ---------------------------------------------------------------------------------------------

test("chybějící cena = k nacenění, nikdy 0", () => {
  assert.deepEqual(resolveSalePrice(context({ base: undefined, electricity: undefined }), ITEM.chair), { status: "missing", track: "CZK", currency: "CZK", missingReason: "no_version" });
  const missing = resolveSalePrice(context(), "99999999-9999-4999-8999-999999999999");
  assert.equal(missing.status, "missing");
  assert.equal(missing.missingReason, "no_entry");
  assert.equal(missing.amountNet, undefined);
  const individual = resolveSalePrice(context(), ITEM.table);
  assert.equal(individual.status, "individual");
  assert.equal(individual.amountNet, undefined);
});

test("cena s původem: seznam, verze, řádek a pravidlo EUR (pro snapshot V1-DATA-07)", () => {
  const result = resolveSalePrice(context({ track: "EUR_SK" }), ITEM.chair);
  assert.equal(result.status, "priced");
  assert.equal(result.amountNet, 22);
  assert.deepEqual(
    { list: result.origin?.listCode, version: result.origin?.versionId, entry: result.origin?.entryId, rate: result.origin?.eurRate, source: result.origin?.eurSource, manual: result.origin?.manual },
    { list: "ZAKLADNI", version: "v-base-1", entry: "e-chair", rate: 24.17, source: "derived", manual: false },
  );
  const manualBook = baseBook({ entries: [entry("e-chair", "v-base-1", ITEM.chair, { saleCzk: 516, eurMode: "manual", saleEur: 20 })] });
  const manual = resolveSalePrice(context({ track: "EUR_SK", base: manualBook }), ITEM.chair);
  assert.equal(manual.amountNet, 20);
  assert.equal(manual.origin?.manual, true, "ruční cena je označená");
  assert.equal(manual.origin?.derivedEur, 22);
});

test("varianta: vlastní cena varianty má přednost, jinak obecná cena karty", () => {
  const blue = resolveSalePrice(context(), ITEM.carpetColour, VARIANT.blue);
  assert.equal(blue.amountNet, 170);
  assert.equal(blue.origin?.variantSpecific, true);
  const red = resolveSalePrice(context(), ITEM.carpetColour, "cccccccc-cccc-4ccc-8ccc-cccccccccccc");
  assert.equal(red.amountNet, 150);
  assert.equal(red.origin?.variantSpecific, false);
});

test("elektřina se pozná podle kategorie: ceník elektřiny veletrhu, jinak základní; běžná položka ceník elektřiny nikdy nepoužije", () => {
  const el = resolveSalePrice(context(), ITEM.el2kw);
  assert.equal(el.amountNet, 2400);
  assert.equal(el.origin?.listKind, "electricity");
  const fallback = resolveSalePrice(context({ electricity: undefined }), ITEM.el2kw);
  assert.equal(fallback.amountNet, 2000);
  assert.equal(fallback.origin?.listKind, "base");
  const elWithChair: SalePriceBook = { ...electricityBook(), entries: [...electricityBook().entries, entry("x", "v-el-1", ITEM.chair, { saleCzk: 1 })] };
  assert.equal(resolveSalePrice(context({ electricity: elWithChair }), ITEM.chair).amountNet, 516);
  // A code prefix means nothing: an item of category "standard" with an L-code is priced by base.
  categories.set(ITEM.table, "standard");
  assert.equal(resolveSalePrice(context(), ITEM.table).origin?.listKind, "base");
});

test("řádek v ceníku elektřiny bez EUR ceny nepadá do základního ceníku (žádná tichá záměna)", () => {
  const result = resolveSalePrice(context({ track: "EUR_SK" }), ITEM.el2kw);
  assert.equal(result.status, "missing");
  assert.equal(result.missingReason, "no_eur_sk_price");
  assert.equal(resolveSalePrice(context({ track: "EUR_WORLD" }), ITEM.el2kw).missingReason, "no_eur_world_price");
  assert.equal(result.origin?.listKind, "electricity");
});

// ---------------------------------------------------------------------------------------------
// Explicit event assignment — never by date
// ---------------------------------------------------------------------------------------------

const assignments: EventPriceAssignment[] = [
  { id: "a1", eventId: "beauty-2026-podzim", listKind: "base", priceListVersionId: "v-base-1", assignedAt: "2026-09-01T08:00:00Z", replacedAt: "2026-10-01T08:00:00Z" },
  { id: "a2", eventId: "beauty-2026-podzim", listKind: "base", priceListVersionId: "v-base-2", assignedAt: "2026-10-01T08:00:00Z" },
  { id: "a3", eventId: "beauty-2026-podzim", listKind: "electricity", priceListVersionId: "v-el-1", assignedAt: "2026-09-01T08:00:00Z" },
  { id: "a4", eventId: "decor-2026", listKind: "base", priceListVersionId: "v-base-1", assignedAt: "2026-09-02T08:00:00Z" },
];

test("veletrh používá aktuální výslovné přiřazení; historie zůstává", () => {
  assert.equal(currentEventAssignment(assignments, "beauty-2026-podzim", "base")?.priceListVersionId, "v-base-2");
  assert.equal(currentEventAssignment(assignments, "beauty-2026-podzim", "electricity")?.priceListVersionId, "v-el-1");
  assert.equal(currentEventAssignment(assignments, "arch-2026", "base"), undefined);
  assert.deepEqual(eventAssignmentHistory(assignments, "beauty-2026-podzim").map((row) => row.id), ["a2", "a1", "a3"]);
  assert.deepEqual(eventsUsingVersion(assignments, "v-base-1"), ["decor-2026"]);
});

test("zářijový veletrh smí mít verzi s evidenční platností do června; resolver datum nezná", () => {
  const june = baseBook({ version: version("v-june", BASE_LIST.id, { validFrom: "2026-01-01", validTo: "2026-06-30" }) });
  const result = resolveSalePrice(context({ base: june }), ITEM.chair);
  assert.equal(result.status, "priced");
  assert.equal(result.origin?.versionId, "v-june");
  assert.equal(resolveSalePrice.length, 3, "resolveSalePrice nemá žádný parametr data");
});

test("publikace nové verze nemění veletrh: kontext se staví jen z přiřazení", () => {
  const published = [version("v-base-1", BASE_LIST.id), version("v-base-3", BASE_LIST.id, { versionNo: 3, publishedAt: "2026-10-22T12:00:00Z" })];
  assert.equal(published.length, 2);
  assert.equal(currentEventAssignment(assignments, "decor-2026", "base")?.priceListVersionId, "v-base-1", "nová v3 se veletrhu nepřiřadí sama");
});

test("přiřadit lze jen publikovanou verzi a jen do správného místa", () => {
  assert.equal(assignmentIssue(BASE_LIST, { status: "draft" }, "base"), "Veletrhu lze přiřadit jen publikovanou verzi ceníku.");
  assert.equal(assignmentIssue(BASE_LIST, { status: "published" }, "electricity"), "Druh ceníku neodpovídá přiřazení (základní / elektřina).");
  assert.equal(assignmentIssue(PUR_LIST, { status: "published" }, "base"), "Druh ceníku neodpovídá přiřazení (základní / elektřina).");
  assert.equal(assignmentIssue(EL_LIST, { status: "published" }, "electricity"), undefined);
  assert.equal(assignmentIssue(BASE_LIST, { status: "archived" }, "base"), "Veletrhu lze přiřadit jen publikovanou verzi ceníku.");
});

// ---------------------------------------------------------------------------------------------
// Kits with versioned prices (V1-DATA-04 structure)
// ---------------------------------------------------------------------------------------------

const variantSets: CatalogVariantSet[] = [{
  id: "set-carpets",
  code: "KOBERCE",
  name: "Koberce",
  kind: "carpet",
  isActive: true,
  variants: [
    { id: VARIANT.grey, variantSetId: "set-carpets", code: "GREY", name: "Šedý", priceItemId: ITEM.carpetGrey, surchargeRule: "none", isActive: true, sortOrder: 0 },
    { id: VARIANT.blue, variantSetId: "set-carpets", code: "BLUE", name: "Modrý", priceItemId: ITEM.carpetColour, surchargeRule: "per_unit", surchargeUnitCode: "m2", isActive: true, sortOrder: 1 },
  ],
}];

const kitLines: CatalogPackageItem[] = [
  { id: "l1", packageItemId: ITEM.kit, lineKey: "koberec", lineKind: "item", childItemId: ITEM.carpetGrey, quantity: 9, unitCode: "m2", includedInPackage: true, sortOrder: 0, note: null, variantSetId: "set-carpets", defaultVariantId: VARIANT.grey },
  { id: "l2", packageItemId: ITEM.kit, lineKey: "elektro", lineKind: "item", childItemId: ITEM.el2kw, quantity: 1, includedInPackage: true, sortOrder: 1, note: null, substitutes: [
    { substituteItemId: ITEM.el5kw, surchargeRule: "fixed", quantityFactor: 1 },
  ] },
  { id: "l3", packageItemId: ITEM.kit, lineKey: "zidle", lineKind: "item", childItemId: ITEM.chair, quantity: 2, includedInPackage: true, sortOrder: 2, note: null, substitutes: [
    { substituteItemId: ITEM.table, surchargeRule: "price_difference", quantityFactor: 1 },
  ] },
  { id: "l4", packageItemId: ITEM.kit, lineKey: "stul-navic", lineKind: "item", childItemId: ITEM.chair, quantity: 1, includedInPackage: false, sortOrder: 3, note: null },
  { id: "l5", packageItemId: ITEM.kit, lineKey: "stavba", lineKind: "text", childItemId: null, label: "Stavba stánku", quantity: 1, includedInPackage: true, sortOrder: 4, note: null },
];

function kitContext(surcharges: readonly PriceSurcharge[] = []): VersionedPricingContext {
  return context({ base: baseBook({ surcharges }) });
}

test("komplet: cena kompletu + volitelné řádky; zahrnuté komponenty se nezdvojují, text se necení", () => {
  const result = priceKitVersioned({ context: kitContext(), kitItemId: ITEM.kit, lines: kitLines, variantSets });
  assert.equal(result.kitPrice.amountNet, 20000);
  assert.equal(result.lines.find((line) => line.lineKey === "koberec")?.totalNet, 0);
  assert.equal(result.lines.find((line) => line.lineKey === "zidle")?.totalNet, 0, "2 židle v ceně kompletu se znovu neúčtují");
  assert.equal(result.lines.find((line) => line.lineKey === "stul-navic")?.totalNet, 516, "volitelný řádek = cena z verze");
  assert.equal(result.lines.find((line) => line.lineKey === "stavba")?.status, "included");
  assert.equal(result.totalNet, 20516);
  assert.equal(result.needsQuote, false);
});

test("komplet: příplatek barvy koberce za m² z doplatků verze; bez částky = k nacenění", () => {
  const surcharge: PriceSurcharge = { id: "s-blue", versionId: "v-base-1", targetKind: "variant", variantId: VARIANT.blue, amountCzk: 30, eurMode: "derived" };
  const priced = priceKitVersioned({ context: kitContext([surcharge]), kitItemId: ITEM.kit, lines: kitLines, variantSets, selections: [{ lineKey: "koberec", variantId: VARIANT.blue }] });
  assert.equal(priced.lines.find((line) => line.lineKey === "koberec")?.totalNet, 270, "9 m² × 30 Kč");
  const missing = priceKitVersioned({ context: kitContext(), kitItemId: ITEM.kit, lines: kitLines, variantSets, selections: [{ lineKey: "koberec", variantId: VARIANT.blue }] });
  assert.equal(missing.lines.find((line) => line.lineKey === "koberec")?.status, "missing");
  assert.equal(missing.needsQuote, true);
});

test("komplet: pevný doplatek náhrady je vázaný na komplet + řádek + náhradu (ne na id řádku náhrady)", () => {
  const surcharge: PriceSurcharge = { id: "s-5kw", versionId: "v-base-1", targetKind: "substitute", kitItemId: ITEM.kit, lineKey: "elektro", substituteItemId: ITEM.el5kw, amountCzk: 1500, eurMode: "derived" };
  const result = priceKitVersioned({ context: kitContext([surcharge]), kitItemId: ITEM.kit, lines: kitLines, variantSets, selections: [{ lineKey: "elektro", substituteItemId: ITEM.el5kw }] });
  const line = result.lines.find((candidate) => candidate.lineKey === "elektro");
  assert.equal(line?.effectiveItemId, ITEM.el5kw, "náhrada nahrazuje komponentu");
  assert.equal(line?.totalNet, 1500);
  const otherKit = resolveSurchargeAmount(kitContext([surcharge]), "other-kit", { kind: "substitute", lineKey: "elektro", substituteItemId: ITEM.el5kw });
  assert.equal(otherKit.amountNet, undefined, "doplatek jiného kompletu se nepoužije");
  const eur = resolveSurchargeAmount({ ...kitContext([surcharge]), track: "EUR_SK" }, ITEM.kit, { kind: "substitute", lineKey: "elektro", substituteItemId: ITEM.el5kw });
  assert.equal(eur.amountNet, 63, "1500 / 24,17 = 62,06 → 63 €");
});

test("komplet: rozdíl ceny z verze, levnější volba = 0 (A4); cena na dotaz = k nacenění", () => {
  const result = priceKitVersioned({ context: kitContext(), kitItemId: ITEM.kit, lines: kitLines, variantSets, selections: [{ lineKey: "zidle", substituteItemId: ITEM.table }] });
  const line = result.lines.find((candidate) => candidate.lineKey === "zidle");
  assert.equal(line?.status, "missing", "stůl má cenu na dotaz, rozdíl nelze spočítat");
  assert.equal(result.needsQuote, true);
  const cheaper = baseBook({ entries: [...baseBook().entries.filter((row) => row.catalogItemId !== ITEM.table), entry("e-table2", "v-base-1", ITEM.table, { saleCzk: 100 })] });
  const floor = priceKitVersioned({ context: context({ base: cheaper }), kitItemId: ITEM.kit, lines: kitLines, variantSets, selections: [{ lineKey: "zidle", substituteItemId: ITEM.table }] });
  assert.equal(floor.lines.find((candidate) => candidate.lineKey === "zidle")?.surcharge?.reason, "floor_zero");
  assert.equal(floor.lines.find((candidate) => candidate.lineKey === "zidle")?.totalNet, 0);
});

test("komplet ve třech režimech: EUR WORLD bere vlastní pevné ceny i doplatky", () => {
  const surcharge: PriceSurcharge = { id: "s-blue", versionId: "v-base-1", targetKind: "variant", variantId: VARIANT.blue, amountCzk: 30, eurMode: "derived", amountEurWorld: 2 };
  const selections = [{ lineKey: "koberec", variantId: VARIANT.blue }];
  const totals = PRICE_TRACKS.map((track) => priceKitVersioned({ context: { ...kitContext([surcharge]), track }, kitItemId: ITEM.kit, lines: kitLines.filter((line) => line.lineKey !== "stul-navic"), variantSets, selections }));
  assert.deepEqual(totals.map((result) => result.totalNet), [20000 + 270, 828 + 18, 900 + 18], "CZK 9×30; EUR SK 9×2 (30/24,17 → 2); EUR WORLD 9×2");
  assert.deepEqual(totals.map((result) => result.track), ["CZK", "EUR_SK", "EUR_WORLD"]);
  const noWorld = priceKitVersioned({ context: { ...kitContext([{ ...surcharge, amountEurWorld: undefined }]), track: "EUR_WORLD" }, kitItemId: ITEM.kit, lines: kitLines, variantSets, selections });
  assert.equal(noWorld.needsQuote, true, "chybějící EUR WORLD doplatku = k nacenění");
});

test("komplet bez vlastní ceny ve verzi = k nacenění, ne 0", () => {
  const noKit = baseBook({ entries: baseBook().entries.filter((row) => row.catalogItemId !== ITEM.kit) });
  const result = priceKitVersioned({ context: context({ base: noKit }), kitItemId: ITEM.kit, lines: kitLines, variantSets });
  assert.equal(result.kitPrice.status, "missing");
  assert.equal(result.needsQuote, true);
});

test("komplet: elektřina uvnitř kompletu se cení podle ceníku elektřiny veletrhu", () => {
  const optionalEl: CatalogPackageItem[] = [{ id: "x", packageItemId: ITEM.kit, lineKey: "elektro", lineKind: "item", childItemId: ITEM.el2kw, quantity: 1, includedInPackage: false, sortOrder: 0, note: null }];
  const result = priceKitVersioned({ context: context(), kitItemId: ITEM.kit, lines: optionalEl });
  assert.equal(result.lines[0]?.totalNet, 2400);
});

// ---------------------------------------------------------------------------------------------
// Purchase prices
// ---------------------------------------------------------------------------------------------

test("nákupní cena: jeden společný ceník pro firmy; prodejní ceník nákupní cenu nikdy nevrátí", () => {
  const book: PurchasePriceBook = { list: PUR_LIST, version: version("v-pur-1", PUR_LIST.id), entries: [{ id: "p1", versionId: "v-pur-1", catalogItemId: ITEM.chair, purchaseCzk: 300, unitCode: "ks" }] };
  assert.deepEqual(resolvePurchasePrice(book, ITEM.chair), { status: "priced", amountCzk: 300, unitCode: "ks", listId: "list-pur", versionId: "v-pur-1", versionNo: 1, entryId: "p1" });
  assert.equal(resolvePurchasePrice(book, ITEM.table).status, "missing");
  assert.equal(resolvePurchasePrice({ ...book, list: BASE_LIST }, ITEM.chair).status, "missing", "prodejní seznam není nákupní");
  const links = [
    { id: "1", priceListId: "list-pur", realizationCompanyId: "creativ-expo", isActive: true },
    { id: "2", priceListId: "list-pur", realizationCompanyId: "gendai", isActive: true },
    { id: "3", priceListId: "list-pur", realizationCompanyId: "macik", isActive: true },
    { id: "4", priceListId: "list-old", realizationCompanyId: "macik", isActive: false },
  ];
  assert.deepEqual(["creativ-expo", "gendai", "macik"].map((id) => purchaseListIdForCompany(links, id)), ["list-pur", "list-pur", "list-pur"]);
  assert.equal(purchaseListIdForCompany(links, "elseya"), undefined);
  const saleResult = resolveSalePrice(context(), ITEM.chair);
  assert.doesNotMatch(JSON.stringify(saleResult), /purchase/iu);
});

test("oprávnění: prodejní a nákupní ceny jsou samostatná oprávnění; dnešní jedno přihlášení má všechna", () => {
  assert.deepEqual([...PERMISSIONS], ["prices.sale.read", "prices.sale.write", "prices.purchase.read", "prices.purchase.write"]);
  assert.equal(sessionPermissions(true).size, 4);
  assert.equal(sessionPermissions(false).size, 0);
});

// ---------------------------------------------------------------------------------------------
// Publish checks and input parsing
// ---------------------------------------------------------------------------------------------

test("publikace: prázdná verze a cizí položka v ceníku elektřiny jsou chyba, překryv platnosti jen upozornění", () => {
  const draft = version("v-el-2", EL_LIST.id, { status: "draft", versionNo: 2, validFrom: "2026-01-01", publishedAt: undefined });
  const items = [
    { id: ITEM.el2kw, displayName: "Elektřina 2 kW", priceCategory: "electricity" as const },
    { id: ITEM.chair, displayName: "Židle", priceCategory: "standard" as const },
  ];
  assert.deepEqual(validateVersionForPublish({ list: EL_LIST, version: draft, rowCount: 0, saleEntries: [], items }).errors, ["Prázdnou verzi ceníku nelze publikovat."]);
  const foreign = validateVersionForPublish({ list: EL_LIST, version: draft, rowCount: 1, saleEntries: [entry("x", draft.id, ITEM.chair, { saleCzk: 1 })], items });
  assert.match(foreign.errors[0] ?? "", /jen položky kategorie Elektřina \(Židle\)/u);
  const overlap = validateVersionForPublish({ list: EL_LIST, version: draft, rowCount: 1, saleEntries: [entry("x", draft.id, ITEM.el2kw, { saleCzk: 1, saleEurWorld: 1 })], items, otherVersions: [version("v-el-1", EL_LIST.id, { validFrom: "2025-01-01" })] });
  assert.deepEqual(overlap.errors, []);
  assert.match(overlap.warnings[0] ?? "", /překrývá s verzí v1/u);
  assert.match(validateVersionForPublish({ list: EL_LIST, version: { ...draft, status: "published" }, rowCount: 1, items }).errors[0] ?? "", /jen koncept/u);
});

test("publikace vyžaduje všechny tři ceny u položek i doplatků; starší řádek direct nestačí", () => {
  const draft = version("v-base-9", BASE_LIST.id, { status: "draft", versionNo: 9, validFrom: "2026-01-01", publishedAt: undefined });
  const items = [{ id: ITEM.chair, displayName: "Židle", priceCategory: "standard" as const }, { id: ITEM.kit, displayName: "Komplet", priceCategory: "standard" as const }];
  const complete = entry("a", draft.id, ITEM.chair, { saleCzk: 516, saleEurWorld: 29 });
  assert.deepEqual(validateVersionForPublish({ list: BASE_LIST, version: draft, rowCount: 1, saleEntries: [complete], items }).errors, []);
  const noWorld = validateVersionForPublish({ list: BASE_LIST, version: draft, rowCount: 1, saleEntries: [entry("a", draft.id, ITEM.chair, { saleCzk: 516 })], items });
  assert.match(noWorld.errors[0] ?? "", /CZK, EUR SK i EUR WORLD.*Židle \(EUR_WORLD\)/u);
  const legacy = validateVersionForPublish({ list: BASE_LIST, version: draft, rowCount: 1, saleEntries: [entry("b", draft.id, ITEM.kit, { saleCzk: 20000, eurMode: "direct", saleEur: 850 })], items });
  assert.match(legacy.errors[0] ?? "", /Komplet \(EUR_SK, EUR_WORLD\)/u);
  assert.deepEqual(validateVersionForPublish({ list: BASE_LIST, version: draft, rowCount: 1, saleEntries: [entry("c", draft.id, ITEM.chair, { priceMode: "individual", eurMode: "none" })], items }).errors, [], "cena na dotaz nemá částky");
  const surcharge: PriceSurcharge = { id: "s", versionId: draft.id, targetKind: "variant", variantId: VARIANT.blue, amountCzk: 30, eurMode: "derived" };
  assert.match(validateVersionForPublish({ list: BASE_LIST, version: draft, rowCount: 1, saleEntries: [complete], surcharges: [surcharge], items }).errors[0] ?? "", /doplatek/u);
  assert.deepEqual(missingTracks({ saleCzk: 516, eurMode: "manual", saleEurWorld: 29 }, draft), ["EUR_SK"], "ruční EUR SK bez hodnoty");
});

test("vstup řádku: čárka v čísle, cena na dotaz bez částky, ruční EUR potřebuje CZK i EUR, prázdná cena ≠ 0", () => {
  assert.deepEqual(parseSaleEntryInput({ catalogItemId: ITEM.chair, saleCzk: "1 234,50" }, 0), { catalogItemId: ITEM.chair, priceMode: "fixed", saleCzk: 1234.5, eurMode: "derived" });
  assert.deepEqual(parseSaleEntryInput({ catalogItemId: ITEM.table, priceMode: "individual" }, 0), { catalogItemId: ITEM.table, priceMode: "individual", eurMode: "none" });
  assert.throws(() => parseSaleEntryInput({ catalogItemId: ITEM.table, priceMode: "individual", saleCzk: 10 }, 0), InvalidPriceVersionInputError);
  assert.throws(() => parseSaleEntryInput({ catalogItemId: ITEM.chair, saleCzk: 516, eurMode: "manual" }, 0), /chybí ruční cena EUR SK/u);
  assert.throws(() => parseSaleEntryInput({ catalogItemId: ITEM.chair, eurMode: "manual", saleEur: 20 }, 0), /chybí cena CZK/u);
  assert.throws(() => parseSaleEntryInput({ catalogItemId: ITEM.chair, saleCzk: "" }, 0), /chybí cena CZK/u);
  assert.throws(() => parseSaleEntryInput({ catalogItemId: ITEM.chair, saleCzk: 516, eurMode: "direct", saleEur: "19" }, 0), /režim EUR SK/u, "nové řádky nepoužívají starý režim direct");
  assert.deepEqual(parseSaleEntryInput({ catalogItemId: ITEM.chair, saleCzk: "516", saleEurWorld: "29" }, 0), { catalogItemId: ITEM.chair, priceMode: "fixed", saleCzk: 516, eurMode: "derived", saleEurWorld: 29 });
  assert.deepEqual(parseSaleEntryInput({ catalogItemId: ITEM.chair, saleCzk: "516", eurMode: "manual", saleEur: "21", saleEurWorld: "29" }, 0), { catalogItemId: ITEM.chair, priceMode: "fixed", saleCzk: 516, eurMode: "manual", saleEur: 21, saleEurWorld: 29 });
  assert.throws(() => parseSaleEntryInput({ catalogItemId: ITEM.table, priceMode: "individual", saleEurWorld: 5 }, 0), /nemá částku/u);
  assert.throws(() => parseSaleEntryInput({ catalogItemId: ITEM.chair, saleCzk: -1 }, 0), /nezáporné/u);
  assert.throws(() => parseSaleEntryInput({ catalogItemId: ITEM.chair, saleCzk: 1.234 }, 0), /dvě desetinná/u);
});

test("vstup hlavičky, ceníku, doplatku a nákupní ceny", () => {
  assert.deepEqual(parsePriceVersionHeaderInput({ eurRate: "24,17", eurRoundingStep: 1, validFrom: "2026-01-01", validTo: "2026-06-30" }), { validFrom: "2026-01-01", validTo: "2026-06-30", eurRate: 24.17, eurRoundingMode: "ceil", eurRoundingStep: 1 });
  assert.throws(() => parsePriceVersionHeaderInput({ eurRate: 0, eurRoundingStep: 1 }), /Kurz EUR/u);
  assert.throws(() => parsePriceVersionHeaderInput({ eurRate: 24.17, eurRoundingStep: 2 }), /Krok/u);
  assert.throws(() => parsePriceVersionHeaderInput({ eurRate: 24.17, eurRoundingStep: 1, validFrom: "2026-07-01", validTo: "2026-06-30" }), /nesmí být dříve/u);
  assert.equal(parsePriceListInput({ code: "zakladni", name: "Základní", kind: "base" }, ["base", "electricity"]).code, "ZAKLADNI");
  assert.throws(() => parsePriceListInput({ code: "NAKUP", name: "Nákup", kind: "purchase" }, ["base", "electricity"]), /druh/u, "prodejní stránka nákupní ceník nezaloží");
  assert.deepEqual(parseSurchargeInput({ targetKind: "variant", variantId: VARIANT.blue, amountCzk: "30", amountEurWorld: "2" }, 0), { targetKind: "variant", variantId: VARIANT.blue, amountCzk: 30, eurMode: "derived", amountEurWorld: 2 });
  assert.throws(() => parseSurchargeInput({ targetKind: "substitute", kitItemId: ITEM.kit, substituteItemId: ITEM.el5kw, amountCzk: 1 }, 0), /klíč řádku/u);
  assert.throws(() => parsePurchaseEntryInput({ catalogItemId: ITEM.chair }, 0), /chybí nákupní cena/u);
});

// ---------------------------------------------------------------------------------------------
// API handlers — namespaces, permissions, immutability
// ---------------------------------------------------------------------------------------------

type FakeState = {
  lists: VersionedPriceList[];
  versions: PriceListVersion[];
  saleEntries: SalePriceEntry[];
  purchaseRows: number;
  assigned: Array<{ eventId: string; listKind: string; versionId: string | null }>;
  assignments: EventPriceAssignment[];
  saved: number;
  copies: number;
};

function fakeRepository(state: FakeState): PriceVersionRepository {
  const bump = (id: string, expected: number, raise = true): number => {
    const current = state.versions.find((v) => v.id === id);
    if (!current || current.revision !== expected) throw new PriceVersionConflictError("Verzi ceníku mezitím změnil někdo jiný.", current?.revision);
    if (!raise) return current.revision;
    state.versions = state.versions.map((v) => (v.id === id ? { ...v, revision: v.revision + 1 } : v));
    return expected + 1;
  };
  const items: PricingCatalogItem[] = [{ id: ITEM.chair, displayName: "Židle", itemType: "PRODUCT", priceCategory: "standard", lifecycleStatus: "active" }];
  return {
    listPriceLists: async (kinds) => state.lists.filter((list) => kinds.includes(list.kind)),
    getPriceList: async (id) => state.lists.find((list) => list.id === id),
    listVersions: async (ids) => state.versions.filter((v) => ids.includes(v.priceListId)),
    getVersion: async (id) => state.versions.find((v) => v.id === id),
    createPriceList: async (input) => ({ id: "new", ...input }),
    updatePriceList: async (id, input) => ({ ...input, id }),
    // The fake repeats the database's optimistic-concurrency check (price_list_version_lock).
    createVersion: async (_listId, basedOn) => {
      if (basedOn) bump(basedOn.versionId, basedOn.revision, false);
      state.copies += 1;
      return "created";
    },
    updateVersionHeader: async (id, expected) => bump(id, expected),
    deleteDraftVersion: async (id, expected) => {
      bump(id, expected);
      state.versions = state.versions.filter((v) => v.id !== id);
    },
    publishVersion: async (id, expected) => {
      const revision = bump(id, expected);
      state.versions = state.versions.map((v) => (v.id === id ? { ...v, status: "published" } : v));
      return revision;
    },
    archiveVersion: async (id, expected) => bump(id, expected),
    listSaleEntries: async (ids) => state.saleEntries.filter((row) => ids.includes(row.versionId)),
    listSurcharges: async () => [],
    replaceSaleRows: async (id, expected) => {
      const revision = bump(id, expected);
      state.saved += 1;
      return revision;
    },
    listAssignments: async () => state.assignments,
    assignEventVersion: async (eventId, listKind, versionId, expectedCurrent) => {
      const current = state.assignments.find((a) => a.eventId === eventId && a.listKind === listKind && !a.replacedAt)?.priceListVersionId ?? null;
      if (current !== expectedCurrent) throw new PriceVersionConflictError("Přiřazení ceníku veletrhu mezitím změnil někdo jiný.");
      state.assignments = state.assignments.map((a) => (a.eventId === eventId && a.listKind === listKind && !a.replacedAt ? { ...a, replacedAt: "now" } : a));
      if (versionId) state.assignments.push({ id: `a${state.assignments.length}`, eventId, listKind, priceListVersionId: versionId, assignedAt: "now" });
      state.assigned.push({ eventId, listKind, versionId });
    },
    listEvents: async () => [{ id: "beauty", name: "FOR BEAUTY", year: 2026, active: true }],
    listPricingItems: async () => items,
    setPriceCategory: async () => {},
    listPurchaseEntries: async () => Array.from({ length: state.purchaseRows }, (_, index) => ({ id: `p${index}`, versionId: "v-pur", catalogItemId: ITEM.chair, purchaseCzk: 300 })),
    replacePurchaseRows: async (id, expected) => bump(id, expected),
    listPurchaseCompanies: async () => [],
    linkPurchaseCompany: async () => {},
    listCompanies: async () => [],
  };
}

function freshState(): FakeState {
  return {
    lists: [BASE_LIST, EL_LIST, PUR_LIST],
    versions: [
      version("v-base", BASE_LIST.id),
      version("v-draft", BASE_LIST.id, { status: "draft", versionNo: 2, publishedAt: undefined }),
      version("v-pur", PUR_LIST.id),
    ],
    saleEntries: [entry("e1", "v-base", ITEM.chair, { saleCzk: 516 }), entry("e2", "v-draft", ITEM.chair, { saleCzk: 520 })],
    purchaseRows: 1,
    assigned: [],
    assignments: [],
    saved: 0,
    copies: 0,
  };
}

function deps(state: FakeState, granted: readonly Permission[] = PERMISSIONS): PriceVersionsApiDependencies {
  return { repository: () => fakeRepository(state), kitData: async () => ({ variantSets: [], packageItems: [] }), hasPermission: async (_request, permission) => granted.includes(permission) };
}

function request(path: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${path}`, body === undefined ? { method: "GET" } : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
}

test("API: prodejní registr neobsahuje nákupní ceník ani nákupní ceny", async () => {
  const response = await handleSaleRegister(request("/api/price-versions"), deps(freshState()));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { lists: VersionedPriceList[] };
  assert.deepEqual(body.lists.map((list) => list.kind).sort(), ["base", "electricity"]);
  assert.doesNotMatch(JSON.stringify(body), /purchase|NAKUP/iu);
});

test("API: prodejní routy odmítnou verzi nákupního ceníku a naopak", async () => {
  const state = freshState();
  assert.equal((await handleSaleRowsRead(request("/api/price-versions/rows?versionId=v-pur"), deps(state))).status, 422);
  assert.equal((await handleSaleAction(request("/api/price-versions", { action: "publishVersion", versionId: "v-pur", expectedRevision: 1 }), deps(state))).status, 422);
  assert.equal((await handlePurchaseRowsRead(request("/api/purchase-prices/rows?versionId=v-base"), deps(state))).status, 422);
  assert.equal((await handlePurchaseAction(request("/api/purchase-prices", { action: "archiveVersion", versionId: "v-base", expectedRevision: 1 }), deps(state))).status, 422);
});

test("API: bez nákupního oprávnění nejsou nákupní ceny dostupné, prodejní ano", async () => {
  const saleOnly = deps(freshState(), ["prices.sale.read", "prices.sale.write"]);
  assert.equal((await handlePurchaseRegister(request("/api/purchase-prices"), saleOnly)).status, 401);
  assert.equal((await handlePurchaseRowsRead(request("/api/purchase-prices/rows?versionId=v-pur"), saleOnly)).status, 401);
  assert.equal((await handleSaleRegister(request("/api/price-versions"), saleOnly)).status, 200);
  assert.equal((await handleSaleRegister(request("/api/price-versions"), deps(freshState(), []))).status, 401);
});

test("API: publikovanou verzi nelze upravit ani smazat; úprava jde jen do konceptu", async () => {
  const state = freshState();
  const save = await handleSaleRowsSave(request("/api/price-versions/rows", { versionId: "v-base", expectedRevision: 1, entries: [{ catalogItemId: ITEM.chair, saleCzk: 1 }] }), deps(state));
  assert.equal(save.status, 409);
  assert.equal(state.saved, 0);
  assert.equal((await handleSaleAction(request("/api/price-versions", { action: "updateVersion", versionId: "v-base", expectedRevision: 1, header: { eurRate: 25, eurRoundingStep: 1 } }), deps(state))).status, 409, "kurz publikované verze nelze změnit");
  assert.equal((await handleSaleAction(request("/api/price-versions", { action: "deleteVersion", versionId: "v-base", expectedRevision: 1 }), deps(state))).status, 409);
  const draftSave = await handleSaleRowsSave(request("/api/price-versions/rows", { versionId: "v-draft", expectedRevision: 1, entries: [{ catalogItemId: ITEM.chair, saleCzk: "520" }] }), deps(state));
  assert.equal(draftSave.status, 200);
  assert.equal(state.saved, 1);
  const duplicate = await handleSaleRowsSave(request("/api/price-versions/rows", { versionId: "v-draft", expectedRevision: 2, entries: [{ catalogItemId: ITEM.chair, saleCzk: 1 }, { catalogItemId: ITEM.chair, saleCzk: 2 }] }), deps(state));
  assert.equal(duplicate.status, 422);
});

test("API: přiřazení konceptu veletrhu je odmítnuto, publikovaná verze projde", async () => {
  const state = freshState();
  const draft = await handleSaleAction(request("/api/price-versions", { action: "assign", eventId: "beauty", listKind: "base", versionId: "v-draft", expectedCurrentVersionId: null }), deps(state));
  assert.equal(draft.status, 409);
  assert.equal(state.assigned.length, 0);
  const ok = await handleSaleAction(request("/api/price-versions", { action: "assign", eventId: "beauty", listKind: "base", versionId: "v-base", expectedCurrentVersionId: null }), deps(state));
  assert.equal(ok.status, 200);
  assert.deepEqual(state.assigned, [{ eventId: "beauty", listKind: "base", versionId: "v-base" }]);
});

test("API: publikace prázdné verze vrátí chybu a nic nepublikuje", async () => {
  const state = freshState();
  state.saleEntries = [];
  const response = await handleSaleAction(request("/api/price-versions", { action: "publishVersion", versionId: "v-draft", expectedRevision: 1 }), deps(state));
  assert.equal(response.status, 422);
  assert.equal(state.versions.find((v) => v.id === "v-draft")?.status, "draft");
});

test("API: výpočet bez výslovného cenového režimu (jen měna EUR) je odmítnut", async () => {
  const response = await handleSaleResolve(request("/api/price-versions/resolve", { currency: "EUR", baseVersionId: "v-draft", items: [{ catalogItemId: ITEM.chair }] }), deps(freshState()));
  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { error: string }).error, /CZK, EUR_SK nebo EUR_WORLD/u);
});

test("API: zkušební výpočet podle veletrhu bez přiřazení vrátí k nacenění, ne 0", async () => {
  const response = await handleSaleResolve(request("/api/price-versions/resolve", { priceTrack: "CZK", eventId: "beauty", items: [{ catalogItemId: ITEM.chair }] }), deps(freshState()));
  const body = (await response.json()) as { results: { result: { status: string; amountNet?: number; missingReason?: string } }[] };
  assert.equal(body.results[0]?.result.status, "missing");
  assert.equal(body.results[0]?.result.missingReason, "no_version");
  assert.equal(body.results[0]?.result.amountNet, undefined);
  const explicit = await handleSaleResolve(request("/api/price-versions/resolve", { priceTrack: "EUR_SK", baseVersionId: "v-draft", items: [{ catalogItemId: ITEM.chair }] }), deps(freshState()));
  const explicitBody = (await explicit.json()) as { results: { result: { amountNet?: number } }[] };
  assert.equal(explicitBody.results[0]?.result.amountNet, 22, "520 / 24,17 = 21,51 → 22 € (koncept lze zkusit)");
});

// ---------------------------------------------------------------------------------------------
// Migration
// ---------------------------------------------------------------------------------------------

async function migrationSql(): Promise<string> {
  return (await readFile(new URL(`../${MIGRATION}`, import.meta.url), "utf8")).toLowerCase();
}

test("migrace: číslo nad 20261021130000, jen aditivní", async () => {
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
  const index = migrations.indexOf("20261022120000_price_list_versions.sql");
  assert.equal(migrations[index - 1], "20261021130000_catalog_kits_variants.sql");
  const sql = await migrationSql();
  assert.doesNotMatch(sql, /drop\s+table|drop\s+column|truncate|update\s+projects|update\s+price_lists|update\s+pricing_entries|delete\s+from\s+(price_lists|pricing_entries|catalog_items|events)/u);
  // Deletes only inside the draft-row replace functions.
  assert.deepEqual([...sql.matchAll(/delete from (\w+)/gu)].map((match) => match[1]), ["price_list_entries", "price_list_surcharges", "purchase_price_entries"]);
  // The only data change: one-time electricity backfill of SERVICE cards with an L-code.
  assert.match(sql, /set price_category = 'electricity'\s+where item_type = 'service' and abf_code ~ '\^l\[0-9a-z\]\{2\}\$'/u);
});

test("migrace: neměnnost, výchozí kurz, publikace jen RPC, oddělené nákupní ceny, RLS a funkce jen pro service_role", async () => {
  const sql = await migrationSql();
  assert.match(sql, /eur_rate numeric\(12, 4\) not null default 24\.17/u);
  assert.match(sql, /eur_rounding_mode text not null default 'ceil'/u);
  assert.match(sql, /current_setting\('app\.publish_price_list_version', true\)/u);
  assert.match(sql, /publikovaná verze ceníku je neměnná/u);
  assert.match(sql, /create table purchase_price_entries/u);
  assert.doesNotMatch(sql.slice(sql.indexOf("create table price_list_entries"), sql.indexOf("create table price_list_surcharges")), /purchase/u, "prodejní řádky nemají nákupní sloupec");
  assert.match(sql, /veletrhu lze přiřadit jen publikovanou verzi ceníku/u);
  assert.match(sql, /create unique index event_price_assignments_current_key on event_price_assignments \(event_id, list_kind\) where replaced_at is null/u);
  assert.doesNotMatch(sql.slice(sql.indexOf("create table event_price_assignments"), sql.indexOf("create unique index event_price_assignments_current_key")), /valid_from|start_date/u, "přiřazení nezávisí na datu");
  for (const table of ["versioned_price_lists", "price_list_versions", "price_list_entries", "price_list_surcharges", "purchase_price_entries", "purchase_price_list_companies", "event_price_assignments"]) {
    assert.match(sql, new RegExp(`alter table ${table} enable row level security`, "u"));
  }
  for (const fn of ["create_price_list_version", "publish_price_list_version", "assign_event_price_version", "replace_sale_price_version_rows", "replace_purchase_price_version_rows"]) {
    assert.match(sql, new RegExp(`grant execute on function ${fn}\\([^)]*\\) to service_role`, "u"));
    assert.match(sql, new RegExp(`revoke all on function ${fn}\\([^)]*\\) from public, anon, authenticated`, "u"));
  }
});

// ---------------------------------------------------------------------------------------------
// Three-price correction: migration 20261022130000 and Excel preparation
// ---------------------------------------------------------------------------------------------

test("migrace EUR WORLD: jen přidává sloupce, žádný řádek nepřepisuje", async () => {
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
  const index = migrations.indexOf("20261022130000_price_list_versions_eur_world.sql");
  assert.equal(migrations[index - 1], "20261022120000_price_list_versions.sql");
  const sql = (await readFile(new URL("../supabase/migrations/20261022130000_price_list_versions_eur_world.sql", import.meta.url), "utf8")).toLowerCase();
  assert.match(sql, /add column sale_eur_world numeric\(12, 2\);/u);
  assert.match(sql, /add column amount_eur_world numeric\(12, 2\);/u);
  assert.doesNotMatch(sql, /update\s+(price_list_entries|price_list_surcharges|purchase_price_entries)\b/u, "žádný update existujících (publikovaných) řádků");
  assert.deepEqual([...sql.matchAll(/\bupdate\s+(\w+)/gu)].map((match) => match[1]), ["price_list_versions"], "jediný update = přepnutí stavu uvnitř publikace");
  assert.doesNotMatch(sql, /drop\s+(table|column)|truncate|disable trigger/u);
  assert.deepEqual([...sql.matchAll(/delete from (\w+)/gu)].map((match) => match[1]), ["price_list_entries", "price_list_surcharges"], "mazání jen uvnitř uložení konceptu");
  assert.match(sql, /sale_eur_world is null or eur_mode not in \('derived', 'manual'\)/u, "publikace vyžaduje tři ceny");
  for (const fn of ["replace_sale_price_version_rows", "create_price_list_version", "publish_price_list_version"]) {
    assert.match(sql, new RegExp(`grant execute on function ${fn}\\([^)]*\\) to service_role`, "u"));
  }
});

test("Excel: šablona nese všechny tři ceny; EUR SK platná cena je jen pro čtení", () => {
  assert.deepEqual(PRICE_VERSION_EXCEL_COLUMNS.filter((column) => column.key.startsWith("price_")).map((column) => [column.key, column.importable]), [
    ["price_mode", true],
    ["price_czk", true],
    ["price_eur_sk", false],
    ["price_eur_sk_manual", true],
    ["price_eur_world", true],
  ]);
  const rule = version("v", BASE_LIST.id);
  const derived = saleEntryToExcelRow(entry("e", "v", ITEM.chair, { saleCzk: 516, saleEurWorld: 29 }), { rule, generatorCode: "M57", itemName: "Židle" });
  assert.deepEqual([derived.price_czk, derived.price_eur_sk, derived.price_eur_sk_manual, derived.price_eur_world], [516, 22, null, 29]);
  const manual = saleEntryToExcelRow(entry("e", "v", ITEM.chair, { saleCzk: 516, eurMode: "manual", saleEur: 21, saleEurWorld: 29 }), { rule, itemName: "Židle" });
  assert.deepEqual([manual.price_eur_sk, manual.price_eur_sk_manual], [21, 21]);
  const legacy = saleEntryToExcelRow(entry("e", "v", ITEM.kit, { saleCzk: 20000, eurMode: "direct", saleEur: 850 }), { rule, itemName: "Komplet" });
  assert.deepEqual([legacy.price_eur_sk, legacy.price_eur_world], [828, 850]);
});

test("Excel import (příprava): prázdná buňka = beze změny, #SMAZAT maže, změna CZK nemění EUR WORLD", () => {
  const identity = { catalogItemId: ITEM.chair };
  const current = applyExcelRowToSaleEntry(undefined, { price_czk: 516, price_eur_world: "29" }, identity);
  assert.deepEqual(current, { catalogItemId: ITEM.chair, priceMode: "fixed", saleCzk: 516, eurMode: "derived", saleEurWorld: 29 });
  const czkOnly = applyExcelRowToSaleEntry(current, { price_czk: "600", price_eur_world: "", price_eur_sk: 99 }, identity);
  assert.deepEqual([czkOnly.saleCzk, czkOnly.saleEurWorld, czkOnly.eurMode], [600, 29, "derived"], "EUR WORLD zůstal, sloupec platné EUR SK se ignoruje");
  const manual = applyExcelRowToSaleEntry(czkOnly, { price_eur_sk_manual: "24" }, identity);
  assert.deepEqual([manual.eurMode, manual.saleEur], ["manual", 24]);
  const back = applyExcelRowToSaleEntry(manual, { price_eur_sk_manual: EXCEL_DELETE_MARKER, note: "#smazat" }, identity);
  assert.deepEqual([back.eurMode, back.saleEur, back.saleEurWorld], ["derived", undefined, 29]);
  assert.throws(() => applyExcelRowToSaleEntry(current, { price_czk: EXCEL_DELETE_MARKER }, identity), /chybí cena CZK/u);
});

// ---------------------------------------------------------------------------------------------
// Optimistic concurrency — two editors on one draft (migration 20261022140000)
// ---------------------------------------------------------------------------------------------

test("souběh: druhý editor se starou revizí nepřepíše řádky prvního; dostane 409 a nic se nezapíše", async () => {
  const state = freshState();
  const editorA = await handleSaleRowsSave(request("/api/price-versions/rows", { versionId: "v-draft", expectedRevision: 1, entries: [{ catalogItemId: ITEM.chair, saleCzk: "520", saleEurWorld: "29" }] }), deps(state));
  assert.equal(editorA.status, 200);
  assert.equal(((await editorA.json()) as { revision: number }).revision, 2);
  const editorB = await handleSaleRowsSave(request("/api/price-versions/rows", { versionId: "v-draft", expectedRevision: 1, entries: [{ catalogItemId: ITEM.chair, saleCzk: "999" }] }), deps(state));
  assert.equal(editorB.status, 409);
  const body = (await editorB.json()) as { conflict: boolean; currentRevision: number; error: string };
  assert.deepEqual([body.conflict, body.currentRevision], [true, 2]);
  assert.match(body.error, /mezitím změnil někdo jiný/u);
  assert.equal(state.saved, 1, "druhý zápis se neprovedl");
  const retry = await handleSaleRowsSave(request("/api/price-versions/rows", { versionId: "v-draft", expectedRevision: 2, entries: [{ catalogItemId: ITEM.chair, saleCzk: "999" }] }), deps(state));
  assert.equal(retry.status, 200, "po načtení aktuální revize lze uložit");
});

test("souběh: hlavička, smazání, publikace, archivace a kopie konceptu ověřují revizi", async () => {
  const state = freshState();
  state.versions = state.versions.map((v) => (v.id === "v-draft" ? { ...v, revision: 5 } : v));
  const stale = { versionId: "v-draft", expectedRevision: 4 };
  for (const body of [
    { action: "updateVersion", ...stale, header: { eurRate: 25, eurRoundingStep: 1 } },
    { action: "deleteVersion", ...stale },
    { action: "publishVersion", ...stale },
  ]) {
    const response = await handleSaleAction(request("/api/price-versions", body), deps(state));
    assert.equal(response.status, 409, body.action);
    assert.equal(((await response.json()) as { currentRevision: number }).currentRevision, 5);
  }
  const copy = await handleSaleAction(request("/api/price-versions", { action: "createVersion", priceListId: BASE_LIST.id, basedOnVersionId: "v-draft", basedOnRevision: 4 }), deps(state));
  assert.equal(copy.status, 409, "kopie rozpracovaného konceptu ze starého stavu je odmítnuta");
  assert.equal(state.copies, 0);
  assert.equal((await handleSaleAction(request("/api/price-versions", { action: "createVersion", priceListId: BASE_LIST.id, basedOnVersionId: "v-draft", basedOnRevision: 5 }), deps(state))).status, 201);
  assert.equal((await handleSaleAction(request("/api/price-versions", { action: "archiveVersion", versionId: "v-base", expectedRevision: 7 }), deps(state))).status, 409);
  assert.equal(state.versions.find((v) => v.id === "v-draft")?.status, "draft", "nic se nepublikovalo ani nesmazalo");
  const header = await handleSaleAction(request("/api/price-versions", { action: "updateVersion", versionId: "v-draft", expectedRevision: 5, header: { eurRate: 25, eurRoundingStep: 1 } }), deps(state));
  assert.equal(((await header.json()) as { revision: number }).revision, 6);
});

test("souběh: zápis bez revize je odmítnut (žádné slepé přepsání)", async () => {
  const state = freshState();
  const rows = await handleSaleRowsSave(request("/api/price-versions/rows", { versionId: "v-draft", entries: [] }), deps(state));
  assert.equal(rows.status, 422);
  assert.match(((await rows.json()) as { error: string }).error, /revize/u);
  assert.equal((await handleSaleAction(request("/api/price-versions", { action: "publishVersion", versionId: "v-draft" }), deps(state))).status, 422);
  assert.equal((await handleSaleAction(request("/api/price-versions", { action: "createVersion", priceListId: BASE_LIST.id, basedOnVersionId: "v-draft" }), deps(state))).status, 422);
  assert.equal((await handleSaleAction(request("/api/price-versions", { action: "assign", eventId: "beauty", listKind: "base", versionId: "v-base" }), deps(state))).status, 400);
  assert.equal(state.saved + state.copies + state.assigned.length, 0);
});

test("souběh: nákupní koncept má stejnou ochranu", async () => {
  const state = freshState();
  state.versions.push(version("v-pur-draft", PUR_LIST.id, { status: "draft", versionNo: 2, revision: 3, publishedAt: undefined }));
  const stale = await handlePurchaseRowsSave(request("/api/purchase-prices/rows", { versionId: "v-pur-draft", expectedRevision: 2, entries: [{ catalogItemId: ITEM.chair, purchaseCzk: 1 }] }), deps(state));
  assert.equal(stale.status, 409);
  const ok = await handlePurchaseRowsSave(request("/api/purchase-prices/rows", { versionId: "v-pur-draft", expectedRevision: 3, entries: [{ catalogItemId: ITEM.chair, purchaseCzk: 1 }] }), deps(state));
  assert.equal(((await ok.json()) as { revision: number }).revision, 4);
});

test("souběh: přiřazení veletrhu, které mezitím změnil někdo jiný, je odmítnuto", async () => {
  const state = freshState();
  state.versions.push(version("v-base-2", BASE_LIST.id, { versionNo: 3 }));
  const first = await handleSaleAction(request("/api/price-versions", { action: "assign", eventId: "beauty", listKind: "base", versionId: "v-base", expectedCurrentVersionId: null }), deps(state));
  assert.equal(first.status, 200);
  const second = await handleSaleAction(request("/api/price-versions", { action: "assign", eventId: "beauty", listKind: "base", versionId: "v-base-2", expectedCurrentVersionId: null }), deps(state));
  assert.equal(second.status, 409, "druhý uživatel viděl „nepřiřazeno“, mezitím je přiřazena v-base");
  assert.equal(currentEventAssignment(state.assignments, "beauty", "base")?.priceListVersionId, "v-base");
  const informed = await handleSaleAction(request("/api/price-versions", { action: "assign", eventId: "beauty", listKind: "base", versionId: "v-base-2", expectedCurrentVersionId: "v-base" }), deps(state));
  assert.equal(informed.status, 200);
});

test("pokrytí cenových režimů: starší verze bez EUR WORLD je v tom režimu neúplná, nic se nedopočítává", () => {
  const legacy = versionTrackCoverage([entry("a", "v", ITEM.chair, { saleCzk: 516 }), entry("b", "v", ITEM.kit, { saleCzk: 20000, eurMode: "direct", saleEur: 850 }), entry("c", "v", ITEM.table, { priceMode: "individual", eurMode: "none" })], [], version("v", BASE_LIST.id));
  assert.deepEqual([legacy.fixedRows, legacy.missingRows], [2, { CZK: 0, EUR_SK: 0, EUR_WORLD: 1 }]);
  assert.deepEqual(uncoveredTracks(legacy), ["EUR_WORLD"]);
  const complete = versionTrackCoverage([entry("a", "v", ITEM.chair, { saleCzk: 516, saleEurWorld: 29 })], [{ id: "s", versionId: "v", targetKind: "variant", variantId: VARIANT.blue, amountCzk: 30, eurMode: "derived" }], version("v", BASE_LIST.id));
  assert.deepEqual(uncoveredTracks(complete), ["EUR_WORLD"], "doplatek bez EUR WORLD");
  assert.deepEqual(complete.missingSurcharges, { CZK: 0, EUR_SK: 0, EUR_WORLD: 1 });
  assert.deepEqual(uncoveredTracks(versionTrackCoverage([entry("a", "v", ITEM.chair, { saleCzk: 516, saleEurWorld: 29 })], [], version("v", BASE_LIST.id))), []);
});

test("API: registr nese pokrytí cenových režimů každé verze", async () => {
  const response = await handleSaleRegister(request("/api/price-versions"), deps(freshState()));
  const body = (await response.json()) as { coverage: Record<string, { missingRows: Record<string, number> }> };
  assert.equal(body.coverage["v-base"]?.missingRows.EUR_WORLD, 1);
  assert.equal(body.coverage["v-base"]?.missingRows.CZK, 0);
});

test("migrace revizí: poslední, sloupec s výchozí hodnotou, žádný řádek cen se nepřepisuje, staré podpisy bez revize zrušeny", async () => {
  const migrations = readdirSync(new URL("../supabase/migrations/", import.meta.url)).filter((name) => name.endsWith(".sql")).sort();
  assert.equal(migrations.at(-1), "20261022140000_price_list_versions_revision.sql");
  assert.equal(migrations.at(-2), "20261022130000_price_list_versions_eur_world.sql");
  const sql = (await readFile(new URL("../supabase/migrations/20261022140000_price_list_versions_revision.sql", import.meta.url), "utf8")).toLowerCase();
  assert.match(sql, /add column revision integer not null default 1/u);
  assert.doesNotMatch(sql, /update\s+(price_list_entries|price_list_surcharges|purchase_price_entries|event_price_assignments\s+set\s+(?!replaced))/u);
  assert.doesNotMatch(sql, /drop\s+(table|column)|truncate|disable trigger/u);
  for (const signature of ["replace_sale_price_version_rows(uuid, jsonb, jsonb)", "replace_purchase_price_version_rows(uuid, jsonb)", "publish_price_list_version(uuid, text)", "create_price_list_version(uuid, uuid, text)", "assign_event_price_version(text, text, uuid, text, text)"]) {
    assert.ok(sql.includes(`drop function if exists ${signature}`), signature);
  }
  assert.match(sql, /using errcode = 'p0409'/u);
  for (const fn of ["replace_sale_price_version_rows", "replace_purchase_price_version_rows", "update_price_list_version_header", "delete_price_list_version_draft", "archive_price_list_version", "publish_price_list_version", "create_price_list_version", "assign_event_price_version"]) {
    assert.match(sql, new RegExp(`grant execute on function ${fn}\\([^)]*\\) to service_role`, "u"));
  }
  assert.match(sql, /'revision'\]\) = \(to_jsonb\(old\)/u, "archivace ignoruje počítadlo revize, ne jiné změny");
});

test("koncept, ze kterého vychází jiná verze, nelze smazat — srozumitelná zpráva, nic se nesmaže", async () => {
  const state = freshState();
  state.versions.push(version("v-copy", BASE_LIST.id, { status: "draft", versionNo: 3, basedOnVersionId: "v-draft", publishedAt: undefined }));
  const response = await handleSaleAction(request("/api/price-versions", { action: "deleteVersion", versionId: "v-draft", expectedRevision: 1 }), deps(state));
  assert.equal(response.status, 409);
  assert.match(((await response.json()) as { error: string }).error, /vychází z něj v3/u);
  assert.ok(state.versions.some((v) => v.id === "v-draft"));
});

test("tabulka cen: kód = ABF kód karty, u interní položky generátorový kód; nic se neukládá do ceníku", () => {
  assert.deepEqual(priceItemCode({ abfCode: "M57", internalCode: "M57" }), { code: "M57", kind: "abf" });
  assert.deepEqual(priceItemCode({ abfCode: null, internalCode: "GRAPHICS-FASCIA" }), { code: "GRAPHICS-FASCIA", kind: "generator" });
  assert.deepEqual(priceItemCode({ abfCode: " ", internalCode: "INT-PANEL-950" }), { code: "INT-PANEL-950", kind: "generator" });
  assert.equal(priceItemCode({}), undefined);
  assert.equal(priceItemCode(undefined), undefined);
  assert.ok(!("abfCode" in entry("e", "v", ITEM.chair, { saleCzk: 1 })), "řádek ceníku kód nenese");
});

test("tabulka cen: hledání podle kódu i názvu (bez diakritiky), řazení podle kódu přirozeně, bez kódu na konec", () => {
  const items = [
    { displayName: "Elektřina 10 kW", abfCode: "L10" },
    { displayName: "Elektřina 2 kW", abfCode: "L02" },
    { displayName: "Elektřina 9 kW", abfCode: "L9" },
    { displayName: "Bez kódu" },
    { displayName: "Grafika límec", internalCode: "GRAPHICS-FASCIA" },
    { displayName: "Židle", abfCode: "M57" },
  ];
  assert.deepEqual(items.slice().sort(comparePriceItemsByCode).map((item) => item.displayName), ["Grafika límec", "Elektřina 2 kW", "Elektřina 9 kW", "Elektřina 10 kW", "Židle", "Bez kódu"]);
  assert.ok(matchesPriceItemSearch(items[5], "m57"));
  assert.ok(matchesPriceItemSearch(items[4], "fascia"));
  assert.ok(matchesPriceItemSearch(items[0], "elektrina"), "bez diakritiky");
  assert.ok(!matchesPriceItemSearch(items[3], "L0"));
  assert.ok(matchesPriceItemSearch(items[3], "  "), "prázdné hledání ukáže vše");
});

test("tabulka cen: kód je jen zobrazovací — výsledek výpočtu se kódem karty nemění", () => {
  const before = PRICE_TRACKS.map((track) => resolveSalePrice(context({ track }), ITEM.chair).amountNet);
  assert.deepEqual(before, [516, 22, 29]);
  assert.deepEqual(Object.keys(resolveSalePrice(context(), ITEM.chair)).sort(), ["amountNet", "currency", "origin", "status", "track", "unitCode"].filter((key) => key !== "unitCode" || resolveSalePrice(context(), ITEM.chair).unitCode).sort());
});
