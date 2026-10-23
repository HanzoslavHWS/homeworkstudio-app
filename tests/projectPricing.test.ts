import assert from "node:assert/strict";
import test from "node:test";
import { boothTypes } from "../data/booths.ts";
import { componentCatalogItems, placeComponent } from "../data/components.ts";
import { getBasePricingEntry, groupCatalogSceneItems } from "../domain/catalog.ts";
import { buildTechnicalCatalogItems, type CatalogItemSummary, type PricingEntrySummary } from "../domain/catalogPricing.ts";
import { createCustomerCalculationViewModel, type CustomerCalculationSource } from "../domain/calculationExport.ts";
import type { BoothType, ComponentDefinition, PlacedComponent } from "../domain/models.ts";
import { createIndividualBooth } from "../domain/individualBooth.ts";
import { normalizeExhibition, type PriceList } from "../domain/organizations.ts";
import { DEFAULT_INDIVIDUAL_WORKSPACE } from "../domain/plot.ts";
import { calculateNetVatGross } from "../domain/pricing.ts";
import { createDefaultTechnicalRequirements, createProjectRecord, normalizeProjectRecord, type TechnicalRequirements } from "../domain/project.ts";
import {
  legacyPricingCatalogItems,
  priceProjectLegacy,
  resolvePricingContext,
  sumProjectLines,
  type ProjectPricingSource,
} from "../domain/projectPricing.ts";
import { priceCleaning, priceContainer, priceElectricity, priceGraphics } from "../domain/technicalServices.ts";

// V1-DATA-07 / 07-B1 — one project price for the editor bar, the calculation, the summary and the
// exports. Same legacy amounts as before; a missing price is "K nacenění", never a silent 0.

// ---------------------------------------------------------------------------------------------
// Frozen copy of the customer calculation totals as computed up to ff1e358 (before 07-B1).
// Used only to prove that the shared pricing keeps every amount unchanged.
// ---------------------------------------------------------------------------------------------
function legacyReference(source: ProjectPricingSource): Readonly<{ net: number; rows: readonly Readonly<{ id: string; totalNet?: number }>[] }> {
  const rows: { id: string; totalNet?: number }[] = [];
  const boothPrice = getBasePricingEntry(source.booth?.pricingEntries, source.currency);
  if (source.booth && boothPrice?.salePrice !== undefined) rows.push({ id: `booth-${source.booth.id}`, totalNet: boothPrice.salePrice });
  for (const item of groupCatalogSceneItems(source.sceneObjects, source.catalogItems, source.currency)) rows.push({ id: item.catalogItemId, totalNet: item.saleTotalNet });
  const context = resolvePricingContext(source);
  const services = [
    priceCleaning(source.requirements, source.booth, source.catalogItems, context),
    priceElectricity(source.requirements, source.catalogItems, context),
    priceContainer(source.requirements, source.currency),
    ...priceGraphics(source.requirements, source.booth, source.printSurfaceAssignments, source.realizationProfileId, source.catalogItems, context),
  ].filter((service): service is NonNullable<typeof service> => Boolean(service));
  for (const service of services) rows.push({ id: service.itemId, totalNet: service.totalNet });
  return { net: rows.reduce((sum, row) => sum + (row.totalNet ?? 0), 0), rows };
}

// ---------------------------------------------------------------------------------------------
// Fixtures (same shapes the generator passes)
// ---------------------------------------------------------------------------------------------
const P86 = boothTypes.find((booth) => booth.id === "koje-2x2") as BoothType;
const M57 = componentCatalogItems.find((item) => item.internalCode === "M57")!;
const CABINET = componentCatalogItems.find((item) => item.internalCode === "TEST-CABINET")!;
const ELECTRO_POINT = componentCatalogItems.find((item) => item.internalCode === "TECH-ELECTRO")!;

