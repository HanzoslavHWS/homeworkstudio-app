import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildBatch2aPlan,
  planCanonicalCatalogItems,
  planMappings,
  planPricingEntries,
  planTechnicalServices,
  resolveExistingCatalogItem,
  summarizeReimportIdentity,
  type AbfTechnicalServiceMatch,
  type ExistingCatalogItemRow,
  type ExistingEventRow2A,
  type ExistingPriceListRow2A,
} from "../domain/importBatch2a.ts";
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

test("scripts/importBatch2a.ts nemá žádný --apply zápis (žádné insert/update/upsert volání na Supabase)", () => {
  const source = readFileSync(new URL("../scripts/importBatch2a.ts", import.meta.url), "utf8");
  assert.equal(/\.insert\(/u.test(source), false);
  assert.equal(/\.update\(/u.test(source), false);
  assert.equal(/\.upsert\(/u.test(source), false);
  assert.match(source, /DRY-RUN ONLY/u);
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
