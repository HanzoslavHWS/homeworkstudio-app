import assert from "node:assert/strict";
import test from "node:test";
import { boothTypes } from "../data/booths.ts";
import { planP86Card, planP86Lines, p86KitLines } from "../domain/p86CatalogImport.ts";
import { adaptCatalogItemToBoothType, selectGeneratorBooths } from "../domain/generatorBooths.ts";
import { computeReadiness, type CatalogItemAdmin } from "../domain/catalogItemsAdmin.ts";
import { priceKitVersioned, type PriceListVersion, type SalePriceBook, type SalePriceEntry } from "../domain/priceVersions.ts";
import { validateKitLines, assignKitLineKeys, type CatalogPackageItem } from "../domain/catalogPackages.ts";
import type { CatalogVariantSet } from "../domain/catalogVariants.ts";
import type { BoothType } from "../domain/models.ts";

const seed = boothTypes.find((booth) => booth.internalCode === "P86")!;
const ID = { p86: "p86-uuid", m01: "m01-uuid", m02: "m02-uuid", m04: "m04-uuid", m91: "m91-uuid", set: "set-uuid", grey: "v-020", podium: "v-035", revexpo: "v-1335" } as const;

function card(id: string, code: string, kind: CatalogItemAdmin["kind"], itemType: CatalogItemAdmin["itemType"], extra: Partial<CatalogItemAdmin> = {}): CatalogItemAdmin {
  return { id, internalCode: code, abfCode: code, itemType, kind, lifecycleStatus: "active", displayName: code, category: "x", unit: "ks", document: {}, createdAt: "2026-11-04", updatedAt: "2026-11-04", packageItems: [], ...extra } as CatalogItemAdmin;
}
const catalog = [card(ID.m01, "M01", "floor_finish", "PRODUCT"), card(ID.m02, "M02", "floor_finish", "PRODUCT"), card(ID.m04, "M04", "floor_finish", "PRODUCT"), card(ID.m91, "M91", "graphics_service", "SERVICE"), card("m57-uuid", "M57", "furniture", "PRODUCT")];
const swatchBook: CatalogVariantSet = {
  id: ID.set, code: "KOBERCE-SERBUS", name: "Koberce SERBUS", kind: "carpet", isActive: true,
  variants: [
    { id: ID.grey, variantSetId: ID.set, code: "PODIUM-PLAT-020", name: "PODIUM / PLAT 020", series: "PODIUM-PLAT", priceItemId: ID.m01, surchargeRule: "none", isActive: true, sortOrder: 0 },
    { id: ID.podium, variantSetId: ID.set, code: "PODIUM-PLAT-035", name: "PODIUM / PLAT 035", series: "PODIUM-PLAT", priceItemId: ID.m02, surchargeRule: "price_difference", isActive: true, sortOrder: 1 },
    { id: ID.revexpo, variantSetId: ID.set, code: "REVEXPO-1335", name: "REVEXPO 1335", series: "REVEXPO", priceItemId: ID.m02, surchargeRule: "price_difference", isActive: true, sortOrder: 2 },
  ],
};

/** The planned insert row as the catalog will read it back. */
function plannedP86(): CatalogItemAdmin {
  const plan = planP86Card(seed, catalog);
  assert.equal(plan.action, "create");
  const row = (plan as { row: Record<string, unknown> }).row;
  return { id: ID.p86, internalCode: row.internal_code, abfCode: row.abf_code, itemType: row.item_type, kind: row.kind, lifecycleStatus: row.lifecycle_status, displayName: row.display_name, category: row.category, unit: row.unit, unitCode: row.unit_code, document: row.document, createdAt: "2026-11-04", updatedAt: "2026-11-04", packageItems: [] } as unknown as CatalogItemAdmin;
}

test("import: jen jedna karta P86 — BOOTH, kódy P86, K doplnění, bez reviewedAt, kanonický dokument beze změny", () => {
  const p86 = plannedP86();
  assert.equal(p86.internalCode, "P86");
  assert.equal(p86.abfCode, "P86");
  assert.equal(p86.itemType, "BOOTH");
  assert.equal(p86.kind, "booth");
  assert.equal(p86.lifecycleStatus, "needs_review");
  assert.equal(p86.document.reviewedAt, undefined);
  assert.equal(p86.document.lifecycleStatus, undefined);
  const { sourceSystem: _s, sourceKey: _k, ...document } = p86.document;
  assert.deepEqual(document, JSON.parse(JSON.stringify(seed)), "GLB, rozměry, tiskové plochy, pohledy i starý obsah zůstávají");
});