const L02_ID = "11111111-0000-4000-8000-000000000002";
const CZK_LIST = "list-beauty-czk";
const EUR_LIST = "list-beauty-eur";
const event = normalizeExhibition({ id: "beauty", name: "For Beauty", year: 2026, priceListIds: [CZK_LIST, EUR_LIST] });
const priceLists: PriceList[] = [
  { id: CZK_LIST, name: "Beauty CZK", code: "BEAUTY-2026-CZK", currency: "CZK", year: 2026, active: true },
  { id: EUR_LIST, name: "Beauty EUR", code: "BEAUTY-2026-EUR", currency: "EUR", year: 2026, active: true },
];
const l02Summary: CatalogItemSummary = { id: L02_ID, internalCode: "L02", kind: "service", lifecycleStatus: "active", displayName: "Elektrická energie – 2 kW", category: "T. služby", unit: "ks", generatorEligible: false };
const l02Entries: PricingEntrySummary[] = [{ id: "e1", catalogItemId: L02_ID, priceListId: CZK_LIST, eventId: "beauty", realizationCompanyId: null, currency: "CZK", salePrice: 5100, priceMode: "fixed" }];
const technicalItems = buildTechnicalCatalogItems([l02Summary], l02Entries);
const catalogItems = legacyPricingCatalogItems(technicalItems, componentCatalogItems);

function place(definition: ComponentDefinition, id: string): PlacedComponent {
  return placeComponent(definition, id, 0, 0);
}

function requirementsWith(patch: Partial<TechnicalRequirements>): TechnicalRequirements {
  return { ...createDefaultTechnicalRequirements(), ...patch };
}

function source(patch: Partial<ProjectPricingSource> = {}): ProjectPricingSource {
  return { currency: "CZK", booth: P86, event, priceLists, sceneObjects: [], requirements: createDefaultTechnicalRequirements(), printSurfaceAssignments: [], realizationProfileId: "default", catalogItems, ...patch };
}

const FULL = source({
  sceneObjects: [place(M57, "c1"), place(M57, "c2"), place(M57, "c3"), place(CABINET, "k1"), place(ELECTRO_POINT, "e1")],
  requirements: requirementsWith({
    electricity: { status: "ordered", note: "", powerOption: "2kw", customPower: "" } as TechnicalRequirements["electricity"],
    container: { status: "wanted", volumeSize: "3 m³", note: "", individualPriceNet: 1200 },
    cleaning: { status: "oneTime", note: "" },
    fasciaGraphics: { status: "ordered", note: "" },
  }),
});

// ---------------------------------------------------------------------------------------------
// Amounts unchanged
// ---------------------------------------------------------------------------------------------

test("stejné částky jako dosavadní kalkulace (stánek, mobiliář, služby, grafika) v CZK i EUR", () => {
  for (const fixture of [FULL, source(), source({ currency: "EUR" }), { ...FULL, currency: "EUR" as const }, source({ booth: undefined, sceneObjects: [place(M57, "x")] })]) {
    const pricing = priceProjectLegacy(fixture);
    const reference = legacyReference(fixture);
    assert.equal(pricing.totals.net, reference.net);
    const tax = calculateNetVatGross(reference.net, fixture.booth?.vatRatePercent ?? 21);
    assert.deepEqual([pricing.totals.vat, pricing.totals.gross], [tax.vat, tax.gross]);
    for (const line of pricing.lines.filter((candidate) => candidate.status === "priced")) {
      const id = line.kind === "booth" ? `booth-${line.itemId}` : line.itemId;
      assert.equal(line.totalNet, reference.rows.find((row) => row.id === id)?.totalNet, line.name);
    }
  }
});

test("stánek s cenou, mobiliář s cenou za kus × množství, elektřina z ceníku veletrhu, kontejner s individuální cenou", () => {
  const pricing = priceProjectLegacy(FULL);
  const line = (key: string) => pricing.lines.find((candidate) => candidate.key === key);
  assert.deepEqual([line("booth:koje-2x2")?.status, line("booth:koje-2x2")?.totalNet], ["priced", 3640]);
  assert.deepEqual([line(`scene:${M57.id}`)?.status, line(`scene:${M57.id}`)?.quantity, line(`scene:${M57.id}`)?.unitPriceNet, line(`scene:${M57.id}`)?.totalNet], ["priced", 3, 300, 900]);
  assert.deepEqual([line(`service:${L02_ID}`)?.status, line(`service:${L02_ID}`)?.totalNet, line(`service:${L02_ID}`)?.source.detail], ["priced", 5100, "event_price_list"]);
  assert.deepEqual([line("service:service-container")?.status, line("service:service-container")?.totalNet, line("service:service-container")?.source.detail], ["priced", 1200, "individual"]);
  assert.equal(pricing.totals.net, 3640 + 900 + 5100 + 1200);
});

