import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildBatch2aPlan,
  planCanonicalCatalogItems,
  planMappings,
  planPricingEntries,
  planTechnicalServices,
  previewBatch2aApply,
  resolveCatalogItemForApply,
  resolveExistingCatalogItem,
  resolvePricingEntryForApply,
  runBatch2aPreflight,
  summarizeReimportIdentity,
  CatalogItemConflictError,
  Batch2aPreflightError,
  type AbfTechnicalServiceMatch,
  type ExistingCatalogItemRow,
  type ExistingEventRow2A,
  type ExistingPriceListRow2A,
} from "../domain/importBatch2a.ts";
import { applyBatch2aPlan, readExistingCatalogItemsFull } from "../lib/db/importBatch2a.supabase.ts";
import type { ImportPreview, ImportTechnicalServiceRowPreview } from "../domain/importBatch.ts";
import type { MappingDecision } from "../domain/importBatch1.ts";
import { componentCatalogItems } from "../data/components.ts";
import { boothTypes } from "../data/booths.ts";
import { normalizeExhibition, resolveEventPriceListForCurrency, type PriceList } from "../domain/organizations.ts";
import { selectPricingEntry, resolvePricingAvailability } from "../domain/catalog.ts";
import type { PricingEntry } from "../domain/models.ts";
import { createProjectRecord } from "../domain/project.ts";

const DECISIONS: readonly MappingDecision[] = [
  { identity: { sourceSheet: "PRICELIST", category: "Nábytek", rawName: "Židle čalouněná" }, decision: "confirmed", targetInternalCode: "M57" },
  { identity: { sourceSheet: "PRICELIST", category: "T. služby", rawName: "Přípojka el. energie - 2kW" }, decision: "confirmed", targetInternalCode: "L02" },
  { identity: { sourceSheet: "PRICELIST", category: "Kuchyňka", rawName: "Rychlovarná konvice příkon 2 kW" }, decision: "rejected", targetInternalCode: "L02", reason: "shared_spec_token only" },
];

// 14 synthetic events (mirrors Batch #1's real 14 imported events), each with a CZK+EUR price list.
const EVENT_KEYS = Array.from({ length: 14 }, (_, i) => `event${i + 1}`);
const EXISTING_EVENTS: readonly ExistingEventRow2A[] = EVENT_KEYS.map((key, i) => ({ id: `id-${key}`, sourceKey: key, year: 2026 + (i % 2) }));
const EXISTING_PRICE_LISTS: readonly ExistingPriceListRow2A[] = EVENT_KEYS.flatMap((key, i) => {
  const eventId = `id-${key}`;
  return [
    { id: `pl-${key}-czk`, code: `${key.toUpperCase()}-${2026 + (i % 2)}-CZK`, currency: "CZK" as const, eventId },
    { id: `pl-${key}-eur`, code: `${key.toUpperCase()}-${2026 + (i % 2)}-EUR`, currency: "EUR" as const, eventId },
  ];
});

/**
 * 23 synthetic technical-service rows × 14 events, engineered so CZK priced sums to exactly
 * 264 (58 missing) and EUR priced sums to exactly 231 (91 missing) — the real numbers Batch
 * #1 staged — without depending on the private, gitignored source .xlsm file.
 */
function buildFixtureTechnicalServiceRows(): readonly ImportTechnicalServiceRowPreview[] {
  const names = [
    "Přípojka el. energie - 2kW",
    ...Array.from({ length: 22 }, (_, i) => `Technická služba ${i + 1}`),
  ];
  // 11 rows get 12 CZK-priced events, 12 rows get 11 CZK-priced events -> 11*12 + 12*11 = 264.
  const czkPricedCounts = [...Array(11).fill(12), ...Array(12).fill(11)];
  // Distribute 231 EUR-priced cells across 23 rows as evenly as possible (10 per row, +1 for the first row).
  const eurPricedCounts = names.map((_, i) => (i === 0 ? 11 : 10));
  assert.equal(czkPricedCounts.reduce((a, b) => a + b, 0), 264);
  assert.equal(eurPricedCounts.reduce((a, b) => a + b, 0), 231);

  return names.map((rawName, rowIndex) => ({
    rawName,
    candidates: [],
    eventPrices: EVENT_KEYS.map((eventSourceKey, eventIndex) => ({
      eventSourceKey,
      czk: eventIndex < czkPricedCounts[rowIndex]! ? { amount: 1000 + rowIndex * 10 + eventIndex, status: "priced" as const } : { amount: null, status: "missing" as const },
      eur: eventIndex < eurPricedCounts[rowIndex]! ? { amount: 40 + rowIndex + eventIndex, status: "priced" as const } : { amount: null, status: "missing" as const },
    })),
  }));
}

function fixturePreview(): ImportPreview {
  const technicalServiceRows = buildFixtureTechnicalServiceRows();
  return {
    counts: {
      events: 14, eventsNeedingReview: 0, catalogRows: 116, categories: [],
      basePricesCzkPresent: 0, basePricesCzkMissing: 0, basePricesEurPresent: 0, basePricesEurMissing: 0,
      purchasePricesCzkPresent: 0, purchasePricesCzkMissing: 0, technicalServiceRows: technicalServiceRows.length,
      eventPricingEntriesCzk: 264, eventPricingEntriesEur: 231, missingEventPricingCzk: 58, missingEventPricingEur: 91,
      rowsNeedingUnitReview: 0, candidateMappingRows: 0, technicalPurchasePricesCzkPresent: 0,
    },
    events: [],
    catalogRows: [],
    technicalServiceRows,
  };
}