test("import: P86 už v katalogu = beze změny; kód P86 u jiné karty = konflikt (nic se nezapíše)", () => {
  assert.equal(planP86Card(seed, [...catalog, card(ID.p86, "P86", "booth", "BOOTH")]).action, "keep");
  assert.equal(planP86Card(seed, [...catalog, card("x", "P86", "furniture", "PRODUCT")]).action, "conflict");
  assert.equal(planP86Card(seed, [...catalog, card("a", "P86", "booth", "BOOTH"), card("b", "P86", "booth", "BOOTH")]).action, "conflict");
});

test("generátor: adaptér načte P86 z katalogu se stejnou geometrií, 9 tiskovými plochami, 4 pohledy a GLB", () => {
  const booth = adaptCatalogItemToBoothType(plannedP86());
  assert.equal(booth.id, "koje-2x2", "starší projekty (boothId koje-2x2) se dál najdou");
  assert.deepEqual([booth.widthMm, booth.depthMm, booth.heightMm], [2000, 2000, 2500]);
  assert.equal(booth.printSurfaces.length, 9);
  assert.ok(booth.printSurfaces.some((surface) => surface.id === "fascia-print"));
  assert.equal((booth.defaultViews ?? []).length, 4);
  assert.match(booth.modelUrl ?? "", /koje-2x2\/HWS_BOOTH_KOJE_2000x2000\.glb$/u);
  assert.deepEqual(computeReadiness(plannedP86()).issues, [], "po kontrole lze aktivovat standardně");
  assert.deepEqual(selectGeneratorBooths([plannedP86()]), [], "neaktivní P86 se v běžném výběru nenabízí");
  assert.equal(selectGeneratorBooths([{ ...plannedP86(), lifecycleStatus: "active" }]).length, 1, "po aktivaci ano");
});

test("obsah: koberec M01 4 m² + grafika M91 2 bm (s odpovídající zahrnutou plochou límce), bez řádku „Stavba stánku“", () => {
  const plan = planP86Lines({ p86Id: ID.p86, items: [...catalog, plannedP86()], variantSets: [swatchBook] });
  assert.equal(plan.action, "create");
  const lines = (plan as { lines: ReturnType<typeof p86KitLines> }).lines;
  assert.deepEqual(lines.map((line) => [line.childItemId, line.quantity, line.unitCode, line.includedInPackage]), [[ID.m01, 4, "m2", true], [ID.m91, 2, "bm", true]]);
  assert.equal(lines[0]!.defaultVariantId, ID.grey);
  assert.deepEqual(lines[1]!.printAllowance, [{ surfaceTypeId: "fascia", unitCode: "bm", includedQuantity: 2 }]);
  assert.ok(!lines.some((line) => /stavba/iu.test(line.label ?? "") || line.lineKind === "text"));
  const itemsById = new Map([...catalog, plannedP86()].map((item) => [item.id, { id: item.id, itemType: item.itemType!, displayName: item.displayName }]));
  assert.doesNotThrow(() => validateKitLines(ID.p86, assignKitLineKeys(lines, itemsById), { itemsById, variantSets: [swatchBook] }), "projde stejnou validací jako editor");
  assert.equal(planP86Lines({ p86Id: ID.p86, items: [...catalog, { ...plannedP86(), packageItems: [{ id: "x" } as CatalogPackageItem] }], variantSets: [swatchBook] }).action, "keep", "ruční obsah se nepřepisuje");
  assert.equal(planP86Lines({ p86Id: ID.p86, items: catalog.filter((item) => item.id !== ID.m91), variantSets: [swatchBook] }).action, "blocked");
});