test("chybějící cena = K nacenění, nikdy 0; technický bod se neúčtuje samostatně; grafika v ceně stánku je „v ceně“", () => {
  const pricing = priceProjectLegacy(FULL);
  const cabinet = pricing.lines.find((line) => line.itemId === CABINET.id)!;
  assert.equal(cabinet.status, "missing");
  assert.equal(cabinet.totalNet, undefined, "žádná tichá nula");
  assert.equal(cabinet.missingReason, "no_price");
  const point = pricing.lines.find((line) => line.itemId === ELECTRO_POINT.id)!;
  assert.equal(point.status, "not_billed", "elektro bod se platí přes službu elektřiny");
  const fascia = pricing.lines.find((line) => line.key === "service:service-graphics-fascia")!;
  assert.deepEqual([fascia.status, fascia.totalNet, fascia.source.detail], ["included", 0, "package"]);
  const cleaning = pricing.lines.find((line) => line.key === "service:service-cleaning-one-time")!;
  assert.equal(cleaning.status, "missing", "úklid bez ceny v ceníku");
  assert.equal(pricing.missingCount, 2);
  assert.match(pricing.warnings.at(-1) ?? "", /2 položky jsou k nacenění/u);
  const eur = priceProjectLegacy({ ...FULL, currency: "EUR" });
  assert.equal(eur.lines.find((line) => line.kind === "booth")?.status, "missing", "stánek bez EUR ceny → k nacenění, ne 0");
  assert.equal(eur.lines.find((line) => line.key === `service:${L02_ID}`)?.status, "missing", "žádný přepočet ani jiná měna");
});

test("skutečná nulová cena zůstává oceněná (0), zahrnutá bez částky je „v ceně“ — obojí odlišné od chybějící", () => {
  const free: ComponentDefinition = { ...M57, id: "free-item", internalCode: "FREE", pricingEntries: [{ id: "f", itemId: "free-item", currency: "CZK", salePrice: 0, priceMode: "fixed" }] };
  const includedNoAmount: ComponentDefinition = { ...M57, id: "incl-item", internalCode: "INCL", pricingEntries: [{ id: "i", itemId: "incl-item", currency: "CZK", priceMode: "included" }] };
  const pricing = priceProjectLegacy(source({ catalogItems: [free, includedNoAmount, ...catalogItems], sceneObjects: [place(free, "a"), place(includedNoAmount, "b")] }));
  const zero = pricing.lines.find((line) => line.itemId === "free-item")!;
  const included = pricing.lines.find((line) => line.itemId === "incl-item")!;
  assert.deepEqual([zero.status, zero.totalNet], ["priced", 0]);
  assert.deepEqual([included.status, included.totalNet], ["included", 0]);
  assert.equal(pricing.missingCount, 0);
});

// ---------------------------------------------------------------------------------------------
// Bar = calculation = summary/export
// ---------------------------------------------------------------------------------------------

function calculationSource(fixture: ProjectPricingSource, includePricingTable = true): CustomerCalculationSource {
  return {
    ...fixture,
    company: "Test s.r.o.",
    customerProjectNote: "",
    generatedPlanOutputs: [],
    visualizations: [],
    options: { includeVisuals: false, includePricingTable, includeVatSummary: true, includeContact: false, includeProjectNote: false, includeItemNotes: false, includeEventLogo: false, selectedOutputIds: [] } as never,
    processedAt: "2026-10-23T10:00:00.000Z",
  };
}

test("lišta v editoru a zákaznická kalkulace mají stejný výsledek (stejná funkce, stejné vstupy)", () => {
  const bar = priceProjectLegacy(FULL);
  const calculation = createCustomerCalculationViewModel(calculationSource(FULL));
  assert.deepEqual(calculation.pricing, bar);
  assert.equal(calculation.totals.net, bar.totals.net);
  assert.equal(calculation.totals.gross, bar.totals.gross);
  // The bar's areas add up to the same total.
  const parts = [(line: { kind: string }) => line.kind === "booth", (line: { kind: string }) => line.kind === "scene_item", (line: { kind: string }) => line.kind === "service"]
    .map((predicate) => sumProjectLines(bar.lines, predicate).net)
    .reduce((sum, value) => sum + value, 0);
  assert.equal(parts, bar.totals.net);
});

