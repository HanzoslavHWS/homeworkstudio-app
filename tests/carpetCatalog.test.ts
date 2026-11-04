import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { CARPET_BASE_SHADE, planCarpetCatalog, planSwatchPhotos, swatchBookVariantInputs, swatchPhotoStorageKey, validateSwatchManifest, type SwatchManifest } from "../domain/carpetCatalogImport.ts";
import { parseCatalogVariantSetInput, variantImageState, variantsForCard, variantSeriesGroups, type CatalogVariant, type CatalogVariantSet } from "../domain/catalogVariants.ts";
import { duplicateRowKeys, findSaleEntry, parseSaleEntryInput, priceKitVersioned, resolveSalePrice, type PriceListVersion, type SalePriceBook, type SalePriceEntry, type VersionedPricingContext } from "../domain/priceVersions.ts";
import { cardSeriesPrices } from "../domain/catalogCardPrices.ts";
import type { CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";
import type { CatalogPackageItem } from "../domain/catalogPackages.ts";

const manifest = JSON.parse(readFileSync(new URL("../data/catalog/serbusCarpetSwatches.json", import.meta.url), "utf8")) as SwatchManifest;
const IDS = { M01: "11111111-0000-4000-8000-000000000001", M02: "11111111-0000-4000-8000-000000000002", M04: "11111111-0000-4000-8000-000000000004" } as const;
const SET_ID = "22222222-0000-4000-8000-000000000000";

/** The swatch book exactly as the import would build it, with stable test ids. */
function swatchBook(): CatalogVariantSet {
  const inputs = swatchBookVariantInputs({ manifest, itemIdOf: (code) => IDS[code] });
  const parsed = parseCatalogVariantSetInput({ code: "KOBERCE-SERBUS", name: "Koberce SERBUS", kind: "carpet", variants: inputs });
  return {
    id: SET_ID, code: parsed.code, name: parsed.name, kind: parsed.kind, isActive: true,
    variants: parsed.variants.map((variant, index): CatalogVariant => ({ ...variant, id: `33333333-0000-4000-8000-${String(index).padStart(12, "0")}`, variantSetId: SET_ID, sortOrder: index })),
  };
}
const book = swatchBook();
const byCode = (code: string) => book.variants.find((variant) => variant.code === code)!;

function card(abfCode: "M01" | "M02" | "M04", overrides: Partial<CatalogItemAdmin> = {}): CatalogItemAdmin {
  return { id: IDS[abfCode], internalCode: abfCode, abfCode, itemType: "PRODUCT", kind: "floor_finish", category: "product-carpets", unit: "m²", unitCode: "m2", lifecycleStatus: "needs_review", displayName: abfCode, document: {}, updatedAt: "2026-11-03T00:00:00Z", createdAt: "2026-11-03T00:00:00Z", ...overrides } as CatalogItemAdmin;
}

// ---------------------------------------------------------------------------------------------
// Manifest, swatch book, card scopes
// ---------------------------------------------------------------------------------------------

test("manifest: 56 odstínů (PODIUM / PLAT 23, REVEXPO 33), unikátní kódy i obrázky, každý s vlastním obrázkem", () => {
  assert.deepEqual(validateSwatchManifest(manifest), []);
  assert.equal(manifest.shades.length, 56);
  assert.equal(manifest.shades.filter((shade) => shade.series === "PODIUM-PLAT").length, 23);
  assert.equal(manifest.shades.filter((shade) => shade.series === "REVEXPO").length, 33);
  assert.ok(manifest.shades.every((shade) => shade.code === `${shade.series}-${shade.shadeCode}`));
  const odd = manifest.shades.filter((shade) => shade.imageCheck !== "file_name_matches_code");
  assert.deepEqual(odd.map((shade) => shade.code), ["PODIUM-PLAT-4962"], "jen 4962 má jinak pojmenovaný soubor");
  assert.match(odd[0]!.note ?? "", /pozice/u);
  assert.equal(odd[0]!.photoReview, "manual", "4962 se bez ručního ověření nenahraje");
});

test("vzorník: jeden KOBERCE-SERBUS s 56 barvami, správné řady, 020 → M01, ostatní → M02 (rozdíl ceny)", () => {
  assert.equal(book.variants.length, 56);
  assert.equal(new Set(book.variants.map((variant) => variant.code)).size, 56);
  assert.deepEqual(variantSeriesGroups(book.variants).map((group) => [group.series, group.variants.length]), [["PODIUM-PLAT", 23], ["REVEXPO", 33]]);
  assert.equal(byCode(CARPET_BASE_SHADE).priceItemId, IDS.M01);
  assert.equal(byCode(CARPET_BASE_SHADE).surchargeRule, "none");
  assert.ok(book.variants.filter((variant) => variant.code !== CARPET_BASE_SHADE).every((variant) => variant.priceItemId === IDS.M02 && variant.surchargeRule === "price_difference"));
  assert.ok(book.variants.every((variant) => variant.imageSource?.status === "pending_permission" && variant.imageSource.sourceImageUrl), "obrázky jen odkazem, čekají na oprávnění");
  assert.ok(book.variants.every((variant) => !variant.photoAsset && !variant.textureAsset), "nic se nekopíruje, žádná vymyšlená textura");
});

test("karty: M01 jen PLAT 020, M02 ostatních 55, M04 všech 56 (včetně 020)", () => {
  assert.deepEqual(variantsForCard([book], IDS.M01, { variantSetId: SET_ID, scope: "billed_by_card" }).map((variant) => variant.code), [CARPET_BASE_SHADE]);
  const m02 = variantsForCard([book], IDS.M02, { variantSetId: SET_ID, scope: "billed_by_card" });
  assert.equal(m02.length, 55);
  assert.ok(!m02.some((variant) => variant.code === CARPET_BASE_SHADE));
  const m04 = variantsForCard([book], IDS.M04, { variantSetId: SET_ID, scope: "all_variants" });
  assert.equal(m04.length, 56);
  assert.ok(m04.some((variant) => variant.code === CARPET_BASE_SHADE));
});

test("obrázky: vlastní fotka = náhled, odkaz dodavatele = čeká na oprávnění, nic = chybí", () => {
  assert.equal(variantImageState(byCode("REVEXPO-1335")), "pending_permission");
  assert.equal(variantImageState({ photoAsset: { id: "a", storageKey: "catalog/x.jpg", originalFileName: "x.jpg", mimeType: "image/jpeg", size: 1, createdAt: "2026-11-03", category: "catalog-photo" } }), "photo");
  assert.equal(variantImageState({}), "missing");
  assert.equal(variantImageState({ imageSource: { status: "rejected", sourceImageUrl: "https://example.com/x.jpg" } }), "rejected");
});

// ---------------------------------------------------------------------------------------------
// Prices: variant -> product line -> card, M04 0 Kč, three tracks
// ---------------------------------------------------------------------------------------------

const version: PriceListVersion = { id: "v1", priceListId: "base", versionNo: 1, revision: 1, status: "published", eurRate: 25, eurRoundingMode: "ceil", eurRoundingStep: 1 };
const row = (id: string, catalogItemId: string, saleCzk: number, extra: Partial<SalePriceEntry> = {}): SalePriceEntry => ({ id, versionId: "v1", catalogItemId, priceMode: "fixed", saleCzk, eurMode: "derived", saleEurWorld: saleCzk / 20, unitCode: "m2", ...extra });
const entries: readonly SalePriceEntry[] = [
  row("e1", IDS.M01, 190),
  row("e2", IDS.M02, 220),
  row("e3", IDS.M02, 240, { variantSeries: "REVEXPO" }),
  row("e4", IDS.M04, 0),
];
const priceBook: SalePriceBook = { list: { id: "base", code: "TEST", name: "Test", kind: "base", isActive: true }, version, entries, surcharges: [] };
const seriesOf = new Map(book.variants.map((variant) => [variant.id, variant.series]));
const context = (track: "CZK" | "EUR_SK" | "EUR_WORLD" = "CZK"): VersionedPricingContext => ({ track, base: priceBook, priceCategoryOf: () => "standard", variantSeriesOf: (id) => seriesOf.get(id) });

test("ceny: M01 + 020 = 190, M02 + PODIUM = 220, M02 + REVEXPO = 240 (řada), M04 + REVEXPO = 0 (cena řady M02 se nepoužije)", () => {
  assert.equal(resolveSalePrice(context(), IDS.M01, byCode(CARPET_BASE_SHADE).id).amountNet, 190);
  assert.equal(resolveSalePrice(context(), IDS.M02, byCode("PODIUM-PLAT-035").id).amountNet, 220);
  const revexpo = resolveSalePrice(context(), IDS.M02, byCode("REVEXPO-1335").id);
  assert.equal(revexpo.amountNet, 240);
  assert.equal(revexpo.origin?.variantSeries, "REVEXPO");
  const pva = resolveSalePrice(context(), IDS.M04, byCode("REVEXPO-1335").id);
  assert.equal(pva.status, "priced");
  assert.equal(pva.amountNet, 0, "0 Kč je platná cena");
});

test("ceny: konkrétní barva má přednost před řadou; řádek řady nikdy nepřebije základní cenu bez varianty", () => {
  const own = [...entries, row("e5", IDS.M02, 260, { variantId: byCode("REVEXPO-4347").id })];
  assert.equal(findSaleEntry(own, IDS.M02, byCode("REVEXPO-4347").id, "REVEXPO")?.saleCzk, 260);
  assert.equal(findSaleEntry(own, IDS.M02, byCode("REVEXPO-1335").id, "REVEXPO")?.saleCzk, 240);
  assert.equal(findSaleEntry(own, IDS.M02)?.saleCzk, 220, "bez varianty jen řádek karty");
});

test("nula vs chybějící cena: M04 bez řádku = K nacenění, s řádkem 0 Kč = priced 0", () => {
  const withoutM04: SalePriceBook = { ...priceBook, entries: entries.filter((entry) => entry.catalogItemId !== IDS.M04) };
  const missing = resolveSalePrice({ ...context(), base: withoutM04 }, IDS.M04);
  assert.equal(missing.status, "missing");
  assert.equal(missing.amountNet, undefined);
  assert.deepEqual([resolveSalePrice(context(), IDS.M04).status, resolveSalePrice(context(), IDS.M04).amountNet], ["priced", 0]);
});

test("tři ceny: EUR SK podle kurzu verze, EUR WORLD jen zadaná (nezdědí přepočet z CZK)", () => {
  const variantId = byCode("REVEXPO-1335").id;
  assert.equal(resolveSalePrice(context("EUR_SK"), IDS.M02, variantId).amountNet, Math.ceil(240 / 25));
  assert.equal(resolveSalePrice(context("EUR_WORLD"), IDS.M02, variantId).amountNet, 12);
  const noWorld: SalePriceBook = { ...priceBook, entries: [row("x", IDS.M02, 240, { variantSeries: "REVEXPO", saleEurWorld: undefined })] };
  assert.equal(resolveSalePrice({ ...context("EUR_WORLD"), base: noWorld }, IDS.M02, variantId).status, "missing");
});

test("vstup ceníku: řádek je buď pro barvu, nebo pro řadu; řada se odliší v kontrole duplicit", () => {
  assert.throws(() => parseSaleEntryInput({ catalogItemId: IDS.M02, variantId: byCode("REVEXPO-1335").id.replace(/^3/u, "4"), variantSeries: "REVEXPO", saleCzk: 240 }, 0), /řadu/u);
  assert.equal(parseSaleEntryInput({ catalogItemId: IDS.M02, variantSeries: "REVEXPO", saleCzk: 240 }, 0).variantSeries, "REVEXPO");
  assert.equal(parseSaleEntryInput({ catalogItemId: IDS.M04, saleCzk: 0 }, 0).saleCzk, 0, "0 projde jako cena");
  assert.deepEqual(duplicateRowKeys([{ catalogItemId: IDS.M02 }, { catalogItemId: IDS.M02, variantSeries: "REVEXPO" }]), []);
  assert.equal(duplicateRowKeys([{ catalogItemId: IDS.M02, variantSeries: "REVEXPO" }, { catalogItemId: IDS.M02, variantSeries: "REVEXPO" }]).length, 1);
});

test("karta M02: sazba podle řad — PODIUM 220 (základní cena karty), REVEXPO 240 (cena řady)", () => {
  const rows = cardSeriesPrices(version, entries, IDS.M02, variantsForCard([book], IDS.M02, { variantSetId: SET_ID, scope: "billed_by_card" }));
  assert.deepEqual(rows.map((line) => [line.series, line.variantCount, line.source, line.prices.czk.amount]), [["PODIUM-PLAT", 22, "card", 220], ["REVEXPO", 33, "series", 240]]);
  const m04 = cardSeriesPrices(version, entries, IDS.M04, variantsForCard([book], IDS.M04, { variantSetId: SET_ID, scope: "all_variants" }));
  assert.ok(m04.every((line) => line.prices.czk.status === "priced" && line.prices.czk.amount === 0));
});

// ---------------------------------------------------------------------------------------------
// Kit P86 model: base carpet M01, 4 m²
// ---------------------------------------------------------------------------------------------

const kitLine: CatalogPackageItem = {
  id: "line", packageItemId: "p86", lineKey: "koberec", lineKind: "item", childItemId: IDS.M01, quantity: 4, unitCode: "m2", includedInPackage: true, sortOrder: 1, note: null,
  variantSetId: SET_ID, defaultVariantId: byCode(CARPET_BASE_SHADE).id,
  substitutes: [{ substituteItemId: IDS.M04, surchargeRule: "price_difference", quantityFactor: 1 }],
};
const kitBook: SalePriceBook = { ...priceBook, entries: [...entries, row("kit", "p86", 10000, { unitCode: "ks" })] };
const kit = (selection?: Record<string, string>) => priceKitVersioned({ context: { ...context(), base: kitBook }, kitItemId: "p86", lines: [kitLine], variantSets: [book], selections: selection ? [{ lineKey: "koberec", ...selection }] : [], agreementItemIds: new Set([IDS.M04]) });

test("komplet: šedá 0 Kč, PODIUM (220 − 190) × 4 = 120 Kč, REVEXPO (240 − 190) × 4 = 200 Kč; účtovaná položka M02", () => {
  const grey = kit();
  assert.equal(grey.lines[0]!.surcharge, undefined);
  assert.equal(grey.totalNet, 10000);
  assert.equal(grey.lines[0]!.effectiveItemId, IDS.M01);
  const podium = kit({ variantId: byCode("PODIUM-PLAT-035").id });
  assert.equal(podium.lines[0]!.surcharge?.amountNet, 120);
  assert.equal(podium.lines[0]!.effectiveItemId, IDS.M02, "výstup nese ABF kód M02, ne M01");
  assert.equal(podium.totalNet, 10120);
  const revexpo = kit({ variantId: byCode("REVEXPO-1335").id });
  assert.equal(revexpo.lines[0]!.surcharge?.amountNet, 200);
  assert.equal(revexpo.lines[0]!.effectiveItemId, IDS.M02);
  assert.equal(revexpo.lines[0]!.variantId, byCode("REVEXPO-1335").id, "zvolená barva zůstává");
  assert.equal(revexpo.totalNet, 10200);
  assert.equal(revexpo.lines.length, 1, "koberec se nahrazuje, nikdy se neúčtují dva");
});

test("komplet + M04: jen s důvodem; nahradí koberec v libovolné barvě, cena kompletu se nesníží, žádný záporný příplatek", () => {
  const noReason = kit({ substituteItemId: IDS.M04, substituteVariantId: byCode("REVEXPO-1335").id });
  assert.equal(noReason.lines[0]!.effectiveItemId, IDS.M01, "bez důvodu se M04 nepoužije");
  assert.ok(noReason.issues.some((issue) => /dohody/u.test(issue)));
  const agreed = kit({ substituteItemId: IDS.M04, substituteVariantId: byCode("REVEXPO-1335").id, reason: "Dohoda s PVA — společný stánek" });
  const line = agreed.lines[0]!;
  assert.equal(line.effectiveItemId, IDS.M04);
  assert.equal(line.variantId, byCode("REVEXPO-1335").id);
  assert.deepEqual(line.agreement, { reason: "Dohoda s PVA — společný stánek" });
  assert.equal(line.surcharge?.amountNet, 0);
  assert.equal(line.surcharge?.reason, "floor_zero");
  assert.equal(agreed.totalNet, 10000, "cena kompletu se automaticky nesnižuje");
  const greyPva = kit({ substituteItemId: IDS.M04, substituteVariantId: byCode(CARPET_BASE_SHADE).id, reason: "Dohoda" });
  assert.equal(greyPva.lines[0]!.effectiveItemId, IDS.M04, "M04 smí i šedou 020");
});

// ---------------------------------------------------------------------------------------------
// Import plan: idempotent, never rewrites
// ---------------------------------------------------------------------------------------------

test("import: prázdné DEV → založit 3 karty, vzorník a 56 barev; po založení nic k zápisu (idempotence)", () => {
  const empty = planCarpetCatalog({ manifest, items: [], variantSets: [] });
  assert.deepEqual(empty.cards.map((cardPlan) => cardPlan.action), ["create", "create", "create"]);
  assert.equal(empty.swatchBook, "create");
  assert.equal(empty.newVariants.length, 56);
  assert.equal(empty.upToDate, false);
  const linked = (abf: "M01" | "M02" | "M04", scope: "billed_by_card" | "all_variants") => card(abf, { document: { variantOptions: { variantSetId: SET_ID, scope }, ...(abf === "M04" ? { usageAgreement: { payerLabel: "PVA" } } : {}) } });
  const done = planCarpetCatalog({ manifest, items: [linked("M01", "billed_by_card"), linked("M02", "billed_by_card"), linked("M04", "all_variants")], variantSets: [book] });
  assert.equal(done.upToDate, true);
  assert.equal(done.keptVariants.length, 56);
});

test("import: existující odlišná karta i ručně upravená barva se nepřepíší — jen konflikt", () => {
  const plan = planCarpetCatalog({ manifest, items: [card("M01", { kind: "furniture" }), card("M02"), card("M04")], variantSets: [{ ...book, variants: book.variants.map((variant) => (variant.code === "REVEXPO-1335" ? { ...variant, series: "JINA" } : variant)) }] });
  assert.equal(plan.cards[0]!.action, "conflict");
  assert.deepEqual(plan.variantConflicts.map((conflict) => conflict.code), ["REVEXPO-1335"]);
  const kept = swatchBookVariantInputs({ manifest, stored: { ...book, variants: book.variants.slice(0, 2).map((variant) => ({ ...variant, name: "Ručně přejmenováno" })) }, itemIdOf: (code) => IDS[code] });
  assert.equal(kept.length, 56);
  assert.deepEqual(kept.slice(0, 2).map((variant) => variant.name), ["Ručně přejmenováno", "Ručně přejmenováno"], "ruční úprava zůstává");
});

test("migrace: jen přidává (žádné drop table / delete / truncate), klíč ceníku rozšířen o řadu", () => {
  const sql = readFileSync(new URL("../supabase/migrations/20261103120000_catalog_variant_series_prices.sql", import.meta.url), "utf8").toLowerCase();
  assert.doesNotMatch(sql, /drop\s+table|drop\s+column|truncate|delete\s+from\s+(?!price_list_entries where version_id = p_version_id|price_list_surcharges where version_id = p_version_id)/u);
  assert.match(sql, /coalesce\(variant_series, ''\)/u);
  assert.match(sql, /add column variant_series/u);
});

// ---------------------------------------------------------------------------------------------
// Swatch photos (approved 2026-11-03): deterministic R2 keys, idempotent, 4962 held back
// ---------------------------------------------------------------------------------------------

test("fotky: 55 k nahrání, 4962 k ruční kontrole; klíč R2 = kód odstínu (žádné duplicity)", () => {
  const plan = planSwatchPhotos({ manifest, set: book });
  assert.equal(plan.filter((entry) => entry.action === "upload").length, 55);
  assert.deepEqual(plan.filter((entry) => entry.action === "manual_review").map((entry) => entry.code), ["PODIUM-PLAT-4962"]);
  const keys = plan.flatMap((entry) => (entry.action === "upload" ? [entry.storageKey] : []));
  assert.equal(new Set(keys).size, 55);
  assert.equal(swatchPhotoStorageKey("REVEXPO-1335"), "catalog/furniture/koberce-serbus/photos/revexpo-1335.jpg");
  const upload = plan.find((entry) => entry.code === "REVEXPO-1335");
  assert.ok(upload?.action === "upload" && upload.sourceImageUrl.endsWith("/REVEXPO-1335.jpg"), "každý odstín svůj vlastní obrázek");
});

test("fotky: opakovaný běh nic nenahraje a ručně nahranou fotku nepřepíše", () => {
  const photo = (code: string, storageKey = swatchPhotoStorageKey(code)) => ({ id: code, storageKey, originalFileName: `${code}.jpg`, mimeType: "image/jpeg", size: 1, createdAt: "2026-11-03", category: "catalog-photo" as const });
  const done = { ...book, variants: book.variants.map((variant) => (variant.code === "PODIUM-PLAT-4962" ? variant : { ...variant, photoAsset: photo(variant.code) })) };
  assert.equal(planSwatchPhotos({ manifest, set: done }).filter((entry) => entry.action === "upload").length, 0);
  const manual = { ...book, variants: book.variants.map((variant) => (variant.code === "REVEXPO-1335" ? { ...variant, photoAsset: photo("x", "catalog/furniture/koberce-serbus/photos/rucni.jpg") } : variant)) };
  const entry = planSwatchPhotos({ manifest, set: manual }).find((candidate) => candidate.code === "REVEXPO-1335");
  assert.equal(entry?.action, "keep");
  assert.match(entry?.action === "keep" ? entry.reason : "", /ručně/u);
});

test("obrázek k ruční kontrole má vlastní stav (ne „čeká na oprávnění“); fotka není 3D textura", () => {
  assert.equal(variantImageState({ imageSource: { status: "approved", manualReview: true, sourceImageUrl: "https://example.com/x.jpg" } }), "manual_review");
  assert.equal(variantImageState({ imageSource: { status: "approved", sourceImageUrl: "https://example.com/x.jpg" } }), "missing");
  assert.ok(book.variants.every((variant) => !variant.textureAsset));
});
