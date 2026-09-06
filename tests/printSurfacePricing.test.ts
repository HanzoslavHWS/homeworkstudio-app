import test from "node:test";
import assert from "node:assert/strict";
import {
  formatPrintSurfacePriceStatus,
  pricingModeForTypeId,
  resolvePrintSurfacePrice,
  sumPrintSurfacePrices,
  type PrintSurfacePriceResolution,
} from "../domain/printSurfacePricing.ts";
import type { PricingContext } from "../domain/catalog.ts";
import type { CatalogItemSummary, PricingEntrySummary } from "../domain/catalogPricing.ts";
import { GRAPHICS_INTERNAL_CODES } from "../domain/technicalServices.ts";
import {
  addMarkerPlacementForExistingItem,
  addPrintSurfaceItemWithPlacement,
  addPrintSurfaceView,
  createPrintSurfaceProject,
  resolvePrintSurfaceItemDimension,
  type PrintSurfaceItem,
  type PrintSurfaceItemDimensionResolution,
} from "../domain/printSurfaceProject.ts";
import type { PrintSurfaceProductionDimension } from "../domain/printSurfaceProductionDimension.ts";
import { buildPrintSurfaceExportViewModel } from "../domain/printSurfaceExport.ts";
import type { PrintSurfacePreset } from "../domain/printSurfacePreset.ts";

const FULL_WRAP_CATALOG_ITEM: CatalogItemSummary = {
  id: "catalog-full-wrap",
  internalCode: GRAPHICS_INTERNAL_CODES.fullWrap,
  kind: "service",
  lifecycleStatus: "active",
  displayName: "Grafika – celopolep",
  category: "graphics",
  unit: "m²",
  generatorEligible: true,
};
const FASCIA_CATALOG_ITEM: CatalogItemSummary = {
  id: "catalog-fascia",
  internalCode: GRAPHICS_INTERNAL_CODES.fascia,
  kind: "service",
  lifecycleStatus: "active",
  displayName: "Grafika – límec",
  category: "graphics",
  unit: "bm",
  generatorEligible: true,
};
const CATALOG_ITEMS: readonly CatalogItemSummary[] = [FULL_WRAP_CATALOG_ITEM, FASCIA_CATALOG_ITEM];

const PRICING_ENTRIES: readonly PricingEntrySummary[] = [
  { id: "entry-full-wrap", catalogItemId: "catalog-full-wrap", priceListId: "price-list-1", eventId: "event-1", realizationCompanyId: null, currency: "CZK", salePrice: 1000, priceMode: "fixed" },
  { id: "entry-fascia", catalogItemId: "catalog-fascia", priceListId: "price-list-1", eventId: "event-1", realizationCompanyId: null, currency: "CZK", salePrice: 450, priceMode: "fixed" },
];

const CONTEXT: PricingContext = { exhibitionId: "event-1", priceListId: "price-list-1", currency: "CZK" };

function makeItem(overrides: Partial<PrintSurfaceItem> = {}): PrintSurfaceItem {
  return {
    id: overrides.id ?? "item-1",
    label: overrides.label ?? "A",
    typeId: overrides.typeId ?? "panel",
    note: overrides.note ?? "",
    presetId: overrides.presetId,
    customWidthMm: overrides.customWidthMm,
    customHeightMm: overrides.customHeightMm,
    quantity: overrides.quantity,
    includeInCalculation: overrides.includeInCalculation ?? true,
  };
}

const AVAILABLE: PrintSurfaceItemDimensionResolution = { status: "available", widthMm: 1491, heightMm: 1491, source: "catalog" }; // 1.491 x 1.491 -> ~2.223 m²
const UNAVAILABLE: PrintSurfaceItemDimensionResolution = { status: "unavailable" };
const NOT_DEFINED: PrintSurfaceItemDimensionResolution = { status: "not_defined" };

test("pricingModeForTypeId: Límec je vždy bm, každý jiný typ (včetně Jiná plocha) je vždy m²", () => {
  assert.equal(pricingModeForTypeId("fascia"), "running_metre");
  for (const typeId of ["panel", "panel_above_door", "counter_front", "counter_side", "showcase", "custom"] as const) {
    assert.equal(pricingModeForTypeId(typeId), "area_m2");
  }
});

