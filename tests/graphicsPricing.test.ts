import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  deriveFullWrapCalculationQuantity,
  fasciaQuantityBm,
  GRAPHICS_INTERNAL_CODES,
  priceGraphics,
  resolveGraphicsSurfacePricing,
  TECHNICAL_SERVICE_IDS,
} from "../domain/technicalServices.ts";
import { createDefaultExportCalculationOptions, createDefaultTechnicalRequirements } from "../domain/project.ts";
import { boothTypes } from "../data/booths.ts";
import { componentCatalogItems } from "../data/components.ts";
import { DEFAULT_REALIZATION_PROFILE_ID } from "../data/realizationProfiles.ts";
import type { BoothType, ComponentDefinition, PrintSurface } from "../domain/models.ts";
import type { PrintSurfaceAssignment } from "../domain/project.ts";
import type { PricingContext } from "../domain/catalog.ts";
import { buildTechnicalCatalogItems, type CatalogItemSummary, type PricingEntrySummary } from "../domain/catalogPricing.ts";
import { createCustomerCalculationViewModel } from "../domain/calculationExport.ts";
import { normalizeExhibition, normalizePriceList } from "../domain/organizations.ts";

const p86 = boothTypes.find((booth) => booth.internalCode === "P86");
if (!p86) throw new Error("Testovací definice P86 nebyla nalezena.");

const CZK_CONTEXT: PricingContext = { currency: "CZK" };

function panelSurface(id: string, overrides: Partial<PrintSurface> = {}): PrintSurface {
  return { id, name: "Panel", widthMm: 950, heightMm: 2340, active: true, ...overrides };
}

function fasciaLikeSurface(id: string, widthMm = 2000): PrintSurface {
  return { id, name: "Fascia-like", widthMm, heightMm: 300, active: true, pricingUnit: "bm", allowanceLinearMeters: 2 };
}

function assignment(overrides: Partial<PrintSurfaceAssignment> & Pick<PrintSurfaceAssignment, "printSurfaceId">): PrintSurfaceAssignment {
  return {
    sceneReference: "booth",
    graphicsKind: "fullWrap",
    artworkStatus: "missing",
    selectedForPrint: false,
    canonicalWidthMm: 0,
    canonicalHeightMm: 0,
    productionWidthMm: 0,
    productionHeightMm: 0,
    includedInPackage: false,
    pricedSeparately: true,
    ...overrides,
  };
}

function fullWrapCatalogItem(salePrice: number): ComponentDefinition {
  return {
    id: TECHNICAL_SERVICE_IDS.fullWrapGraphics,
    type: "service",
    name: "Grafika – celopolep",
    category: "graphics",
    widthMm: 0,
    depthMm: 0,
    resizable: false,
    productionProfiles: {},
    rotation: { defaultMode: "free", snapStep: 45, quickAngles: [0], allowFreeRotation: true, locked: false },
    systemLocked: false,
    userLocked: false,
    visible: false,
    sceneLabel: "Grafika – celopolep",
    pricingEntries: [{ id: "wrap-rate", itemId: TECHNICAL_SERVICE_IDS.fullWrapGraphics, currency: "CZK", salePrice }],
  };
}

function fasciaCatalogItem(salePrice: number): ComponentDefinition {
  return {
    id: TECHNICAL_SERVICE_IDS.fasciaGraphics,
    type: "service",
    name: "Grafika – límec",
    category: "graphics",
    widthMm: 0,
    depthMm: 0,
    resizable: false,
    productionProfiles: {},
    rotation: { defaultMode: "free", snapStep: 45, quickAngles: [0], allowFreeRotation: true, locked: false },
    systemLocked: false,
    userLocked: false,
    visible: false,
    sceneLabel: "Grafika – límec",
    pricingEntries: [{ id: "fascia-rate", itemId: TECHNICAL_SERVICE_IDS.fasciaGraphics, currency: "CZK", salePrice }],
  };
}

/**
 * Graphics Pricing foundation fix (2026-08-25): a DB-shaped catalog item — real Postgres UUID
 * id (never equal to TECHNICAL_SERVICE_IDS.fullWrapGraphics/fasciaGraphics), internalCode set —
 * the exact shape buildTechnicalCatalogItems produces from live catalog_items/pricing_entries.
 */
function dbFullWrapCatalogItem(salePrice: number): ComponentDefinition {
  return {
    id: "1a1d7dca-1bad-4237-b7aa-f1c639da9f5f",
    internalCode: GRAPHICS_INTERNAL_CODES.fullWrap,
    type: "service",
    name: "Grafika – celopolep",
    category: "services",
    widthMm: 0,
    depthMm: 0,
    resizable: false,
    productionProfiles: {},
    rotation: { defaultMode: "free", snapStep: 45, quickAngles: [0], allowFreeRotation: true, locked: false },
    systemLocked: false,
    userLocked: false,
    visible: false,
    sceneLabel: "Grafika – celopolep",
    pricingEntries: [{ id: "wrap-rate-db", itemId: "1a1d7dca-1bad-4237-b7aa-f1c639da9f5f", currency: "CZK", salePrice }],
  };
}

function dbFasciaCatalogItem(salePrice: number): ComponentDefinition {
  return {
    id: "b2c3d4e5-1234-4237-b7aa-f1c639da9f5f",
    internalCode: GRAPHICS_INTERNAL_CODES.fascia,
    type: "service",
    name: "Grafika – límec",
    category: "services",
    widthMm: 0,
    depthMm: 0,
    resizable: false,
    productionProfiles: {},
    rotation: { defaultMode: "free", snapStep: 45, quickAngles: [0], allowFreeRotation: true, locked: false },
    systemLocked: false,
    userLocked: false,
    visible: false,
    sceneLabel: "Grafika – límec",
    pricingEntries: [{ id: "fascia-rate-db", itemId: "b2c3d4e5-1234-4237-b7aa-f1c639da9f5f", currency: "CZK", salePrice }],
  };
}