// ---------------------------------------------------------------------------------------------
// Price model (in memory): P86 3 640 Kč, M01 190, M02 220 / REVEXPO 240, M04 0
// ---------------------------------------------------------------------------------------------
const version: PriceListVersion = { id: "v1", priceListId: "base", versionNo: 1, revision: 1, status: "draft", eurRate: 24.17, eurRoundingMode: "ceil", eurRoundingStep: 1 };
const row = (id: string, catalogItemId: string, saleCzk: number, extra: Partial<SalePriceEntry> = {}): SalePriceEntry => ({ id, versionId: "v1", catalogItemId, priceMode: "fixed", saleCzk, eurMode: "derived", ...extra });
const entries = [row("p86", ID.p86, 3640), row("m01", ID.m01, 190, { variantId: ID.grey }), row("m02a", ID.m02, 220, { variantSeries: "PODIUM-PLAT" }), row("m02b", ID.m02, 240, { variantSeries: "REVEXPO" }), row("m04", ID.m04, 0)];
const lines: CatalogPackageItem[] = p86KitLines({ m01: ID.m01, m91: ID.m91, m04: ID.m04, variantSetId: ID.set, baseVariantId: ID.grey }).map((line, index) => ({ ...line, id: `l${index}`, packageItemId: ID.p86, lineKey: line.lineKey!, lineKind: line.lineKind!, childItemId: line.childItemId ?? null, sortOrder: index, note: line.note ?? null }));
const seriesOf = new Map(swatchBook.variants.map((variant) => [variant.id, variant.series]));
const kit = (bookEntries: readonly SalePriceEntry[], selection?: Record<string, string>) => priceKitVersioned({
  context: { track: "CZK", base: { list: { id: "base", code: "PRODEJNI-ZAKLADNI", name: "Základní prodejní ceník ABF", kind: "base", isActive: true }, version, entries: bookEntries, surcharges: [] } satisfies SalePriceBook, priceCategoryOf: () => "standard", variantSeriesOf: (id) => seriesOf.get(id) },
  kitItemId: ID.p86, lines, variantSets: [swatchBook], selections: selection ? [{ lineKey: "koberec", ...selection }] : [], agreementItemIds: new Set([ID.m04]),
});

test("cena P86: 3 640 Kč základ; PODIUM 3 760 (+120); REVEXPO 3 840 (+200); koberec ani grafika se nepřičítají", () => {
  assert.equal(kit(entries).totalNet, 3640);
  const podium = kit(entries, { variantId: ID.podium });
  assert.equal(podium.lines[0]!.surcharge?.amountNet, 120);
  assert.equal(podium.totalNet, 3760);
  assert.equal(podium.lines[0]!.effectiveItemId, ID.m02);
  const revexpo = kit(entries, { variantId: ID.revexpo });
  assert.equal(revexpo.lines[0]!.surcharge?.amountNet, 200);
  assert.equal(revexpo.totalNet, 3840);
  assert.equal(revexpo.lines.length, 2, "koberec + grafika, nic navíc");
  assert.ok(revexpo.lines.every((line) => line.baseNet === 0), "zahrnuté řádky nemají vlastní cenu");
});

test("cena P86: M04 jen s důvodem, barva zůstává, 0 Kč příplatek, základ se nesníží", () => {
  assert.equal(kit(entries, { substituteItemId: ID.m04, substituteVariantId: ID.revexpo }).lines[0]!.effectiveItemId, ID.m01, "bez důvodu se nepoužije");
  const pva = kit(entries, { substituteItemId: ID.m04, substituteVariantId: ID.revexpo, reason: "Dohoda s PVA" });
  assert.equal(pva.lines[0]!.effectiveItemId, ID.m04);
  assert.equal(pva.lines[0]!.variantId, ID.revexpo);
  assert.equal(pva.lines[0]!.surcharge?.amountNet, 0);
  assert.equal(pva.totalNet, 3640);
});

test("cena P86: bez řádku P86 v ceníku = K nacenění, nikdy 0 Kč", () => {
  const missing = kit(entries.filter((entry) => entry.catalogItemId !== ID.p86));
  assert.equal(missing.kitPrice.status, "missing");
  assert.equal(missing.needsQuote, true);
});

test("seed P86 zůstává zdrojem pro starý generátor (packageContents, cena 3 640 Kč) — import ho nemění", () => {
  const legacy = seed as BoothType;
  assert.equal(legacy.pricingEntries?.find((entry) => entry.currency === "CZK")?.salePrice, 3640);
  assert.ok((legacy.packageContents ?? []).some((content) => content.id === "p86-fascia-print"));
});