test("includeInCalculation=false -> vždy 'excluded', bez ohledu na rozměr/katalog — 0 příspěvek do celkové ceny", () => {
  const item = makeItem({ includeInCalculation: false });
  const resolution = resolvePrintSurfacePrice(item, AVAILABLE, CATALOG_ITEMS, PRICING_ENTRIES, CONTEXT);
  assert.equal(resolution.status, "excluded");
  assert.equal(sumPrintSurfacePrices([resolution]), 0);
  assert.equal(formatPrintSurfacePriceStatus(resolution), "");
});

test("panel (m²): cena = (šířka × výška v mm / 1_000_000) × sazba, nikdy hardcoded", () => {
  const item = makeItem({ typeId: "panel", includeInCalculation: true, quantity: 1 });
  const dimension: PrintSurfaceItemDimensionResolution = { status: "available", widthMm: 950, heightMm: 2340, source: "catalog" };
  const resolution = resolvePrintSurfacePrice(item, dimension, CATALOG_ITEMS, PRICING_ENTRIES, CONTEXT);
  assert.equal(resolution.status, "priced");
  if (resolution.status !== "priced") return;
  assert.equal(resolution.mode, "area_m2");
  assert.equal(resolution.unitLabel, "m²");
  assert.equal(resolution.quantityUnit, 2.223); // 950*2340/1_000_000 = 2.223
  assert.equal(resolution.unitPrice, 1000); // from PRICING_ENTRIES, never invented
  assert.equal(resolution.totalPrice, 2223); // 2.223 * 1000 * 1
});

test("fascia (límec, bm): cena = (šířka v mm / 1000) × sazba — VÝŠKA (300mm) se do výpočtu nikdy nezapočítá", () => {
  const item = makeItem({ typeId: "fascia", customWidthMm: 5000, customHeightMm: 300, includeInCalculation: true, quantity: 1 });
  const dimension: PrintSurfaceItemDimensionResolution = { status: "available", widthMm: 5000, heightMm: 300, source: "custom" };
  const resolution = resolvePrintSurfacePrice(item, dimension, CATALOG_ITEMS, PRICING_ENTRIES, CONTEXT);
  assert.equal(resolution.status, "priced");
  if (resolution.status !== "priced") return;
  assert.equal(resolution.mode, "running_metre");
  assert.equal(resolution.unitLabel, "bm");
  assert.equal(resolution.quantityUnit, 5); // 5000mm / 1000 = 5 bm — height never enters this
  assert.equal(resolution.unitPrice, 450);
  assert.equal(resolution.totalPrice, 2250); // 5 * 450

  // Same width, but a DIFFERENT height — result must be IDENTICAL, proving height plays no role.
  const tallerDimension: PrintSurfaceItemDimensionResolution = { status: "available", widthMm: 5000, heightMm: 9999, source: "custom" };
  const tallerResolution = resolvePrintSurfacePrice(item, tallerDimension, CATALOG_ITEMS, PRICING_ENTRIES, CONTEXT);
  assert.deepEqual(tallerResolution, resolution);
});

test("quantity násobí výslednou cenu — 1 plocha 2.223 m², quantity=3 -> účtovaná plocha zůstává 2.223 m² na kus, cena = 3×", () => {
  const item = makeItem({ typeId: "panel", quantity: 3, includeInCalculation: true });
  const dimension: PrintSurfaceItemDimensionResolution = { status: "available", widthMm: 1491, heightMm: 1491, source: "catalog" };
  const resolution = resolvePrintSurfacePrice(item, dimension, CATALOG_ITEMS, PRICING_ENTRIES, CONTEXT);
  assert.equal(resolution.status, "priced");
  if (resolution.status !== "priced") return;
  assert.equal(resolution.quantityUnit, 2.223); // per-piece, never pre-multiplied by count
  assert.equal(resolution.count, 3);
  assert.equal(resolution.totalPrice, 6669); // 2.223 * 1000 * 3
});