test("importBatch2a.ts je čistý (žádná závislost na síti/Supabase) — dry-run garantovaně nezapisuje", () => {
  const source = readFileSync(new URL("../domain/importBatch2a.ts", import.meta.url), "utf8");
  assert.equal(/from\s+["'][^"']*supabase[^"']*["']/iu.test(source), false);
  assert.equal(/@supabase/u.test(source), false);
  assert.equal(/fetch\(/u.test(source), false);
  assert.equal(buildBatch2aPlan.constructor.name, "Function");
});

test("scripts/importBatch2a.ts: --apply je vyžadováno explicitně, default je dry-run, žádné přímé DB zápisy ve skriptu samotném", () => {
  const source = readFileSync(new URL("../scripts/importBatch2a.ts", import.meta.url), "utf8");
  // The script itself never calls Supabase insert/update/upsert directly — every real write
  // lives in lib/db/importBatch2a.supabase.ts's applyBatch2aPlan(), which the script only
  // calls when --apply is explicitly present on argv.
  assert.equal(/\.insert\(/u.test(source), false);
  assert.equal(/\.update\(/u.test(source), false);
  assert.equal(/\.upsert\(/u.test(source), false);
  assert.match(source, /const apply = args\.includes\("--apply"\)/u);
  assert.match(source, /if \(!apply\)/u);
  assert.match(source, /applyBatch2aPlan/u);
});

test("lib/db/importBatch2a.supabase.ts writer existuje a je importovatelný", async () => {
  const module = await import("../lib/db/importBatch2a.supabase.ts");
  assert.equal(typeof module.applyBatch2aPlan, "function");
  assert.equal(typeof module.readExistingCatalogItemsFull, "function");
  assert.equal(typeof module.readExistingCatalogMappings, "function");
  assert.equal(typeof module.readExistingPricingEntriesForCatalogItems, "function");
});

const REVIEW_TIMESTAMP = "2026-08-14T12:00:00.000Z";

test("canonical M57/L02: insert při prázdné DB, nikdy duplicitní řádek při re-planu (M57 i L02 planned právě jednou)", () => {
  const empty: readonly ExistingCatalogItemRow[] = [];
  const plan = planCanonicalCatalogItems(componentCatalogItems, empty, REVIEW_TIMESTAMP);
  assert.equal(plan.length, 2);
  const m57 = plan.find((p) => p.internalCode === "M57")!;
  const l02 = plan.find((p) => p.internalCode === "L02")!;
  assert.equal(m57.action, "insert");
  assert.equal(l02.action, "insert");
  assert.equal(m57.kind, "furniture");
  assert.equal(l02.kind, "service");
  assert.equal(plan.filter((p) => p.internalCode === "M57").length, 1);
  assert.equal(plan.filter((p) => p.internalCode === "L02").length, 1);

  const afterInsert: readonly ExistingCatalogItemRow[] = [{ id: "db-m57-id", internalCode: "M57" }, { id: "db-l02-id", internalCode: "L02" }];
  const replan = planCanonicalCatalogItems(componentCatalogItems, afterInsert, REVIEW_TIMESTAMP);
  assert.ok(replan.every((p) => p.action === "noop"), "re-plán proti již existujícím M57/L02 nesmí navrhnout druhý insert");
  assert.equal(replan.filter((p) => p.internalCode === "M57").length, 1);
  assert.equal(replan.filter((p) => p.internalCode === "L02").length, 1);
});

test("M57 canonical: reviewedAt je nastaven na explicitní timestamp (section 3), readiness proto ready=true, generatorEligible dle canonical definice", () => {
  const plan = planCanonicalCatalogItems(componentCatalogItems, [], REVIEW_TIMESTAMP);
  const m57 = plan.find((p) => p.internalCode === "M57")!;
  assert.equal(m57.document.reviewedAt, REVIEW_TIMESTAMP);
  assert.equal(m57.readiness.ready, true);
  assert.deepEqual(m57.readiness.issues, []);
  assert.equal(m57.generatorEligible, true);
  // internalCode and seed metadata preserved verbatim, not re-derived from Excel.
  assert.equal(m57.document.internalCode, "M57");
  assert.equal(m57.document.displayName, "Židle kovová čalouněná");
});

test("L02 canonical: seed metadata beze změny (žádný reviewedAt override — service kind ho nevyžaduje), generatorEligible dle canonical definice", () => {
  const plan = planCanonicalCatalogItems(componentCatalogItems, [], REVIEW_TIMESTAMP);
  const l02 = plan.find((p) => p.internalCode === "L02")!;
  assert.equal(l02.document.internalCode, "L02");
  assert.equal(l02.readiness.ready, true);
  assert.equal(l02.generatorEligible, true);
});

test("L02 Excel candidate používá canonical L02, nikdy nevytvoří duplicitní service item", () => {
  const services = planTechnicalServices(buildFixtureTechnicalServiceRows(), DECISIONS);
  const l02Row = services.find((s) => s.nameCz === "Přípojka el. energie - 2kW")!;
  assert.equal(l02Row.internalCode, "L02");
  assert.equal(l02Row.mappedCanonicalCode, "L02");
  assert.equal(l02Row.action, "mapped_to_existing_canonical");
  assert.equal(l02Row.isNewCatalogItem, false, "L02-mapovaný řádek nesmí být plánován jako nový catalog_item");
  assert.equal(l02Row.document, undefined, "žádný document pro insert — je to jen mapping na existující canonical L02");
  // No OTHER technical service row is ever assigned internalCode "L02" — a single mapped identity, not a duplicate.
  assert.equal(services.filter((s) => s.internalCode === "L02").length, 1);
});

test("M57 mapping používá canonical M57 (přes catalog_mappings plán, ne nový catalog_item)", () => {
  const mappings = planMappings(DECISIONS);
  assert.equal(mappings.confirmed.length, 2);
  const m57 = mappings.confirmed.find((m) => m.rawName === "Židle čalouněná")!;
  assert.equal(m57.canonicalInternalCode, "M57");
  assert.equal(m57.catalogItemRef, "M57");
  const l02 = mappings.confirmed.find((m) => m.rawName === "Přípojka el. energie - 2kW")!;
  assert.equal(l02.canonicalInternalCode, "L02");
  assert.equal(mappings.rejected.length, 1);
  assert.equal(mappings.rejected[0]?.rawName, "Rychlovarná konvice příkon 2 kW");
  assert.match(mappings.rejected[0]?.recordedIn ?? "", /import_rows/u);
});

test("22 technical services bez canonical mapy jsou plánovány jako NOVÉ needs_review catalog_items: internalCode NULL, generatorEligible false, žádný GLB/3D požadavek", () => {
  const services = planTechnicalServices(buildFixtureTechnicalServiceRows(), DECISIONS);
  const unmapped = services.filter((s) => s.nameCz !== "Přípojka el. energie - 2kW");
  assert.equal(unmapped.length, 22);
  assert.ok(unmapped.every((s) => s.internalCode === null));
  assert.ok(unmapped.every((s) => s.isNewCatalogItem === true));
  assert.ok(unmapped.every((s) => s.action === "insert"));
  assert.ok(unmapped.every((s) => s.lifecycleStatus === "needs_review"));
  assert.ok(unmapped.every((s) => s.document !== undefined), "každý z 22 kandidátů musí mít reálný catalog_items.document plán — jinak by pricing_entries neměly kam mířit");
  assert.ok(unmapped.every((s) => s.document?.lifecycleStatus === "needs_review"));
  assert.ok(unmapped.every((s) => s.document?.showIn2D === undefined && s.document?.showIn3D === undefined), "žádný požadavek na 2D/3D/GLB pro tyto kandidáty");
  assert.ok(services.every((s) => s.generatorEligible === false));
});

test("total planned catalog_items v Batch #2A = 24 (2 canonical + 22 technical-service kandidátů)", () => {
  const preview = fixturePreview();
  const plan = buildBatch2aPlan(preview, componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP);
  assert.equal(plan.catalogItemsSummary.canonical, 2);
  assert.equal(plan.catalogItemsSummary.technicalServiceCandidates, 22);
  assert.equal(plan.catalogItemsSummary.total, 24);
});

test("všech 495 planned pricing_entries má skutečný catalog target (0 catalog target missing)", () => {
  const rows = buildFixtureTechnicalServiceRows();
  const services = planTechnicalServices(rows, DECISIONS);
  const pricing = planPricingEntries(rows, services, EXISTING_EVENTS, EXISTING_PRICE_LISTS);
  assert.equal(pricing.validation.catalogTargetMissing.length, 0);
  const validRefs = new Set(["M57", "L02", ...services.filter((s) => s.isNewCatalogItem).map((s) => s.sourceKey)]);
  assert.ok(pricing.entries.every((e) => validRefs.has(e.catalogItemRef)), "každý naplánovaný pricing_entry musí odkazovat na jeden z 24 plánovaných catalog_items");
  // The L02-mapped service's entries point at canonical "L02", never at its own sourceKey.
  const l02PricingEntries = pricing.entries.filter((e) => e.technicalServiceSourceKey === services[0]!.sourceKey);
  assert.ok(l02PricingEntries.every((e) => e.catalogItemRef === "L02"));
});

test("pricing plan: přesně 264 CZK, 231 EUR, 495 total, 149 missing skipped, 0 mismatch, 0 orphan", () => {
  const rows = buildFixtureTechnicalServiceRows();
  const services = planTechnicalServices(rows, DECISIONS);
  const pricing = planPricingEntries(rows, services, EXISTING_EVENTS, EXISTING_PRICE_LISTS);
  assert.equal(pricing.counts.czkFixed, 264);
  assert.equal(pricing.counts.eurFixed, 231);
  assert.equal(pricing.counts.totalFixed, 495);
  assert.equal(pricing.counts.czkMissing, 58);
  assert.equal(pricing.counts.eurMissing, 91);
  assert.equal(pricing.counts.totalMissing, 149);
  assert.equal(pricing.entries.length, 495);
  assert.equal(pricing.validation.currencyMismatches.length, 0);
  assert.equal(pricing.validation.orphanPricingSourceKeys.length, 0);
});

test("missing cena nikdy nevytvoří pricing_entry a nikdy není 0", () => {
  const rows = buildFixtureTechnicalServiceRows();
  const services = planTechnicalServices(rows, DECISIONS);
  const pricing = planPricingEntries(rows, services, EXISTING_EVENTS, EXISTING_PRICE_LISTS);
  // Row 0 (L02) has only 12 CZK-priced events out of 14 -> event13/event14 must be absent entirely.
  const l02Entries = pricing.entries.filter((e) => e.technicalServiceSourceKey === services[0]!.sourceKey && e.currency === "CZK");
  assert.equal(l02Entries.length, 12);
  assert.ok(l02Entries.every((e) => e.eventSourceKey !== "event13" && e.eventSourceKey !== "event14"));
  assert.ok(pricing.entries.every((e) => e.salePrice !== 0), "žádná naplánovaná cena není 0 (fixture nikdy negeneruje amount:0)");
});

test("žádná CZK->EUR konverze: CZK a EUR částky pro stejný event/službu jsou nezávislé", () => {
  const rows = buildFixtureTechnicalServiceRows();
  const services = planTechnicalServices(rows, DECISIONS);
  const pricing = planPricingEntries(rows, services, EXISTING_EVENTS, EXISTING_PRICE_LISTS);
  const czk = pricing.entries.find((e) => e.technicalServiceSourceKey === services[0]!.sourceKey && e.eventSourceKey === "event1" && e.currency === "CZK")!;
  const eur = pricing.entries.find((e) => e.technicalServiceSourceKey === services[0]!.sourceKey && e.eventSourceKey === "event1" && e.currency === "EUR")!;
  assert.equal(czk.salePrice, 1000);
  assert.equal(eur.salePrice, 40);
  // Same event/service, deliberately unrelated fixture values (1000 vs 40, no clean rate
  // between them) — planPricingEntries reads eventPrice.czk/eventPrice.eur as fully
  // independent ParsedPrice values, so both come through exactly as fixtured, never derived.
  const secondEur = pricing.entries.find((e) => e.technicalServiceSourceKey === services[1]!.sourceKey && e.eventSourceKey === "event1" && e.currency === "EUR")!;
  const secondCzk = pricing.entries.find((e) => e.technicalServiceSourceKey === services[1]!.sourceKey && e.eventSourceKey === "event1" && e.currency === "CZK")!;
  assert.equal(secondCzk.salePrice, 1010);
  assert.equal(secondEur.salePrice, 41);
  assert.notEqual(secondEur.salePrice, secondCzk.salePrice);
});

test("264 CZK pricing entries patří výhradně CZK price listům, 231 EUR výhradně EUR price listům", () => {
  const rows = buildFixtureTechnicalServiceRows();
  const services = planTechnicalServices(rows, DECISIONS);
  const pricing = planPricingEntries(rows, services, EXISTING_EVENTS, EXISTING_PRICE_LISTS);
  const priceListById = new Map(EXISTING_PRICE_LISTS.map((p) => [p.id, p]));
  const czkEntries = pricing.entries.filter((e) => e.currency === "CZK");
  const eurEntries = pricing.entries.filter((e) => e.currency === "EUR");
  assert.equal(czkEntries.length, 264);
  assert.equal(eurEntries.length, 231);
  assert.ok(czkEntries.every((e) => priceListById.get(e.priceListId)?.currency === "CZK"));
  assert.ok(eurEntries.every((e) => priceListById.get(e.priceListId)?.currency === "EUR"));
});

test("P86 zůstává netknuté — žádná zmínka v canonical plánu, technical services ani warnings ho nevynechávají", () => {
  const preview = fixturePreview();
  const plan = buildBatch2aPlan(preview, componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP);
  assert.equal(plan.canonicalCatalogItems.some((p) => p.internalCode === ("P86" as never)), false);
  assert.equal(plan.technicalServices.some((s) => s.nameCz.includes("P86")), false);
  assert.ok(plan.warnings.some((w) => w.includes("P86")));

  const p86 = boothTypes.find((booth) => booth.internalCode === "P86")!;
  assert.equal(p86.name, "Kóje 2 × 2 m");
  assert.equal(p86.widthMm, 2000);
});

test("dry-run plán nemutuje vstupní preview ani existující data (čistá funkce)", () => {
  const preview = fixturePreview();
  const guarded = new Proxy(preview.technicalServiceRows, { set() { throw new Error("mutace technicalServiceRows"); } });
  const plan = buildBatch2aPlan({ ...preview, technicalServiceRows: guarded as typeof preview.technicalServiceRows }, componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP);
  assert.equal(plan.pricing.counts.totalFixed, 495);
});

// ---------------------------------------------------------------------------------------
// Section 4/5: mandatory Event + project currency -> PriceList rule.
// ---------------------------------------------------------------------------------------

function beautyFixture() {
  const czk: PriceList = { id: "pl-beauty-czk", name: "Beauty 2026 — CZK", code: "BEAUTY-2026-CZK", currency: "CZK", year: 2026, active: true };
  const eur: PriceList = { id: "pl-beauty-eur", name: "Beauty 2026 — EUR", code: "BEAUTY-2026-EUR", currency: "EUR", year: 2026, active: true };
  const event = normalizeExhibition({ id: "beauty", name: "For Beauty", year: 2026, priceListIds: [czk.id, eur.id], defaultPriceListId: czk.id });
  return { czk, eur, event };
}

test("nový projekt má výchozí currency = CZK", () => {
  const project = createProjectRecord({ id: "p1" });
  assert.equal(project.currency, "CZK");
});

test("Beauty + project currency CZK -> BEAUTY-2026-CZK PriceList", () => {
  const { czk, eur, event } = beautyFixture();
  const resolved = resolveEventPriceListForCurrency(event, [czk, eur], "CZK");
  assert.equal(resolved?.code, "BEAUTY-2026-CZK");
});

test("Beauty + project currency EUR -> BEAUTY-2026-EUR PriceList (NE default CZK)", () => {
  const { czk, eur, event } = beautyFixture();
  const resolved = resolveEventPriceListForCurrency(event, [czk, eur], "EUR");
  assert.equal(resolved?.code, "BEAUTY-2026-EUR");
  assert.notEqual(resolved?.id, event.defaultPriceListId, "defaultPriceListId zůstává CZK, ale EUR projekt ho nesmí použít");
});

test("přepnutí CZK -> EUR přepne i resolvovaný PriceList stejného eventu", () => {
  const { czk, eur, event } = beautyFixture();
  const czkResolved = resolveEventPriceListForCurrency(event, [czk, eur], "CZK");
  const eurResolved = resolveEventPriceListForCurrency(event, [czk, eur], "EUR");
  assert.notEqual(czkResolved?.id, eurResolved?.id);
  assert.equal(czkResolved?.currency, "CZK");
  assert.equal(eurResolved?.currency, "EUR");
});

test("EUR projekt nikdy nepoužije CZK ceník a naopak — žádný fallback na jinou měnu", () => {
  const { czk } = beautyFixture();
  // Only a CZK list assigned (EUR not yet created for this fictitious event) -> EUR request must find NOTHING, never silently return the CZK one.
  const eurOnlyEvent = normalizeExhibition({ id: "solo-czk", name: "Solo", year: 2026, priceListIds: [czk.id], defaultPriceListId: czk.id });
  const resolved = resolveEventPriceListForCurrency(eurOnlyEvent, [czk], "EUR");
  assert.equal(resolved, undefined, "chybějící EUR ceník nesmí spadnout zpět na CZK");
});

test("chybějící PriceList v požadované měně: undefined, nikdy hádaný jiný ceník", () => {
  const { eur, event } = beautyFixture();
  const czkOnly: PriceList[] = [eur]; // simulate CZK list missing entirely
  const resolved = resolveEventPriceListForCurrency(event, czkOnly, "CZK");
  assert.equal(resolved, undefined);
});

// ---------------------------------------------------------------------------------------
// Item-level pricing resolution (existing domain/catalog.ts) proven against Batch #2A-shaped data.
// ---------------------------------------------------------------------------------------

test("chybějící EUR cena nepadá zpět na CZK cenu položky", () => {
  const entries: PricingEntry[] = [{ id: "e1", itemId: "l02", currency: "CZK", priceListId: "pl-beauty-czk", salePrice: 5100 }];
  const availability = resolvePricingAvailability({ pricingEntries: entries }, { currency: "EUR", priceListId: "pl-beauty-eur" });
  assert.equal(availability, "missing");
  const selected = selectPricingEntry(entries, { currency: "EUR", priceListId: "pl-beauty-eur" });
  assert.equal(selected, undefined);
});

test("chybějící CZK cena nepadá zpět na EUR cenu položky", () => {
  const entries: PricingEntry[] = [{ id: "e1", itemId: "l02", currency: "EUR", priceListId: "pl-beauty-eur", salePrice: 187 }];
  const availability = resolvePricingAvailability({ pricingEntries: entries }, { currency: "CZK", priceListId: "pl-beauty-czk" });
  assert.equal(availability, "missing");
});

test("missing cena se nikdy nevykazuje jako 0", () => {
  const availability = resolvePricingAvailability({ pricingEntries: [] }, { currency: "CZK" });
  assert.equal(availability, "missing");
  assert.notEqual(availability as string, "0");
});

// ---------------------------------------------------------------------------------------
// ABF matching report -> Batch #2A internalCode wiring.
// ---------------------------------------------------------------------------------------

const ABF_MATCHES: ReadonlyMap<string, AbfTechnicalServiceMatch> = new Map([
  ["Technická služba 1", { nameCz: "Technická služba 1", status: "EXACT_SAFE", proposedCode: "X01", proposedName: "SLUŽBA JEDNA" }],
  ["Technická služba 2", { nameCz: "Technická služba 2", status: "REVIEW", proposedCode: "X02", proposedName: "SLUŽBA DVA (nejistá)" }],
  ["Technická služba 3", { nameCz: "Technická služba 3", status: "NO_MATCH", proposedCode: null, proposedName: null }],
]);

test("20 technical services používají skutečný ABF EXACT_SAFE internalCode z matching reportu", () => {
  const services = planTechnicalServices(buildFixtureTechnicalServiceRows(), DECISIONS, ABF_MATCHES);
  const service1 = services.find((s) => s.nameCz === "Technická služba 1")!;
  assert.equal(service1.internalCode, "X01");
  assert.equal(service1.abfMatchStatus, "EXACT_SAFE");
  assert.equal(service1.identityBasis, "internalCode");
  assert.equal(service1.canonicalName, "SLUŽBA JEDNA");
  assert.equal(service1.document?.internalCode, "X01");
});

test("REVIEW kandidát z ABF reportu NIKDY nedostane proposedCode jako skutečný internalCode", () => {
  const services = planTechnicalServices(buildFixtureTechnicalServiceRows(), DECISIONS, ABF_MATCHES);
  const service2 = services.find((s) => s.nameCz === "Technická služba 2")!;
  assert.equal(service2.internalCode, null, "REVIEW kandidát (X02) se nesmí použít jako skutečný kód");
  assert.equal(service2.abfMatchStatus, "REVIEW");
  assert.equal(service2.identityBasis, "sourceKey");
  assert.equal(service2.lifecycleStatus, "needs_review");
  assert.equal(service2.generatorEligible, false);
});

test("NO_MATCH nikdy nedostane internalCode", () => {
  const services = planTechnicalServices(buildFixtureTechnicalServiceRows(), DECISIONS, ABF_MATCHES);
  const service3 = services.find((s) => s.nameCz === "Technická služba 3")!;
  assert.equal(service3.internalCode, null);
  assert.equal(service3.abfMatchStatus, "NO_MATCH");
  assert.equal(service3.identityBasis, "sourceKey");
});

test("technical service bez ABF shody v mapě (chybějící klíč) se chová jako NO_MATCH, internalCode NULL", () => {
  const services = planTechnicalServices(buildFixtureTechnicalServiceRows(), DECISIONS, ABF_MATCHES);
  const untouched = services.find((s) => s.nameCz === "Technická služba 22")!;
  assert.equal(untouched.internalCode, null);
  assert.equal(untouched.abfMatchStatus, "NO_MATCH");
});

test("L02 source ('Přípojka el. energie - 2kW') resolvuje na canonical L02 bez ohledu na ABF matching mapu", () => {
  const abfMatchesWithL02Row: ReadonlyMap<string, AbfTechnicalServiceMatch> = new Map([
    ...ABF_MATCHES,
    ["Přípojka el. energie - 2kW", { nameCz: "Přípojka el. energie - 2kW", status: "EXACT_SAFE", proposedCode: "L02", proposedName: "ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230V" }],
  ]);
  const services = planTechnicalServices(buildFixtureTechnicalServiceRows(), DECISIONS, abfMatchesWithL02Row);
  const l02Row = services.find((s) => s.nameCz === "Přípojka el. energie - 2kW")!;
  assert.equal(l02Row.internalCode, "L02");
  assert.equal(l02Row.isNewCatalogItem, false, "L02-mapovaný řádek zůstává mapping na canonical, ne nový catalog_item, i když ho ABF report také označí EXACT_SAFE");
  assert.equal(l02Row.action, "mapped_to_existing_canonical");
  assert.equal(services.filter((s) => s.internalCode === "L02").length, 1, "žádný duplicitní L02");
});

test("M57 zůstává canonical mapping, nikdy nový furniture catalog_item, bez ohledu na ABF matching mapu", () => {
  const plan = buildBatch2aPlan(fixturePreview(), componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, ABF_MATCHES);
  const m57Mapping = plan.mappings.confirmed.find((m) => m.rawName === "Židle čalouněná")!;
  assert.equal(m57Mapping.canonicalInternalCode, "M57");
  assert.equal(plan.canonicalCatalogItems.filter((c) => c.internalCode === "M57").length, 1);
  assert.equal(plan.technicalServices.some((s) => s.internalCode === "M57"), false, "M57 není mezi 23 technical-service identitami");
});

test("stabilní reimport identita: sourceKey funguje i když internalCode je NULL, opakovaný plán ho najde a nevytvoří duplicitu", () => {
  const rows = buildFixtureTechnicalServiceRows();
  const firstPlan = planTechnicalServices(rows, DECISIONS, ABF_MATCHES);
  const service2 = firstPlan.find((s) => s.nameCz === "Technická služba 2")!; // REVIEW, internalCode NULL
  assert.equal(service2.action, "insert");

  // Simulate this needs_review row already existing in the DB (inserted by a previous apply) —
  // no internalCode, only sourceSystem+sourceKey to find it by.
  const existingAfterInsert: readonly ExistingCatalogItemRow[] = [
    { id: "db-service2-id", sourceSystem: service2.sourceSystem, sourceKey: service2.sourceKey },
  ];
  const secondPlan = planTechnicalServices(rows, DECISIONS, ABF_MATCHES, existingAfterInsert);
  const service2Again = secondPlan.find((s) => s.nameCz === "Technická služba 2")!;
  assert.equal(service2Again.action, "noop", "re-plán musí najít existující needs_review položku podle sourceKey a nenavrhnout duplicitní insert");
  assert.equal(service2Again.existingId, "db-service2-id");
});

test("reimport lookup NIKDY nepoužívá normalized name jako identitu — jen internalCode nebo sourceSystem+sourceKey", () => {
  const candidate = { internalCode: null, sourceSystem: "excel-v6.6", sourceKey: "technical-service::::technicka-sluzba-2" };
  // A row with a similar/matching DISPLAY NAME but a different sourceKey and no internalCode must NOT resolve.
  const wrongMatchByNameOnly: readonly ExistingCatalogItemRow[] = [{ id: "unrelated-id", sourceSystem: "excel-v6.6", sourceKey: "technical-service::::uplne-jina-sluzba" }];
  assert.equal(resolveExistingCatalogItem(candidate, wrongMatchByNameOnly), undefined);

  const correctMatch: readonly ExistingCatalogItemRow[] = [{ id: "correct-id", sourceSystem: "excel-v6.6", sourceKey: candidate.sourceKey }];
  assert.equal(resolveExistingCatalogItem(candidate, correctMatch)?.id, "correct-id");

  // internalCode, when present, takes priority over sourceKey.
  const byCode = resolveExistingCatalogItem({ internalCode: "L60", sourceSystem: "excel-v6.6", sourceKey: "some-other-key" }, [{ id: "by-code-id", internalCode: "L60" }]);
  assert.equal(byCode?.id, "by-code-id");
});

test("reimport summary: 19 identity by internalCode, 3 by sourceKey pro fixture ABF mapu, 0 duplicit", () => {
  const services = planTechnicalServices(buildFixtureTechnicalServiceRows(), DECISIONS, ABF_MATCHES);
  const summary = summarizeReimportIdentity(services);
  assert.equal(summary.identityByInternalCode, 1, "jen 'Technická služba 1' má v této fixture ABF kód");
  assert.equal(summary.identityBySourceKeyOnly, 21);
  assert.deepEqual(summary.duplicateInternalCodes, []);
  assert.deepEqual(summary.duplicateSourceKeys, []);
});

test("duplicate ABF internalCode napříč dvěma technical services je detekován", () => {
  const rows = buildFixtureTechnicalServiceRows();
  const clashingMatches: ReadonlyMap<string, AbfTechnicalServiceMatch> = new Map([
    ["Technická služba 1", { nameCz: "Technická služba 1", status: "EXACT_SAFE", proposedCode: "X01", proposedName: "A" }],
    ["Technická služba 2", { nameCz: "Technická služba 2", status: "EXACT_SAFE", proposedCode: "X01", proposedName: "B" }],
  ]);
  const services = planTechnicalServices(rows, DECISIONS, clashingMatches);
  const summary = summarizeReimportIdentity(services);
  assert.deepEqual(summary.duplicateInternalCodes, ["X01"]);
});

test("total planned catalog_items zůstává 24 i po zapojení ABF matching reportu", () => {
  const plan = buildBatch2aPlan(fixturePreview(), componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, ABF_MATCHES);
  assert.equal(plan.catalogItemsSummary.total, 24);
  assert.equal(plan.catalogItemsSummary.canonical, 2);
  assert.equal(plan.catalogItemsSummary.technicalServiceCandidates, 22);
});

// =========================================================================================
// APPLY WRITER (lib/db/importBatch2a.supabase.ts) — never invoked against real Supabase.
// Fake in-memory client only, mirrors tests/db.test.ts's fake client, extended with .in().
// =========================================================================================

type FakeRow = Record<string, unknown>;

function createFakeSupabaseClient() {
  const tables = new Map<string, FakeRow[]>();
  let nextId = 1;

  function getTable(name: string): FakeRow[] {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }

  function from(tableName: string) {
    type Op = "select" | "insert" | "update";
    let op: Op = "select";
    let filters: Array<[string, unknown]> = [];
    let inFilters: Array<[string, readonly unknown[]]> = [];
    let payload: FakeRow | undefined;
    let singleMode: "none" | "single" = "none";

    const builder = {
      select(_columns?: string) {
        return builder;
      },
      insert(row: FakeRow) {
        op = "insert";
        payload = row;
        return builder;
      },
      update(patch: FakeRow) {
        op = "update";
        payload = patch;
        return builder;
      },
      eq(column: string, value: unknown) {
        filters = [...filters, [column, value]];
        return builder;
      },
      in(column: string, values: readonly unknown[]) {
        inFilters = [...inFilters, [column, values]];
        return builder;
      },
      single() {
        singleMode = "single";
        return execute();
      },
      then(onFulfilled: (value: { data: unknown; error: unknown }) => unknown, onRejected?: (reason: unknown) => unknown) {
        return execute().then(onFulfilled, onRejected);
      },
    };

    async function execute(): Promise<{ data: unknown; error: unknown }> {
      const rows = getTable(tableName);
      if (op === "select") {
        const matched = rows.filter((row) => filters.every(([c, v]) => row[c] === v) && inFilters.every(([c, values]) => values.includes(row[c])));
        if (singleMode === "single") return matched[0] ? { data: matched[0], error: null } : { data: null, error: { message: "not found" } };
        return { data: matched, error: null };
      }
      if (op === "insert") {
        const row: FakeRow = { id: `fake-id-${nextId++}`, ...payload };
        rows.push(row);
        if (singleMode === "single") return { data: row, error: null };
        return { data: [row], error: null };
      }
      if (op === "update") {
        const matched = rows.filter((row) => filters.every(([c, v]) => row[c] === v));
        for (const row of matched) Object.assign(row, payload);
        return { data: matched, error: null };
      }
      return { data: null, error: { message: `unsupported op ${op}` } };
    }

    return builder;
  }

  return { from, _tables: tables };
}

/** 19 EXACT_SAFE + 2 REVIEW + 1 NO_MATCH among the 22 non-L02 rows — mirrors the real ABF matching report's proportions exactly (see final report from the previous session). */
function buildRealisticAbfMatches(): ReadonlyMap<string, AbfTechnicalServiceMatch> {
  const map = new Map<string, AbfTechnicalServiceMatch>();
  for (let i = 1; i <= 19; i++) map.set(`Technická služba ${i}`, { nameCz: `Technická služba ${i}`, status: "EXACT_SAFE", proposedCode: `X${String(i).padStart(2, "0")}`, proposedName: `SLUŽBA ${i}` });
  map.set("Technická služba 20", { nameCz: "Technická služba 20", status: "REVIEW", proposedCode: "X20", proposedName: "SLUŽBA 20 (nejistá)" });
  map.set("Technická služba 21", { nameCz: "Technická služba 21", status: "REVIEW", proposedCode: "X21", proposedName: "SLUŽBA 21 (nejistá)" });
  map.set("Technická služba 22", { nameCz: "Technická služba 22", status: "NO_MATCH", proposedCode: null, proposedName: null });
  return map;
}

const TEST_META = { sourceFileName: "test-fixture.xlsm", sourceFingerprint: "fp-test-fixture" };

test("apply writer: 19 ABF-code identities + 3 sourceKey-only identities mezi 22 novými technical services (reálný poměr)", () => {
  const abfMatches = buildRealisticAbfMatches();
  const plan = buildBatch2aPlan(fixturePreview(), componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, abfMatches);
  assert.equal(plan.catalogItemsSummary.technicalServiceCandidatesWithAbfCode, 19);
  assert.equal(plan.catalogItemsSummary.technicalServiceCandidatesWithoutAbfCode, 3);
  assert.equal(plan.reimport.identityByInternalCode, 19);
  assert.equal(plan.reimport.identityBySourceKeyOnly, 3);
});

test("apply writer default je dry-run: previewBatch2aApply nikdy nepřijímá Supabase klienta (čistá funkce, nulové zápisy strukturálně)", () => {
  assert.equal(previewBatch2aApply.length, 4); // (plan, existingCatalogItems, existingCatalogMappings, existingPricingEntries) — no client parameter
  const source = readFileSync(new URL("../domain/importBatch2a.ts", import.meta.url), "utf8");
  assert.equal(/@supabase/u.test(source), false);
});

test("apply writer: M57 a L02 vznikají maximálně jednou; druhý apply proti stejnému stavu je 0 duplicitních insertů (idempotency simulace)", async () => {
  const client = createFakeSupabaseClient();
  const preview = fixturePreview();
  const plan = buildBatch2aPlan(preview, componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, ABF_MATCHES);

  const first = await applyBatch2aPlan(client as never, plan, TEST_META);
  assert.equal(first.catalogItems.inserted, 24);
  assert.equal(first.catalogItems.noop, 0);
  assert.equal(first.catalogMappings.inserted, 2);
  assert.equal(first.pricingEntries.inserted, 495);

  const existingAfterFirst = await readExistingCatalogItemsFull(client as never);
  assert.equal(existingAfterFirst.length, 24);
  assert.equal(existingAfterFirst.filter((row) => row.internalCode === "M57").length, 1);
  assert.equal(existingAfterFirst.filter((row) => row.internalCode === "L02").length, 1);

  const secondPlan = buildBatch2aPlan(preview, componentCatalogItems, existingAfterFirst, EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, ABF_MATCHES);
  assert.equal(secondPlan.canonicalCatalogItems.find((c) => c.internalCode === "M57")?.action, "noop");
  assert.equal(secondPlan.canonicalCatalogItems.find((c) => c.internalCode === "L02")?.action, "noop");

  const second = await applyBatch2aPlan(client as never, secondPlan, TEST_META);
  assert.equal(second.catalogItems.inserted, 0, "druhý apply nesmí nic znovu vložit");
  assert.equal(second.catalogItems.noop, 24);
  assert.equal(second.catalogMappings.inserted, 0);
  assert.equal(second.catalogMappings.noop, 2, "0 duplicitních catalog_mappings insertů");
  assert.equal(second.pricingEntries.inserted, 0, "0 duplicitních pricing_entries insertů");
  assert.equal(second.pricingEntries.noop, 495, "identické ceny -> noop, ne nový řádek");

  const finalCatalogItems = await readExistingCatalogItemsFull(client as never);
  assert.equal(finalCatalogItems.length, 24, "žádné duplicitní catalog_items po dvou apply bězích");
});

test("apply writer: změna jedné source ceny vede přesně na 1 update, ne nový řádek", async () => {
  const client = createFakeSupabaseClient();
  const rows = buildFixtureTechnicalServiceRows();
  const services = planTechnicalServices(rows, DECISIONS, ABF_MATCHES);
  const pricing = planPricingEntries(rows, services, EXISTING_EVENTS, EXISTING_PRICE_LISTS);
  const plan = { ...buildBatch2aPlan(fixturePreview(), componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, ABF_MATCHES), pricing };

  await applyBatch2aPlan(client as never, plan, TEST_META);

  // Mutate exactly one CZK price for one event on the first technical service row.
  const changedRows = rows.map((row, index) =>
    index === 0
      ? { ...row, eventPrices: row.eventPrices.map((p, i) => (i === 0 && p.czk.status === "priced" ? { ...p, czk: { amount: p.czk.amount! + 50, status: "priced" as const } } : p)) }
      : row,
  );
  const existingAfterFirst = await readExistingCatalogItemsFull(client as never);
  const changedServices = planTechnicalServices(changedRows, DECISIONS, ABF_MATCHES, existingAfterFirst);
  const changedPricing = planPricingEntries(changedRows, changedServices, EXISTING_EVENTS, EXISTING_PRICE_LISTS);
  const secondPlan = { ...buildBatch2aPlan(fixturePreview(), componentCatalogItems, existingAfterFirst, EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, ABF_MATCHES), technicalServices: changedServices, pricing: changedPricing };

  const second = await applyBatch2aPlan(client as never, secondPlan, TEST_META);
  assert.equal(second.pricingEntries.updated, 1, "přesně jedna změněná cena -> přesně jeden update");
  assert.equal(second.pricingEntries.inserted, 0);
  assert.equal(second.pricingEntries.noop, 494);
});

test("apply writer: confirmed mappings jsou přesně 2 (M57, L02), kettle rejection se NIKDY nepřevede na confirmed", async () => {
  const client = createFakeSupabaseClient();
  const plan = buildBatch2aPlan(fixturePreview(), componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, ABF_MATCHES);
  assert.equal(plan.mappings.confirmed.length, 2);
  assert.equal(plan.mappings.rejected.length, 1);
  assert.equal(plan.mappings.rejected[0]?.rawName, "Rychlovarná konvice příkon 2 kW");

  await applyBatch2aPlan(client as never, plan, TEST_META);
  const mappingsTable = (client as unknown as { _tables: Map<string, FakeRow[]> })._tables.get("catalog_mappings") ?? [];
  assert.equal(mappingsTable.length, 2, "žádný falešný confirmed mapping pro odmítnutou konvici");
  assert.ok(mappingsTable.every((row) => row.confirmed === true));
  assert.equal(mappingsTable.some((row) => String(row.source_key).includes("konvice")), false);
});

test("apply writer: konfliktní internalCode (jiný kind) je zachycen PREFLIGHTem před prvním zápisem — ani import_batches řádek nevznikne", async () => {
  const client = createFakeSupabaseClient();
  // Simulate M57's internal_code already used by something of a DIFFERENT kind in the DB.
  (client as unknown as { _tables: Map<string, FakeRow[]> })._tables.set("catalog_items", [{ id: "existing-wrong-m57", internal_code: "M57", kind: "service", document: {} }]);

  const plan = buildBatch2aPlan(fixturePreview(), componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, ABF_MATCHES);
  await assert.rejects(() => applyBatch2aPlan(client as never, plan, TEST_META), (error) => error instanceof Batch2aPreflightError);

  // Section 11: "apply odmítnout před prvním write, pokud je to zjistitelné předem" — the
  // conflict IS detectable upfront (same existingCatalogItems the preflight and the write
  // loop both use), so preflight aborts before even the import_batches audit row is created.
  const tables = (client as unknown as { _tables: Map<string, FakeRow[]> })._tables;
  assert.equal((tables.get("import_batches") ?? []).length, 0);
  assert.equal((tables.get("catalog_mappings") ?? []).length, 0);
  assert.equal((tables.get("pricing_entries") ?? []).length, 0);
  // The pre-existing (conflicting) row itself is untouched — never overwritten.
  assert.equal(tables.get("catalog_items")?.[0]?.kind, "service");
});

test("apply writer: chyba UPROSTŘED apply (ne preflight-zjistitelná) nechá batch status='failed' se srozumitelným summary, dřívější kroky zůstávají zapsané", async () => {
  const client = createFakeSupabaseClient();
  const realFrom = client.from.bind(client);
  let pricingInsertAttempted = false;
  // Simulate a genuine mid-run DB failure (e.g. transient network error) on the FIRST
  // pricing_entries insert — something no upfront preflight check could have predicted.
  client.from = ((tableName: string) => {
    const builder = realFrom(tableName);
    if (tableName === "pricing_entries") {
      const originalInsert = builder.insert.bind(builder);
      builder.insert = ((row: FakeRow) => {
        if (!pricingInsertAttempted) {
          pricingInsertAttempted = true;
          return Promise.resolve({ data: null, error: { message: "simulated transient DB error" } }) as unknown as ReturnType<typeof originalInsert>;
        }
        return originalInsert(row);
      }) as typeof builder.insert;
    }
    return builder;
  }) as typeof client.from;

  const plan = buildBatch2aPlan(fixturePreview(), componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, ABF_MATCHES);
  await assert.rejects(() => applyBatch2aPlan(client as never, plan, TEST_META));

  const tables = (client as unknown as { _tables: Map<string, FakeRow[]> })._tables;
  const batchTable = tables.get("import_batches") ?? [];
  assert.equal(batchTable.length, 1);
  assert.equal(batchTable[0]?.status, "failed", "apply musí nechat srozumitelný audit stav, ne zmizet beze stopy");
  assert.ok(typeof (batchTable[0]?.summary as { error?: string } | undefined)?.error === "string");
  // Steps completed BEFORE the failure stay committed (no rollback mechanism exists across
  // separate Supabase calls — this is exactly why every step is independently idempotent).
  assert.equal((tables.get("catalog_items") ?? []).length, 24);
  assert.equal((tables.get("catalog_mappings") ?? []).length, 2);
});

test("apply writer: catalog_mappings ukazující na jiný catalog_item_id (data drift, ne preflight-checkable) vyhodí CatalogItemConflictError a nic dalšího nezapíše", async () => {
  const client = createFakeSupabaseClient();
  (client as unknown as { _tables: Map<string, FakeRow[]> })._tables.set("catalog_mappings", [
    { id: "stale-mapping", source_system: "excel-v6.6", source_key: "pricelist::nabytek::zidle-calounena", catalog_item_id: "some-other-unrelated-id", confirmed: true },
  ]);

  const plan = buildBatch2aPlan(fixturePreview(), componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, ABF_MATCHES);
  await assert.rejects(() => applyBatch2aPlan(client as never, plan, TEST_META), (error) => error instanceof CatalogItemConflictError);

  const tables = (client as unknown as { _tables: Map<string, FakeRow[]> })._tables;
  assert.equal((tables.get("import_batches") ?? [])[0]?.status, "failed");
  assert.equal((tables.get("pricing_entries") ?? []).length, 0, "pricing_entries se nesmí zapsat, pokud mapping krok selže");
});

test("preflight: STOP před prvním zápisem, pokud existující DB položka se stejným internalCode má jiný kind", () => {
  const plan = buildBatch2aPlan(fixturePreview(), componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, ABF_MATCHES);
  const conflicting: readonly ExistingCatalogItemRow[] = [{ id: "existing-wrong-l02", internalCode: "L02", kind: "furniture" }];
  const preflight = runBatch2aPreflight(plan, conflicting);
  assert.equal(preflight.ok, false);
  assert.ok(preflight.issues.some((issue) => issue.includes("L02")));
  assert.throws(() => { throw new Batch2aPreflightError(preflight.issues); }, Batch2aPreflightError);
});

test("preflight: OK (prázdná DB, čistý plán) — vše smí pokračovat k apply", () => {
  const plan = buildBatch2aPlan(fixturePreview(), componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, ABF_MATCHES);
  const preflight = runBatch2aPreflight(plan, []);
  assert.equal(preflight.ok, true);
  assert.deepEqual(preflight.issues, []);
});

test("resolveCatalogItemForApply: insert pro neznámou položku, noop pro shodnou, conflict pro kolizi kind", () => {
  assert.equal(resolveCatalogItemForApply({ internalCode: "M57", sourceSystem: "excel-v6.6", sourceKey: "m57", kind: "furniture" }, []).action, "insert");
  assert.equal(
    resolveCatalogItemForApply({ internalCode: "M57", sourceSystem: "excel-v6.6", sourceKey: "m57", kind: "furniture" }, [{ id: "x", internalCode: "M57", kind: "furniture" }]).action,
    "noop",
  );
  assert.equal(
    resolveCatalogItemForApply({ internalCode: "M57", sourceSystem: "excel-v6.6", sourceKey: "m57", kind: "furniture" }, [{ id: "x", internalCode: "M57", kind: "service" }]).action,
    "conflict",
  );
});

test("resolvePricingEntryForApply: insert/noop/update podle existující importované ceny", () => {
  const existing = [{ id: "pe-1", catalogItemId: "c1", priceListId: "pl-1", eventId: "e1", currency: "CZK" as const, salePrice: 5100, source: "import" as const, sourcePrice: 5100 }];
  assert.equal(resolvePricingEntryForApply({ catalogItemId: "c1", priceListId: "pl-1", eventId: "e1", currency: "CZK", salePrice: 5100 }, existing).action, "noop");
  assert.equal(resolvePricingEntryForApply({ catalogItemId: "c1", priceListId: "pl-1", eventId: "e1", currency: "CZK", salePrice: 5200 }, existing).action, "update");
  assert.equal(resolvePricingEntryForApply({ catalogItemId: "c1", priceListId: "pl-1", eventId: "e2", currency: "CZK", salePrice: 5100 }, existing).action, "insert");
});

test("resolvePricingEntryForApply: manual cena beze změny incoming = noop, manual cena se změněným incoming = conflict (nikdy silent overwrite)", () => {
  const existing = [{ id: "pe-1", catalogItemId: "c1", priceListId: "pl-1", eventId: "e1", currency: "CZK" as const, salePrice: 5300, source: "manual" as const, sourcePrice: 5100 }];
  const noopResult = resolvePricingEntryForApply({ catalogItemId: "c1", priceListId: "pl-1", eventId: "e1", currency: "CZK", salePrice: 5100 }, existing);
  assert.equal(noopResult.action, "noop");
  const conflictResult = resolvePricingEntryForApply({ catalogItemId: "c1", priceListId: "pl-1", eventId: "e1", currency: "CZK", salePrice: 5200 }, existing);
  assert.equal(conflictResult.action, "conflict");
  assert.equal(conflictResult.manualPrice, 5300);
  assert.equal(conflictResult.sourcePrice, 5100);
  assert.equal(conflictResult.incomingImportPrice, 5200);
});

test("apply preview (section 12): prázdná DB navrhuje insert 24 catalog_items, 2 catalog_mappings, 495 pricing_entries", () => {
  const plan = buildBatch2aPlan(fixturePreview(), componentCatalogItems, [], EXISTING_EVENTS, EXISTING_PRICE_LISTS, DECISIONS, REVIEW_TIMESTAMP, ABF_MATCHES);
  const preview = previewBatch2aApply(plan, [], [], []);
  assert.equal(preview.catalogItems.insert, 24);
  assert.equal(preview.catalogItems.noop, 0);
  assert.equal(preview.catalogItems.conflicts, 0);
  assert.equal(preview.catalogMappings.insert, 2);
  assert.equal(preview.pricingEntries.insert, 495);
  assert.equal(preview.pricingEntries.update, 0);
  assert.equal(preview.pricingEntries.noop, 0);
  assert.equal(preview.pricingEntries.conflicts, 0);
  assert.deepEqual(preview.pricingConflicts, []);
});