// =========================================================================================
// Graphics Pricing foundation fix (2026-08-25 audit follow-up): the live-DB audit found
// GRAPHICS-FULL-WRAP/GRAPHICS-FASCIA missing from catalog_items AND the lookup itself unable
// to ever match a real DB UUID (id-only comparison, no internalCode fallback contract like
// priceCleaning already had). These tests cover the fixed findCatalogItemByIdentity contract:
// internalCode first, legacy static id (TECHNICAL_SERVICE_IDS.*) fallback second.
// =========================================================================================

test("DB-BACKED LOOKUP: a DB catalog item with a real UUID id (never equal to the legacy static id) is found via internalCode GRAPHICS-FULL-WRAP", () => {
  const boothWithPanel = { ...p86, printSurfaces: [panelSurface("panel-1")] } as unknown as BoothType;
  const assignments = [assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" })];
  const result = priceGraphics(createDefaultTechnicalRequirements(), boothWithPanel, assignments, DEFAULT_REALIZATION_PROFILE_ID, [dbFullWrapCatalogItem(555)], CZK_CONTEXT);
  const wrapRow = result.find((row) => row.status === "priced")!;
  assert.equal(wrapRow.unitPriceNet, 555, "must resolve the DB item's rate via internalCode — never fall through to needs-quote just because the id isn't the legacy string id");
});

test("DB-BACKED LOOKUP: a DB fascia catalog item is found via internalCode GRAPHICS-FASCIA", () => {
  const boothWithFascia = { id: "other-booth", printSurfaces: [fasciaLikeSurface("other-fascia")], packageContents: [] } as unknown as BoothType;
  const pricing = resolveGraphicsSurfacePricing(fasciaLikeSurface("other-fascia"), boothWithFascia, DEFAULT_REALIZATION_PROFILE_ID, [dbFasciaCatalogItem(140)], CZK_CONTEXT);
  assert.equal(pricing.status, "priced");
  assert.equal(pricing.unitPriceNet, 140);
});

test("LEGACY FALLBACK STILL WORKS: the static seed catalog item (legacy string id, no internalCode) still resolves when no internalCode match exists", () => {
  const boothWithPanel = { ...p86, printSurfaces: [panelSurface("panel-1")] } as unknown as BoothType;
  const assignments = [assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" })];
  const result = priceGraphics(createDefaultTechnicalRequirements(), boothWithPanel, assignments, DEFAULT_REALIZATION_PROFILE_ID, [fullWrapCatalogItem(450)], CZK_CONTEXT);
  const wrapRow = result.find((row) => row.itemId === TECHNICAL_SERVICE_IDS.fullWrapGraphics)!;
  assert.equal(wrapRow.status, "priced");
  assert.equal(wrapRow.unitPriceNet, 450);
});

test("INTERNAL CODE WINS OVER LEGACY FALLBACK: when both a DB item (internalCode match) and the static legacy-id item are present, the DB item's rate is used", () => {
  const boothWithPanel = { ...p86, printSurfaces: [panelSurface("panel-1")] } as unknown as BoothType;
  const assignments = [assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" })];
  const result = priceGraphics(createDefaultTechnicalRequirements(), boothWithPanel, assignments, DEFAULT_REALIZATION_PROFILE_ID, [fullWrapCatalogItem(450), dbFullWrapCatalogItem(555)], CZK_CONTEXT);
  const wrapRow = result.find((row) => row.status === "priced")!;
  assert.equal(wrapRow.unitPriceNet, 555, "internalCode match must win over the legacy static fallback when both are present in catalogItems");
});

test("DB ITEM FOUND VIA internalCode BUT NO MATCHING PricingEntry: still needs-quote, never a fabricated zero price", () => {
  const boothWithPanel = { ...p86, printSurfaces: [panelSurface("panel-1")] } as unknown as BoothType;
  const assignments = [assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" })];
  const dbItemNoRate: ComponentDefinition = { ...dbFullWrapCatalogItem(999), pricingEntries: [] };
  const result = priceGraphics(createDefaultTechnicalRequirements(), boothWithPanel, assignments, DEFAULT_REALIZATION_PROFILE_ID, [dbItemNoRate], CZK_CONTEXT);
  const wrapRow = result.find((row) => row.itemId === TECHNICAL_SERVICE_IDS.fullWrapGraphics)!;
  assert.equal(wrapRow.status, "needs-quote");
  assert.equal(wrapRow.unitPriceNet, undefined);
});

test("P86 FASCIA V BALÍČKU zůstává 'V ceně' i s existující placenou DB PricingEntry (internalCode GRAPHICS-FASCIA) — package inclusion má vždy přednost", () => {
  const result = priceGraphics(createDefaultTechnicalRequirements(), p86, [], DEFAULT_REALIZATION_PROFILE_ID, [dbFasciaCatalogItem(9999)], CZK_CONTEXT);
  const fasciaRow = result.find((row) => row.itemId === TECHNICAL_SERVICE_IDS.fasciaGraphics)!;
  assert.equal(fasciaRow.includedInPackage, true);
  assert.equal(fasciaRow.totalNet, 0, "the 9999 DB rate is never applied — package inclusion wins outright, exactly like the pre-existing static-seed case");
});

test("GRAPHICS-FULL-WRAP: static seed AND the DB migration document both use pricingUnit square-meter (m²)", () => {
  const seedSource = readFileSync(new URL("../data/components.ts", import.meta.url), "utf8");
  const fullWrapBlock = seedSource.match(/fullWrapGraphicsService: \{[\s\S]*?\n {2}\},/u);
  assert.ok(fullWrapBlock, "expected to find the fullWrapGraphicsService seed block");
  assert.match(fullWrapBlock![0], /pricingUnit: "square-meter"/u);

  const migrationSource = readFileSync(new URL("../supabase/migrations/20260825120000_graphics_service_catalog_items.sql", import.meta.url), "utf8");
  const fullWrapIdx = migrationSource.indexOf("'internalCode', 'GRAPHICS-FULL-WRAP'");
  assert.ok(fullWrapIdx !== -1, "expected a GRAPHICS-FULL-WRAP document block in the migration");
  assert.match(migrationSource.slice(fullWrapIdx), /'pricingUnit', 'square-meter'/u);
});

test("GRAPHICS-FASCIA: static seed AND the DB migration document both use pricingUnit linear-meter (bm)", () => {
  const seedSource = readFileSync(new URL("../data/components.ts", import.meta.url), "utf8");
  const fasciaBlock = seedSource.match(/fasciaGraphicsService: \{[\s\S]*?\n {2}\},/u);
  assert.ok(fasciaBlock, "expected to find the fasciaGraphicsService seed block");
  assert.match(fasciaBlock![0], /pricingUnit: "linear-meter"/u);

  const migrationSource = readFileSync(new URL("../supabase/migrations/20260825120000_graphics_service_catalog_items.sql", import.meta.url), "utf8");
  const fasciaIdx = migrationSource.indexOf("'internalCode', 'GRAPHICS-FASCIA'");
  const fullWrapIdx = migrationSource.indexOf("'internalCode', 'GRAPHICS-FULL-WRAP'");
  assert.ok(fasciaIdx !== -1 && fullWrapIdx > fasciaIdx, "expected a GRAPHICS-FASCIA document block before the GRAPHICS-FULL-WRAP one");
  assert.match(migrationSource.slice(fasciaIdx, fullWrapIdx), /'pricingUnit', 'linear-meter'/u);
});

test("MIGRACE graphics_service_catalog_items: idempotentní (ON CONFLICT internal_code DO NOTHING), žádný INSERT do pricing_entries a žádná sale_price hodnota v INSERT statementu", () => {
  const migrationSource = readFileSync(new URL("../supabase/migrations/20260825120000_graphics_service_catalog_items.sql", import.meta.url), "utf8");
  // Must repeat the partial unique index's predicate (internal_code IS NOT NULL) on the ON
  // CONFLICT target — Postgres cannot infer a partial index otherwise (SQLSTATE 42P10, caught
  // when first applying this migration against the live dev project).
  assert.match(migrationSource, /on conflict \(internal_code\) where internal_code is not null do nothing/iu);
  assert.match(migrationSource, /insert into catalog_items/iu);
  assert.match(migrationSource, /'GRAPHICS-FASCIA'/u);
  assert.match(migrationSource, /'GRAPHICS-FULL-WRAP'/u);
  // The migration only ever inserts into catalog_items — no pricing_entries row, and no
  // sale_price key inside the executable INSERT/jsonb_build_object statement (a `sale_price`
  // mention is only allowed in a `--` comment line explaining why it's deliberately absent).
  assert.doesNotMatch(migrationSource, /insert into pricing_entries/iu);
  const executableLines = migrationSource.split("\n").filter((line) => !line.trim().startsWith("--"));
  assert.doesNotMatch(executableLines.join("\n"), /sale_price/iu);
});

// =========================================================================================
// Add real Graphics Pricing – BEAUTY 2026 (2026-08-25): the 4 confirmed business rates
// (450 CZK/bm, 1000 CZK/m², 20 EUR/bm, 43 EUR/m²) now live in
// supabase/migrations/20260825130000_graphics_pricing_entries_beauty_2026.sql. These tests
// never touch the real DB — they exercise the exact same domain pipeline
// (CatalogItemSummary + PricingEntrySummary -> buildTechnicalCatalogItems -> priceGraphics /
// resolveGraphicsSurfacePricing -> selectPricingEntry) the runtime uses, fed with fixture data
// that mirrors the migration's rows field-for-field, plus a content check against the
// migration file itself so the two can never silently drift apart.
// =========================================================================================

const BEAUTY_CZK_PRICE_LIST_ID = "eddb21ec-de90-4867-98f8-4ec9ec32ba50";
const BEAUTY_EUR_PRICE_LIST_ID = "12096bc6-79df-4319-8266-94bd9a24d073";
const BEAUTY_FASCIA_CATALOG_ITEM_ID = "6a1e2b3c-0000-4000-8000-000000000001";
const BEAUTY_FULL_WRAP_CATALOG_ITEM_ID = "6a1e2b3c-0000-4000-8000-000000000002";

const beautyFasciaSummary: CatalogItemSummary = {
  id: BEAUTY_FASCIA_CATALOG_ITEM_ID,
  internalCode: GRAPHICS_INTERNAL_CODES.fascia,
  kind: "service",
  lifecycleStatus: "needs_review",
  displayName: "Grafika – límec",
  category: "services",
  unit: "bm",
  generatorEligible: false,
};
const beautyFullWrapSummary: CatalogItemSummary = {
  id: BEAUTY_FULL_WRAP_CATALOG_ITEM_ID,
  internalCode: GRAPHICS_INTERNAL_CODES.fullWrap,
  kind: "service",
  lifecycleStatus: "needs_review",
  displayName: "Grafika – celopolep",
  category: "services",
  unit: "m²",
  generatorEligible: false,
};
const beautyGraphicsPricingEntries: readonly PricingEntrySummary[] = [
  { id: "fascia-czk", catalogItemId: BEAUTY_FASCIA_CATALOG_ITEM_ID, priceListId: BEAUTY_CZK_PRICE_LIST_ID, eventId: "beauty", realizationCompanyId: null, currency: "CZK", salePrice: 450, priceMode: "fixed" },
  { id: "full-wrap-czk", catalogItemId: BEAUTY_FULL_WRAP_CATALOG_ITEM_ID, priceListId: BEAUTY_CZK_PRICE_LIST_ID, eventId: "beauty", realizationCompanyId: null, currency: "CZK", salePrice: 1000, priceMode: "fixed" },
  { id: "fascia-eur", catalogItemId: BEAUTY_FASCIA_CATALOG_ITEM_ID, priceListId: BEAUTY_EUR_PRICE_LIST_ID, eventId: "beauty", realizationCompanyId: null, currency: "EUR", salePrice: 20, priceMode: "fixed" },
  { id: "full-wrap-eur", catalogItemId: BEAUTY_FULL_WRAP_CATALOG_ITEM_ID, priceListId: BEAUTY_EUR_PRICE_LIST_ID, eventId: "beauty", realizationCompanyId: null, currency: "EUR", salePrice: 43, priceMode: "fixed" },
];
const beautyGraphicsCatalogItems = buildTechnicalCatalogItems([beautyFasciaSummary, beautyFullWrapSummary], beautyGraphicsPricingEntries);

const CZK_BEAUTY_CONTEXT: PricingContext = { priceListId: BEAUTY_CZK_PRICE_LIST_ID, exhibitionId: "beauty", currency: "CZK" };
const EUR_BEAUTY_CONTEXT: PricingContext = { priceListId: BEAUTY_EUR_PRICE_LIST_ID, exhibitionId: "beauty", currency: "EUR" };

test("PRICING MIGRATION CONTENT: 20260825130000 vloží přesně 450/1000 CZK a 20/43 EUR, lookup přes internal_code+price_lists.code, žádný literal UUID ani legacy string id", () => {
  const migrationSource = readFileSync(new URL("../supabase/migrations/20260825130000_graphics_pricing_entries_beauty_2026.sql", import.meta.url), "utf8");
  assert.match(migrationSource, /\('GRAPHICS-FASCIA', 'BEAUTY-2026-CZK', 450::numeric\)/u);
  assert.match(migrationSource, /\('GRAPHICS-FULL-WRAP', 'BEAUTY-2026-CZK', 1000::numeric\)/u);
  assert.match(migrationSource, /\('GRAPHICS-FASCIA', 'BEAUTY-2026-EUR', 20::numeric\)/u);
  assert.match(migrationSource, /\('GRAPHICS-FULL-WRAP', 'BEAUTY-2026-EUR', 43::numeric\)/u);
  assert.match(migrationSource, /join catalog_items ci on ci\.internal_code = rates\.internal_code/u);
  assert.match(migrationSource, /join price_lists pl on pl\.code = rates\.price_list_code/u);
  // These two checks must only scan the executable SQL, not the `--` prose explaining why the
  // legacy ids/UUIDs are absent (that explanation necessarily quotes the very strings it says
  // are absent from the statement itself).
  const executableLines = migrationSource.split("\n").filter((line) => !line.trim().startsWith("--"));
  const executableSql = executableLines.join("\n");
  assert.doesNotMatch(executableSql, /service-graphics-full-wrap|service-graphics-fascia/u, "must never reference the legacy static TypeScript ids in the executable SQL — catalog_item_id is looked up, never hardcoded");
  assert.doesNotMatch(executableSql, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu, "must never hardcode a catalog_items/price_lists UUID in the executable SQL");
  // realization_company_id (3rd select column) is the literal `null`, and every row is 'fixed'/'manual'.
  assert.match(migrationSource, /select ci\.id, pl\.id, pl\.event_id, null, pl\.currency, rates\.sale_price, 'fixed', 'manual'/u);
  // No unique constraint exists on pricing_entries (init_schema.sql) — idempotency must come
  // from a NOT EXISTS guard using the same (catalog_item_id, price_list_id, event_id, currency)
  // business key domain/importBatch2a.ts's pricing dedup already uses.
  assert.match(migrationSource, /where not exists/iu);
  assert.match(migrationSource, /pe\.catalog_item_id = ci\.id/u);
  assert.match(migrationSource, /pe\.price_list_id = pl\.id/u);
  assert.match(migrationSource, /pe\.currency = pl\.currency/u);
});

test("REAL RATE — CZK celopolep: BEAUTY-2026-CZK resolvuje skutečnou sazbu 1000 Kč/m²", () => {
  const boothWithPanel = { ...p86, printSurfaces: [panelSurface("panel-1")] } as unknown as BoothType;
  const assignments = [assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" })];
  const result = priceGraphics(createDefaultTechnicalRequirements(), boothWithPanel, assignments, DEFAULT_REALIZATION_PROFILE_ID, beautyGraphicsCatalogItems, CZK_BEAUTY_CONTEXT);
  const wrapRow = result.find((row) => row.itemId === BEAUTY_FULL_WRAP_CATALOG_ITEM_ID)!;
  assert.equal(wrapRow.status, "priced");
  assert.equal(wrapRow.unitPriceNet, 1000);
});

test("REAL RATE — CZK límec: BEAUTY-2026-CZK resolvuje skutečnou sazbu 450 Kč/bm (límec NENÍ v balíčku)", () => {
  const boothWithFascia = { id: "other-booth", printSurfaces: [fasciaLikeSurface("other-fascia")], packageContents: [] } as unknown as BoothType;
  const pricing = resolveGraphicsSurfacePricing(fasciaLikeSurface("other-fascia"), boothWithFascia, DEFAULT_REALIZATION_PROFILE_ID, beautyGraphicsCatalogItems, CZK_BEAUTY_CONTEXT);
  assert.equal(pricing.status, "priced");
  assert.equal(pricing.unitPriceNet, 450);
});

test("REAL RATE — EUR celopolep: BEAUTY-2026-EUR resolvuje skutečnou sazbu 43 EUR/m² (žádný CZK->EUR přepočet kurzem)", () => {
  const boothWithPanel = { ...p86, printSurfaces: [panelSurface("panel-1")] } as unknown as BoothType;
  const assignments = [assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" })];
  const result = priceGraphics(createDefaultTechnicalRequirements(), boothWithPanel, assignments, DEFAULT_REALIZATION_PROFILE_ID, beautyGraphicsCatalogItems, EUR_BEAUTY_CONTEXT);
  const wrapRow = result.find((row) => row.itemId === BEAUTY_FULL_WRAP_CATALOG_ITEM_ID)!;
  assert.equal(wrapRow.status, "priced");
  assert.equal(wrapRow.unitPriceNet, 43);
  assert.equal(wrapRow.totalNet, wrapRow.quantity * 43, "raw multiplication only — no invented EUR rounding rule");
});

test("REAL RATE — EUR límec: BEAUTY-2026-EUR resolvuje skutečnou sazbu 20 EUR/bm", () => {
  const boothWithFascia = { id: "other-booth", printSurfaces: [fasciaLikeSurface("other-fascia")], packageContents: [] } as unknown as BoothType;
  const pricing = resolveGraphicsSurfacePricing(fasciaLikeSurface("other-fascia"), boothWithFascia, DEFAULT_REALIZATION_PROFILE_ID, beautyGraphicsCatalogItems, EUR_BEAUTY_CONTEXT);
  assert.equal(pricing.status, "priced");
  assert.equal(pricing.unitPriceNet, 20);
});

test("MANUAL BUSINESS CASE — jeden potištěný panel 950×2340mm v CZK: 2.223 m² × 1000 Kč = 2223 Kč (žádné vlastní rounding pravidlo)", () => {
  const boothWithPanel = { ...p86, printSurfaces: [panelSurface("panel-1")] } as unknown as BoothType;
  const assignments = [assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" })];
  const result = priceGraphics(createDefaultTechnicalRequirements(), boothWithPanel, assignments, DEFAULT_REALIZATION_PROFILE_ID, beautyGraphicsCatalogItems, CZK_BEAUTY_CONTEXT);
  const wrapRow = result.find((row) => row.itemId === BEAUTY_FULL_WRAP_CATALOG_ITEM_ID)!;
  assert.equal(wrapRow.quantity, 2.223);
  assert.equal(wrapRow.totalNet, 2223);
});

test("MANUAL BUSINESS CASE — dva stejné potištěné panely v CZK: 4.446 m² × 1000 Kč = 4446 Kč", () => {
  const boothWithPanels = { ...p86, printSurfaces: [panelSurface("panel-1"), panelSurface("panel-2")] } as unknown as BoothType;
  const assignments = [
    assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" }),
    assignment({ printSurfaceId: "panel-2", artworkFileId: "art-2" }),
  ];
  const result = priceGraphics(createDefaultTechnicalRequirements(), boothWithPanels, assignments, DEFAULT_REALIZATION_PROFILE_ID, beautyGraphicsCatalogItems, CZK_BEAUTY_CONTEXT);
  const wrapRow = result.find((row) => row.itemId === BEAUTY_FULL_WRAP_CATALOG_ITEM_ID)!;
  assert.equal(Math.round(wrapRow.quantity * 1000) / 1000, 4.446);
  assert.equal(wrapRow.totalNet, 4446);
});

test("MANUAL BUSINESS CASE — odebrání jednoho artworku vrátí částku zpět na 2.223 m² / 2223 Kč", () => {
  const boothWithPanels = { ...p86, printSurfaces: [panelSurface("panel-1"), panelSurface("panel-2")] } as unknown as BoothType;
  const assignments = [
    assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" }),
    assignment({ printSurfaceId: "panel-2", artworkFileId: undefined }),
  ];
  const result = priceGraphics(createDefaultTechnicalRequirements(), boothWithPanels, assignments, DEFAULT_REALIZATION_PROFILE_ID, beautyGraphicsCatalogItems, CZK_BEAUTY_CONTEXT);
  const wrapRow = result.find((row) => row.itemId === BEAUTY_FULL_WRAP_CATALOG_ITEM_ID)!;
  assert.equal(wrapRow.totalNet, 2223);
});

test("MANUAL BUSINESS CASE — odebrání POSLEDNÍHO artworku úplně odstraní Grafika – celopolep z kalkulace (žádná nulová řádka)", () => {
  const boothWithPanel = { ...p86, printSurfaces: [panelSurface("panel-1")] } as unknown as BoothType;
  const assignments = [assignment({ printSurfaceId: "panel-1", artworkFileId: undefined })];
  const result = priceGraphics(createDefaultTechnicalRequirements(), boothWithPanel, assignments, DEFAULT_REALIZATION_PROFILE_ID, beautyGraphicsCatalogItems, CZK_BEAUTY_CONTEXT);
  assert.equal(result.find((row) => row.itemId === BEAUTY_FULL_WRAP_CATALOG_ITEM_ID), undefined);
});

test("P86 FASCIA V BALÍČKU zůstává 'V ceně' i se skutečnou BEAUTY-2026 sazbou (450 Kč/bm i 20 EUR/bm) — package inclusion má vždy přednost", () => {
  const czkResult = priceGraphics(createDefaultTechnicalRequirements(), p86, [], DEFAULT_REALIZATION_PROFILE_ID, beautyGraphicsCatalogItems, CZK_BEAUTY_CONTEXT);
  const czkFascia = czkResult.find((row) => row.itemId === TECHNICAL_SERVICE_IDS.fasciaGraphics)!;
  assert.equal(czkFascia.includedInPackage, true);
  assert.equal(czkFascia.totalNet, 0, "the real 450 Kč/bm rate is never applied — P86 fascia stays included");

  const eurResult = priceGraphics(createDefaultTechnicalRequirements(), p86, [], DEFAULT_REALIZATION_PROFILE_ID, beautyGraphicsCatalogItems, EUR_BEAUTY_CONTEXT);
  const eurFascia = eurResult.find((row) => row.itemId === TECHNICAL_SERVICE_IDS.fasciaGraphics)!;
  assert.equal(eurFascia.includedInPackage, true);
  assert.equal(eurFascia.totalNet, 0, "the real 20 EUR/bm rate is never applied — P86 fascia stays included");
});

// =========================================================================================
// Graphics Export v1.1: full-wrap ("Grafika – celopolep") pricing is now DRIVEN by real artwork
// assignments (deriveFullWrapCalculationQuantity), never by a manually-set requirement status.
// =========================================================================================

test("ARTWORK TRIGGERS QUANTITY: a panel with a real artworkFileId contributes its production m² to the full-wrap quantity", () => {
  const surfaces = [panelSurface("panel-1")];
  const assignments = [assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" })];
  const quantity = deriveFullWrapCalculationQuantity(surfaces, assignments, DEFAULT_REALIZATION_PROFILE_ID);
  assert.equal(Math.round(quantity * 1000) / 1000, 2.223);
});

test("NO ARTWORK -> NO QUANTITY: a panel assignment with no artworkFileId contributes nothing, regardless of selectedForPrint/graphicsKind", () => {
  const surfaces = [panelSurface("panel-1")];
  const assignments = [assignment({ printSurfaceId: "panel-1", selectedForPrint: true, graphicsKind: "fullWrap" })];
  assert.equal(deriveFullWrapCalculationQuantity(surfaces, assignments, DEFAULT_REALIZATION_PROFILE_ID), 0);
});

test("TWO PANELS SUM: two panels with artwork sum their m² (950x2340 each -> 4.446 m^2 total, matching the report's example)", () => {
  const surfaces = [panelSurface("back-wall-01-front"), panelSurface("back-wall-02-front")];
  const assignments = [
    assignment({ printSurfaceId: "back-wall-01-front", artworkFileId: "art-1" }),
    assignment({ printSurfaceId: "back-wall-02-front", artworkFileId: "art-2" }),
  ];
  const quantity = deriveFullWrapCalculationQuantity(surfaces, assignments, DEFAULT_REALIZATION_PROFILE_ID);
  assert.equal(Math.round(quantity * 1000) / 1000, 4.446);
});

test("REMOVE ONE ARTWORK: dropping one assignment's artworkFileId immediately reduces the quantity, no reload needed", () => {
  const surfaces = [panelSurface("back-wall-01-front"), panelSurface("back-wall-02-front")];
  const withBoth = [
    assignment({ printSurfaceId: "back-wall-01-front", artworkFileId: "art-1" }),
    assignment({ printSurfaceId: "back-wall-02-front", artworkFileId: "art-2" }),
  ];
  const afterRemoval = [
    assignment({ printSurfaceId: "back-wall-01-front", artworkFileId: "art-1" }),
    // removeArtworkFromPrintSurface clears artworkFileId but leaves selectedForPrint true —
    // the quantity function must key off artworkFileId, not selectedForPrint.
    assignment({ printSurfaceId: "back-wall-02-front", artworkFileId: undefined, selectedForPrint: true }),
  ];
  const before = deriveFullWrapCalculationQuantity(surfaces, withBoth, DEFAULT_REALIZATION_PROFILE_ID);
  const after = deriveFullWrapCalculationQuantity(surfaces, afterRemoval, DEFAULT_REALIZATION_PROFILE_ID);
  assert.equal(Math.round(before * 1000) / 1000, 4.446);
  assert.equal(Math.round(after * 1000) / 1000, 2.223);
  assert.ok(after < before);
});

test("REMOVE LAST ARTWORK: dropping the only artwork removes the full-wrap charge from priceGraphics entirely — no zero-quantity placeholder row", () => {
  const boothWithPanel = { ...p86, printSurfaces: [panelSurface("solo-panel")] } as unknown as BoothType;
  const withArtwork = priceGraphics(
    createDefaultTechnicalRequirements(),
    boothWithPanel,
    [assignment({ printSurfaceId: "solo-panel", artworkFileId: "art-1" })],
    DEFAULT_REALIZATION_PROFILE_ID,
    [fullWrapCatalogItem(450)],
    CZK_CONTEXT,
  );
  const wrapRowBefore = withArtwork.find((row) => row.itemId === TECHNICAL_SERVICE_IDS.fullWrapGraphics);
  assert.ok(wrapRowBefore, "full-wrap row present while artwork is assigned");

  const withoutArtwork = priceGraphics(
    createDefaultTechnicalRequirements(),
    boothWithPanel,
    [assignment({ printSurfaceId: "solo-panel", artworkFileId: undefined })],
    DEFAULT_REALIZATION_PROFILE_ID,
    [fullWrapCatalogItem(450)],
    CZK_CONTEXT,
  );
  const wrapRowAfter = withoutArtwork.find((row) => row.itemId === TECHNICAL_SERVICE_IDS.fullWrapGraphics);
  assert.equal(wrapRowAfter, undefined, "no row at all once the last artwork is removed — never a lingering zero-charge row");
});

test("PREVIEW ROLE STILL PRICES: deriveFullWrapCalculationQuantity never reads usageRole at all — artworkFileId alone is the trigger", () => {
  const source = readFileSync(new URL("../domain/technicalServices.ts", import.meta.url), "utf8");
  const match = source.match(/export function deriveFullWrapCalculationQuantity\([\s\S]{0,600}?\n\}/u);
  assert.ok(match);
  assert.doesNotMatch(match[0]!, /usageRole/u);
});

test("SAME FILE, TWO SURFACES: one graphicsFile.id assigned to two DIFFERENT printSurfaceIds counts as two separate surface areas (not deduplicated by file id)", () => {
  const surfaces = [panelSurface("back-wall-01-front"), panelSurface("back-wall-02-front")];
  const assignments = [
    assignment({ printSurfaceId: "back-wall-01-front", artworkFileId: "shared-file" }),
    assignment({ printSurfaceId: "back-wall-02-front", artworkFileId: "shared-file" }),
  ];
  const quantity = deriveFullWrapCalculationQuantity(surfaces, assignments, DEFAULT_REALIZATION_PROFILE_ID);
  assert.equal(Math.round(quantity * 1000) / 1000, 4.446, "counted twice — once per surface assignment, never once per unique file id");
});

test("FRONT + BACK ARE SEPARATE: the same physical panel's front and back print surfaces both count when both have artwork", () => {
  const surfaces = [
    panelSurface("back-wall-01-front", { sceneBinding: { nodeName: "n", face: "front", coordinateSpace: "node-local", localNormalAxis: "-y" } }),
    panelSurface("back-wall-01-back", { sceneBinding: { nodeName: "n", face: "back", coordinateSpace: "node-local", localNormalAxis: "+y" } }),
  ];
  const assignments = [
    assignment({ printSurfaceId: "back-wall-01-front", artworkFileId: "art-front" }),
    assignment({ printSurfaceId: "back-wall-01-back", artworkFileId: "art-back" }),
  ];
  const quantity = deriveFullWrapCalculationQuantity(surfaces, assignments, DEFAULT_REALIZATION_PROFILE_ID);
  assert.equal(Math.round(quantity * 1000) / 1000, 4.446);
});

test("PRODUCTION DIMENSIONS VIA RESOLVER: m² reflects the CURRENT realization's bleed rule, not the canonical size", () => {
  const surfaceWithBleed = panelSurface("panel-1", { productionProfiles: { "realization-2": { bleedLeftMm: 25, bleedRightMm: 25, bleedTopMm: 30, bleedBottomMm: 30 } } });
  const assignments = [assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" })];
  const defaultQuantity = deriveFullWrapCalculationQuantity([surfaceWithBleed], assignments, DEFAULT_REALIZATION_PROFILE_ID);
  const realization2Quantity = deriveFullWrapCalculationQuantity([surfaceWithBleed], assignments, "realization-2");
  assert.equal(Math.round(defaultQuantity * 1000) / 1000, 2.223, "default realization has no rule -> canonical");
  assert.equal(realization2Quantity, (950 + 50) * (2340 + 60) / 1_000_000);
  assert.notEqual(defaultQuantity, realization2Quantity);
});

test("STALE SNAPSHOT NOT AUTHORITATIVE: deriveFullWrapCalculationQuantity never reads assignment.productionWidthMm/HeightMm at all", () => {
  const surfaces = [panelSurface("panel-1")];
  const staleAssignment = assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1", productionWidthMm: 999999, productionHeightMm: 999999 });
  const quantity = deriveFullWrapCalculationQuantity(surfaces, [staleAssignment], DEFAULT_REALIZATION_PROFILE_ID);
  assert.equal(Math.round(quantity * 1000) / 1000, 2.223, "the stale 999999 snapshot must be completely ignored — quantity comes from resolveProductionPrintSurface only");
});

test("RATE FROM PRICING ENTRY: the full-wrap unit price comes from the matching PricingEntry, never a hardcoded number", () => {
  const boothWithPanel = { ...p86, printSurfaces: [panelSurface("panel-1")] } as unknown as BoothType;
  const assignments = [assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" })];
  const resultAt450 = priceGraphics(createDefaultTechnicalRequirements(), boothWithPanel, assignments, DEFAULT_REALIZATION_PROFILE_ID, [fullWrapCatalogItem(450)], CZK_CONTEXT);
  const resultAt900 = priceGraphics(createDefaultTechnicalRequirements(), boothWithPanel, assignments, DEFAULT_REALIZATION_PROFILE_ID, [fullWrapCatalogItem(900)], CZK_CONTEXT);
  const wrapAt450 = resultAt450.find((row) => row.itemId === TECHNICAL_SERVICE_IDS.fullWrapGraphics)!;
  const wrapAt900 = resultAt900.find((row) => row.itemId === TECHNICAL_SERVICE_IDS.fullWrapGraphics)!;
  assert.equal(wrapAt450.unitPriceNet, 450);
  assert.equal(wrapAt900.unitPriceNet, 900);
  assert.equal(wrapAt900.totalNet, wrapAt450.totalNet! * 2);
});

test("MISSING PRICE ENTRY: no fullWrapGraphics catalog item at all -> needs-quote, never an invented rate", () => {
  const boothWithPanel = { ...p86, printSurfaces: [panelSurface("panel-1")] } as unknown as BoothType;
  const assignments = [assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" })];
  const result = priceGraphics(createDefaultTechnicalRequirements(), boothWithPanel, assignments, DEFAULT_REALIZATION_PROFILE_ID, [], CZK_CONTEXT);
  const wrapRow = result.find((row) => row.itemId === TECHNICAL_SERVICE_IDS.fullWrapGraphics)!;
  assert.equal(wrapRow.status, "needs-quote");
  assert.equal(wrapRow.unitPriceNet, undefined);
  assert.ok(wrapRow.warning);
});

test("P86 FASCIA INCLUDED IN PACKAGE: totalNet 0, 'V ceně' semantics, never re-priced through the PriceList", () => {
  const result = priceGraphics(createDefaultTechnicalRequirements(), p86, [], DEFAULT_REALIZATION_PROFILE_ID, [fasciaCatalogItem(9999)], CZK_CONTEXT);
  const fasciaRow = result.find((row) => row.itemId === TECHNICAL_SERVICE_IDS.fasciaGraphics)!;
  assert.equal(fasciaRow.includedInPackage, true);
  assert.equal(fasciaRow.totalNet, 0, "the 9999 rate in the catalog item is never applied — package inclusion wins outright");
});

test("NON-INCLUDED FASCIA: a fascia-like surface NOT included in any package prices normally via bm × rate", () => {
  const boothWithFascia = { id: "other-booth", printSurfaces: [fasciaLikeSurface("other-fascia")], packageContents: [] } as unknown as BoothType;
  const pricing = resolveGraphicsSurfacePricing(fasciaLikeSurface("other-fascia"), boothWithFascia, DEFAULT_REALIZATION_PROFILE_ID, [fasciaCatalogItem(120)], CZK_CONTEXT);
  assert.equal(pricing.includedInPackage, false);
  assert.equal(pricing.pricingBasis, "bm");
  assert.equal(pricing.quantity, fasciaQuantityBm([fasciaLikeSurface("other-fascia")]));
  assert.equal(pricing.unitPriceNet, 120);
  assert.equal(pricing.totalNet, pricing.quantity * 120);
});

test("NON-P86 FUTURE SURFACE: a hypothetical counter-front surface prices correctly with zero P86-specific code", () => {
  const counterSurface: PrintSurface = { id: "counter-front-01", name: "Čelo", widthMm: 900, heightMm: 1100, active: true };
  const otherBooth = { id: "counter-booth", printSurfaces: [counterSurface], packageContents: [] } as unknown as BoothType;
  const pricing = resolveGraphicsSurfacePricing(counterSurface, otherBooth, DEFAULT_REALIZATION_PROFILE_ID, [fullWrapCatalogItem(300)], CZK_CONTEXT);
  assert.equal(pricing.pricingBasis, "m²");
  assert.equal(pricing.quantity, 0.99);
  assert.equal(pricing.totalNet, 0.99 * 300);
});

// =========================================================================================
// LIVE CUSTOMER CALCULATION composition regression (2026-08-26): the browser "Kalkulace /
// nabídka" showed "Individuálně" / "Nutno nacenit" for GRAPHICS-FULL-WRAP even though the
// live BEAUTY-2026-CZK PriceList already had a real 1000 CZK/m² PricingEntry. Root cause was
// NEVER selectPricingEntry/findCatalogItemByIdentity (both already covered above and both
// correct) — it was the catalogItems array components/workflow/WorkflowSteps.tsx builds for
// createCustomerCalculationViewModel (ExportStep's `graphicsCatalogItems` and SummaryStep's
// `projectPricing`): componentCatalogItems (data/components.ts's static seed, pricingEntries:
// []) was spread BEFORE project.technicalCatalogItems (the DB-backed rows). Both the seed's
// fullWrapGraphicsService AND the real catalog_items row share internalCode
// "GRAPHICS-FULL-WRAP" (Batch #2A+), so findCatalogItemByIdentity's first-match .find() always
// hit the empty-pricingEntries seed item and reported needs-quote, no matter what the live DB
// contained. This test drives the EXACT SAME public entry point the browser calculation uses
// (createCustomerCalculationViewModel) with the EXACT SAME array shape WorkflowSteps.tsx now
// composes (DB items first, static seed second) — never a second/duplicate resolver — so a
// regression in that composition order fails here before it ever reaches the browser again.
// =========================================================================================

test("LIVE CALCULATION COMPOSITION: createCustomerCalculationViewModel prices Grafika – celopolep at 2.223 × 1000 = 2223 CZK from the real BEAUTY-2026-CZK PricingEntry, with the static seed ALSO present in catalogItems (never passes merely because of the static graphics seed)", () => {
  const beautyEvent = normalizeExhibition({ id: "beauty", priceListIds: [BEAUTY_CZK_PRICE_LIST_ID] });
  const beautyCzkPriceList = normalizePriceList({ id: BEAUTY_CZK_PRICE_LIST_ID, code: "BEAUTY-2026-CZK", currency: "CZK", eventId: "beauty" });
  const boothWithPanel = { ...p86, printSurfaces: [panelSurface("panel-1")] } as unknown as BoothType;
  const assignments: readonly PrintSurfaceAssignment[] = [assignment({ printSurfaceId: "panel-1", artworkFileId: "art-1" })];

  // Same composition order components/workflow/WorkflowSteps.tsx now uses: DB-backed
  // technicalCatalogItems FIRST, componentCatalogItems (static seed, including the
  // colliding GRAPHICS-FULL-WRAP/GRAPHICS-FASCIA seed entries with pricingEntries: [])
  // spread SECOND — the seed being present at all is the point of this test.
  const catalogItems: readonly ComponentDefinition[] = [...beautyGraphicsCatalogItems, ...componentCatalogItems];

  const calculation = createCustomerCalculationViewModel({
    company: "Customer s.r.o.",
    customerProjectNote: "",
    currency: "CZK",
    booth: boothWithPanel,
    event: beautyEvent,
    sceneObjects: [],
    requirements: createDefaultTechnicalRequirements(),
    printSurfaceAssignments: assignments,
    realizationProfileId: DEFAULT_REALIZATION_PROFILE_ID,
    generatedPlanOutputs: [],
    visualizations: [],
    options: createDefaultExportCalculationOptions(),
    catalogItems,
    priceLists: [beautyCzkPriceList],
  });

  const wrapRow = calculation.priceRows.find((row) => row.id === BEAUTY_FULL_WRAP_CATALOG_ITEM_ID);
  assert.ok(wrapRow, "expected the DB-backed BEAUTY-2026-CZK catalog item's row, not needs-quote / the static seed's row");
  assert.equal(wrapRow!.quantity, 2.223);
  assert.equal(wrapRow!.unitPriceNet, 1000, "must resolve the real 1000 CZK/m² PricingEntry — a static-seed-only pass would leave this undefined");
  assert.equal(wrapRow!.totalNet, 2223);
  assert.equal(wrapRow!.warning, undefined, "priced rows never carry a needs-quote warning");

  // The static seed's legacy id must never win: if it did, unitPriceNet would be undefined
  // (its pricingEntries is []) instead of 1000, but assert this explicitly too so a future
  // change to the seed's pricingEntries can't silently mask a composition-order regression.
  assert.notEqual(wrapRow!.id, TECHNICAL_SERVICE_IDS.fullWrapGraphics);
});