test("kalkulace a export (souhrn, ZIP, e-mail) čtou stejné částky; řádky zachovávají dřívější ID a nesou stav", () => {
  const forExport = createCustomerCalculationViewModel(calculationSource(FULL, false));
  const preview = createCustomerCalculationViewModel(calculationSource(FULL, true));
  assert.equal(forExport.pricing.totals.net, preview.totals.net, "souhrn/ZIP počítají z pricing i bez cenové tabulky");
  assert.deepEqual(preview.priceRows.map((row) => row.id), legacyReference(FULL).rows.map((row) => row.id), "stejné řádky ve stejném pořadí jako dřív");
  const cabinetRow = preview.priceRows.find((row) => row.id === CABINET.id)!;
  assert.deepEqual([cabinetRow.status, cabinetRow.totalNet, cabinetRow.unitPriceNet], ["missing", undefined, undefined]);
  const fasciaRow = preview.priceRows.find((row) => row.id === "service-graphics-fascia")!;
  assert.deepEqual([fasciaRow.status, fasciaRow.includedInPackage, fasciaRow.totalNet], ["included", true, 0]);
  assert.equal(preview.missingCount, 2);
});

test("stánek bez ceny přidá řádek „K nacenění“ (dřív chyběl úplně), součet se nemění", () => {
  const unpriced: BoothType = { ...P86, id: "booth-bez-ceny", pricingEntries: [] };
  const pricing = priceProjectLegacy(source({ booth: unpriced }));
  assert.equal(pricing.lines[0]?.status, "missing");
  assert.equal(pricing.totals.net, legacyReference(source({ booth: unpriced })).net);
  assert.equal(legacyReference(source({ booth: unpriced })).rows.some((row) => row.id === "booth-booth-bez-ceny"), false, "dřívější kalkulace řádek vůbec neměla");
});

test("individuální stánek (lešení pracovní plochy) nemá vlastní řádek ani „K nacenění“; úklid zůstává podle dosavadní plochy", () => {
  const individual = createIndividualBooth(DEFAULT_INDIVIDUAL_WORKSPACE);
  const scaffold = source({
    booth: individual,
    sceneObjects: [place(M57, "c1"), place(M57, "c2"), place(ELECTRO_POINT, "e1")],
    requirements: requirementsWith({
      electricity: { status: "ordered", note: "", powerOption: "2kw", customPower: "" } as TechnicalRequirements["electricity"],
      container: { status: "wanted", volumeSize: "", note: "" },
      cleaning: { status: "oneTime", note: "" },
    }),
  });
  const pricing = priceProjectLegacy(scaffold);
  assert.equal(pricing.lines.some((line) => line.kind === "booth"), false);
  assert.equal(pricing.missingCount, 2, "jen úklid a kontejner");
  assert.equal(pricing.totals.net, legacyReference(scaffold).net);
  assert.equal(pricing.totals.net, 600 + 5100);
  // Legacy rule kept unchanged in 07-B1: cleaning area = the scaffold's workspace (10 × 10 m by default), not the plot.
  assert.equal(pricing.lines.find((line) => line.key === "service:service-cleaning-one-time")?.quantity, 100);
});

// ---------------------------------------------------------------------------------------------
// Old projects stay readable and untouched
// ---------------------------------------------------------------------------------------------

test("starý projekt (schéma 5) se čte beze změny a dá se ocenit bez jakékoli migrace", () => {
  const stored = { ...createProjectRecord({ id: "old", fairId: "beauty", boothId: "koje-2x2", currency: "CZK", carpetFinishId: "carpet-grey" }), schemaVersion: 5 };
  const read = normalizeProjectRecord(JSON.parse(JSON.stringify(stored)));
  assert.equal(read.schemaVersion, 5);
  assert.equal(read.realizationProfileId, stored.realizationProfileId);
  assert.ok(!("pricingPin" in read) && !("priceOverrides" in read), "07-B1 nepřidává do projektu žádné cenové údaje");
  const pricing = priceProjectLegacy(source({ sceneObjects: read.sceneObjects, requirements: read.technicalRequirements, printSurfaceAssignments: read.printSurfaceAssignments, realizationProfileId: read.realizationProfileId }));
  assert.equal(pricing.totals.net, 3640);
});