test("chybějící PricingEntry -> 'price_not_defined', nikdy vymyšlená cena", () => {
  const item = makeItem({ typeId: "panel", includeInCalculation: true });
  const resolution = resolvePrintSurfacePrice(item, AVAILABLE, [], [], CONTEXT); // empty catalog/entries — nothing to resolve
  assert.equal(resolution.status, "price_not_defined");
  assert.equal(formatPrintSurfacePriceStatus(resolution), "Cena není v ceníku definována");
});

test("PricingEntry existuje jen pro jinou měnu -> stále 'price_not_defined' (currency-safe, žádný křížový fallback)", () => {
  const item = makeItem({ typeId: "panel", includeInCalculation: true });
  const eurContext: PricingContext = { ...CONTEXT, currency: "EUR" };
  const resolution = resolvePrintSurfacePrice(item, AVAILABLE, CATALOG_ITEMS, PRICING_ENTRIES, eurContext);
  assert.equal(resolution.status, "price_not_defined");
});

test("dimension 'unavailable' (katalog: realizačka tuto plochu nemá v nabídce) -> nikdy vymyšlená cena, i když sazba existuje", () => {
  const item = makeItem({ typeId: "panel", includeInCalculation: true });
  const resolution = resolvePrintSurfacePrice(item, UNAVAILABLE, CATALOG_ITEMS, PRICING_ENTRIES, CONTEXT);
  assert.equal(resolution.status, "dimension_unavailable");
  assert.equal(formatPrintSurfacePriceStatus(resolution), "Není v nabídce");
});

test("dimension 'not_defined' (žádná kombinace v katalogu) -> nikdy vymyšlená cena", () => {
  const item = makeItem({ typeId: "panel", includeInCalculation: true });
  const resolution = resolvePrintSurfacePrice(item, NOT_DEFINED, CATALOG_ITEMS, PRICING_ENTRIES, CONTEXT);
  assert.equal(resolution.status, "dimension_not_defined");
  assert.equal(formatPrintSurfacePriceStatus(resolution), "Rozměr není definován");
});

test("sumPrintSurfacePrices: součítá jen 'priced' položky — 'excluded'/'price_not_defined'/'dimension_*' přispívají 0", () => {
  const resolutions: readonly PrintSurfacePriceResolution[] = [
    { status: "priced", mode: "area_m2", unitLabel: "m²", quantityUnit: 2, count: 1, unitPrice: 1000, currency: "CZK", totalPrice: 2000 },
    { status: "priced", mode: "running_metre", unitLabel: "bm", quantityUnit: 3, count: 1, unitPrice: 450, currency: "CZK", totalPrice: 1350 },
    { status: "excluded" },
    { status: "price_not_defined", mode: "area_m2", unitLabel: "m²", quantityUnit: 1, count: 1 },
    { status: "dimension_unavailable" },
    { status: "dimension_not_defined" },
  ];
  assert.equal(sumPrintSurfacePrices(resolutions), 3350);
});

test("item na 2 pohledech (item/placement split) je stále JEDEN fyzický item -> price resolution se počítá přesně jednou, ne dvakrát", () => {
  let project = createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1");
  project = addPrintSurfaceView(project, { asset: { id: "a1", storageKey: "k1", originalFileName: "a.jpg", mimeType: "image/jpeg", size: 1, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" }, widthPx: 800, heightPx: 600 }, "view-1");
  project = addPrintSurfaceView(project, { asset: { id: "a2", storageKey: "k2", originalFileName: "b.jpg", mimeType: "image/jpeg", size: 1, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" }, widthPx: 800, heightPx: 600 }, "view-2");
  const created = addPrintSurfaceItemWithPlacement(project, { typeId: "panel" }, "view-1", 0.2, 0.2, { itemId: "item-a" });
  project = created.project;
  project = addMarkerPlacementForExistingItem(project, "item-a", "view-2", 0.7, 0.7).project;
  assert.equal(project.items.length, 1);
  assert.equal(project.placements.length, 2);

  const item = { ...project.items[0]!, includeInCalculation: true };
  const dimension: PrintSurfaceItemDimensionResolution = { status: "available", widthMm: 950, heightMm: 2340, source: "catalog" };
  // Resolving price is keyed on the ITEM, never on a placement — computing it once (as the editor's
  // project-summary loop does, once per project.items entry) is correct regardless of placement count.
  const resolution = resolvePrintSurfacePrice(item, dimension, CATALOG_ITEMS, PRICING_ENTRIES, CONTEXT);
  const total = sumPrintSurfacePrices([resolution]);
  assert.equal(total, 2223); // billed exactly once, not 4446 (which double-billing across 2 placements would produce)
});

test("dimenze se řeší přes existující resolvePrintSurfaceItemDimension (realization-company-resolved) — pricing nikdy neřeší rozměr samo", () => {
  const item = makeItem({ typeId: "panel", presetId: "Panel_S_100", includeInCalculation: true });
  const dimensions: readonly PrintSurfaceProductionDimension[] = [
    { realizationCompanyId: "creativ-expo", presetId: "Panel_S_100", status: "available", widthMm: 950, heightMm: 2340 },
  ];
  const dimensionResolution = resolvePrintSurfaceItemDimension(item, "creativ-expo", dimensions);
  const resolution = resolvePrintSurfacePrice(item, dimensionResolution, CATALOG_ITEMS, PRICING_ENTRIES, CONTEXT);
  assert.equal(resolution.status, "priced");
  if (resolution.status !== "priced") return;
  assert.equal(resolution.quantityUnit, 2.223);
});

test("export view model: 'Zobrazit ceny' vypnuto (výchozí) -> žádná cena v řádcích/footeru", () => {
  const project = { ...createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1"), items: [makeItem({ id: "a", includeInCalculation: true })] };
  const priceResolutions = new Map<string, PrintSurfacePriceResolution>([
    ["a", { status: "priced", mode: "area_m2", unitLabel: "m²", quantityUnit: 2.223, count: 1, unitPrice: 1000, currency: "CZK", totalPrice: 2223 }],
  ]);
  const viewModel = buildPrintSurfaceExportViewModel({ project, presets: [], productionDimensions: [], revision: 1, priceResolutions, showPrices: false });
  assert.equal(viewModel.showPrices, false);
  assert.equal(viewModel.rows[0]?.priceLabel, undefined);
  assert.equal(viewModel.rows[0]?.priceQuantityLabel, undefined);
});

test("export view model: 'Zobrazit ceny' zapnuto -> řádky nesou cenu a totalPrice odpovídá sumPrintSurfacePrices", () => {
  const presets: readonly PrintSurfacePreset[] = [];
  const project = {
    ...createPrintSurfaceProject({ name: "Test", companyName: "ACME" }, "project-1"),
    items: [makeItem({ id: "a", label: "A", includeInCalculation: true }), makeItem({ id: "b", label: "B", includeInCalculation: false })],
  };
  const priceResolutions = new Map<string, PrintSurfacePriceResolution>([
    ["a", { status: "priced", mode: "area_m2", unitLabel: "m²", quantityUnit: 2.223, count: 1, unitPrice: 1000, currency: "CZK", totalPrice: 2223 }],
    ["b", { status: "excluded" }],
  ]);
  const viewModel = buildPrintSurfaceExportViewModel({ project, presets, productionDimensions: [], revision: 1, priceResolutions, showPrices: true });
  assert.equal(viewModel.showPrices, true);
  const rowA = viewModel.rows.find((row) => row.label === "A");
  const rowB = viewModel.rows.find((row) => row.label === "B");
  const expectedPriceLabel = `${(2223).toLocaleString("cs-CZ")} CZK`;
  assert.equal(rowA?.priceQuantityLabel, "2.223 m²");
  assert.equal(rowA?.priceRateLabel, "1000 CZK / m²");
  assert.equal(rowA?.priceLabel, expectedPriceLabel);
  assert.equal(rowB?.priceLabel, undefined); // includeInCalculation=false -> the row never even reaches formatPrintSurfacePriceStatus
  assert.equal(viewModel.totalPrice, sumPrintSurfacePrices([...priceResolutions.values()]));
  assert.equal(viewModel.totalPrice, 2223);
});
