import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  buildBatch1Plan,
  planEvents,
  planPriceLists,
  planStagedPricingRows,
  summarizeBatch1Plan,
  type ExistingEventRow,
  type ExistingPriceListRow,
  type MappingDecision,
} from "../domain/importBatch1.ts";
import type { ImportEventPreview, ImportPreview } from "../domain/importBatch.ts";
import { normalizeExhibition } from "../domain/organizations.ts";
import { boothTypes } from "../data/booths.ts";

function fixturePreview(overrides: Partial<ImportPreview> = {}): ImportPreview {
  const events: ImportEventPreview[] = [
    { sourceKey: "ctm", name: "Czech Travel Market", startDate: null, endDate: null, needsReview: true },
    { sourceKey: "beauty", name: "For Beauty", startDate: "2026-10-02", endDate: "2026-10-03", needsReview: false },
    { sourceKey: "fishing", name: "For Fishing", startDate: "2027-02-18", endDate: "2027-02-21", needsReview: false },
  ];
  return {
    counts: {
      events: events.length, eventsNeedingReview: 1, catalogRows: 0, categories: [],
      basePricesCzkPresent: 0, basePricesCzkMissing: 0, basePricesEurPresent: 0, basePricesEurMissing: 0,
      purchasePricesCzkPresent: 0, purchasePricesCzkMissing: 0, technicalServiceRows: 1,
      eventPricingEntriesCzk: 1, eventPricingEntriesEur: 1, missingEventPricingCzk: 1, missingEventPricingEur: 2,
      rowsNeedingUnitReview: 0, candidateMappingRows: 0, technicalPurchasePricesCzkPresent: 0,
    },
    events,
    catalogRows: [
      { sourceRow: 68, category: "Nábytek", rawNameCz: "Židle čalouněná", rawNameEn: "Upholstered chair", unit: null, unitNeedsReview: true, saleCzk: { amount: 300, status: "priced" }, saleEur: { amount: 13, status: "priced" }, purchaseCzk: { amount: 170, status: "priced" }, candidates: [] },
      { sourceRow: 143, category: "T. služby", rawNameCz: "Přípojka el. energie - 2kW", rawNameEn: "Electricity supply connection - 2kW", unit: null, unitNeedsReview: true, saleCzk: { amount: null, status: "missing" }, saleEur: { amount: null, status: "missing" }, purchaseCzk: { amount: null, status: "missing" }, candidates: [] },
      { sourceRow: 90, category: "Kuchyňka", rawNameCz: "Rychlovarná konvice příkon 2 kW", rawNameEn: "Electric kettle, power 2 kW", unit: null, unitNeedsReview: true, saleCzk: { amount: 280, status: "priced" }, saleEur: { amount: 12, status: "priced" }, purchaseCzk: { amount: 150, status: "priced" }, candidates: [] },
    ],
    technicalServiceRows: [
      {
        rawName: "Přípojka el. energie - 2kW",
        eventPrices: [
          { eventSourceKey: "ctm", czk: { amount: null, status: "missing" }, eur: { amount: null, status: "missing" } },
          { eventSourceKey: "beauty", czk: { amount: 5100, status: "priced" }, eur: { amount: 231, status: "priced" } },
          { eventSourceKey: "fishing", czk: { amount: null, status: "missing" }, eur: { amount: null, status: "missing" } },
        ],
        candidates: [],
      },
    ],
    ...overrides,
  };
}

test("dry-run/plan core (domain/importBatch1.ts) nemá žádnou závislost na síti/Supabase", () => {
  const source = readFileSync(new URL("../domain/importBatch1.ts", import.meta.url), "utf8");
  // Real dependency signals, not prose: no import from a "*supabase*" module, no @supabase
  // package, no SupabaseClient type, no fetch() call. Comments mentioning the word
  // "Supabase" while explaining the blocker are fine and expected.
  assert.equal(/from\s+["'][^"']*supabase[^"']*["']/iu.test(source), false);
  assert.equal(/@supabase/u.test(source), false);
  assert.equal(/SupabaseClient/u.test(source), false);
  assert.equal(/fetch\(/u.test(source), false);
  // buildBatch1Plan/planEvents/planPriceLists are plain synchronous functions — structurally
  // incapable of performing I/O (no client parameter, no async).
  assert.equal(buildBatch1Plan.constructor.name, "Function");
  assert.equal(planEvents.constructor.name, "Function");
});

test("nový event se naplánuje jako insert; CTM null datum se zachová a je needsReview", () => {
  const plan = planEvents(fixturePreview().events, []);
  const ctm = plan.find((e) => e.sourceKey === "ctm")!;
  assert.equal(ctm.action, "insert");
  assert.equal(ctm.needsReview, true);
  assert.equal(ctm.event.eventFrom, undefined);
  assert.equal(ctm.event.eventTo, undefined);
  assert.match(ctm.reviewReason ?? "", /nevymyšleno/u);
});

test("idempotentní import: existující event podle source_key (i s jiným DB id) se nikdy neduplikuje", () => {
  const existing: ExistingEventRow[] = [
    { id: "some-other-uuid-not-equal-to-sourcekey", sourceKey: "beauty", document: normalizeExhibition({ id: "some-other-uuid-not-equal-to-sourcekey", slug: "beauty", name: "For Beauty", year: 2026, eventFrom: "2026-10-02", eventTo: "2026-10-03" }) },
  ];
  const plan = planEvents(fixturePreview().events, existing);
  const beauty = plan.find((e) => e.sourceKey === "beauty")!;
  assert.equal(beauty.action, "noop");
  assert.equal(beauty.event.id, "some-other-uuid-not-equal-to-sourcekey", "musí zachovat existující DB id, ne přepsat na sourceKey");
});

test("reimport stejného batche (existující stav = výstup prvního plánu) už nic nevykazuje jako insert", () => {
  const preview = fixturePreview();
  const firstPlan = planEvents(preview.events, []);
  const existingAfterFirstApply: ExistingEventRow[] = firstPlan.map((p) => ({ id: p.event.id, sourceKey: p.sourceKey, document: p.event }));
  const secondPlan = planEvents(preview.events, existingAfterFirstApply);
  assert.ok(secondPlan.every((e) => e.action === "noop"));
});

test("price list currency isolation: CZK a EUR jsou vždy oddělené kódy, žádné míchání", () => {
  const plan = planPriceLists(fixturePreview().events, []);
  const beautyLists = plan.filter((p) => p.eventSourceKey === "beauty");
  assert.equal(beautyLists.length, 2);
  assert.deepEqual(new Set(beautyLists.map((p) => p.currency)), new Set(["CZK", "EUR"]));
  assert.notEqual(beautyLists[0]?.code, beautyLists[1]?.code);
  assert.ok(plan.every((p) => p.code.endsWith(`-${p.currency}`)));
});

test("price list reimport (existující code) je noop, ne duplicitní insert", () => {
  const first = planPriceLists(fixturePreview().events, []);
  const existing: ExistingPriceListRow[] = first.map((p) => ({ id: `id-${p.code}`, code: p.code }));
  const second = planPriceLists(fixturePreview().events, existing);
  assert.ok(second.every((p) => p.action === "noop"));
});

test("staged pricing: žádný CZK->EUR přepočet, missing zůstává NULL nikdy 0", () => {
  const rows = planStagedPricingRows("batch-1", fixturePreview());
  const czkRow = rows.find((r) => r.sourceSheet === "CZK")!;
  const eurRow = rows.find((r) => r.sourceSheet === "EUR")!;
  const czkBeauty = (czkRow.normalizedValues as { perEvent: { eventSourceKey: string; amount: number | null }[] }).perEvent.find((e) => e.eventSourceKey === "beauty");
  const eurBeauty = (eurRow.normalizedValues as { perEvent: { eventSourceKey: string; amount: number | null }[] }).perEvent.find((e) => e.eventSourceKey === "beauty");
  assert.equal(czkBeauty?.amount, 5100);
  assert.equal(eurBeauty?.amount, 231);
  // 231 is not derived from 5100 by any rate — independently sourced, exactly as parsed.
  assert.notEqual(eurBeauty?.amount, czkBeauty?.amount);

  const czkCtm = (czkRow.normalizedValues as { perEvent: { eventSourceKey: string; amount: number | null; status: string }[] }).perEvent.find((e) => e.eventSourceKey === "ctm");
  assert.equal(czkCtm?.amount, null);
  assert.equal(czkCtm?.status, "missing");
  assert.notEqual(czkCtm?.amount, 0);
});

test("staged pricing rows nikdy nemají priceMode individual/included — jen fixed pro skutečné číslo, nic pro missing", () => {
  const rows = planStagedPricingRows("batch-1", fixturePreview());
  const perEventEntries = rows.flatMap((r) => (r.normalizedValues as { perEvent: { status: string; priceMode?: string }[] }).perEvent);
  assert.ok(perEventEntries.every((e) => e.priceMode === undefined || e.priceMode === "fixed"));
  assert.ok(perEventEntries.filter((e) => e.status === "missing").every((e) => e.priceMode === undefined));
});

test("confirmed M57 mapping se propíše do mapping decision řádku", () => {
  const decisions: MappingDecision[] = [{ identity: { sourceSheet: "PRICELIST", category: "Nábytek", rawName: "Židle čalouněná" }, decision: "confirmed", targetInternalCode: "M57" }];
  const plan = buildBatch1Plan("batch-1", fixturePreview(), [], [], decisions);
  const row = plan.mappingDecisionRows.find((r) => r.rawName === "Židle čalouněná")!;
  assert.equal(row.mappingStatus, "confirmed");
  assert.equal((row.normalizedValues as { targetInternalCode: string }).targetInternalCode, "M57");
  assert.notEqual(row.sourceRow, -1, "měl by se spárovat se skutečným PRICELIST řádkem");
});

test("confirmed L02 mapping se propíše do mapping decision řádku", () => {
  const decisions: MappingDecision[] = [{ identity: { sourceSheet: "PRICELIST", category: "T. služby", rawName: "Přípojka el. energie - 2kW" }, decision: "confirmed", targetInternalCode: "L02" }];
  const plan = buildBatch1Plan("batch-1", fixturePreview(), [], [], decisions);
  const row = plan.mappingDecisionRows.find((r) => r.rawName === "Přípojka el. energie - 2kW")!;
  assert.equal(row.mappingStatus, "confirmed");
  assert.equal((row.normalizedValues as { targetInternalCode: string }).targetInternalCode, "L02");
});

test("rejected kettle/L02 mapping se uloží jako rejected s důvodem, nikdy jako confirmed", () => {
  const decisions: MappingDecision[] = [{ identity: { sourceSheet: "PRICELIST", category: "Kuchyňka", rawName: "Rychlovarná konvice příkon 2 kW" }, decision: "rejected", targetInternalCode: "L02", reason: "shared_spec_token only" }];
  const plan = buildBatch1Plan("batch-1", fixturePreview(), [], [], decisions);
  const row = plan.mappingDecisionRows.find((r) => r.rawName === "Rychlovarná konvice příkon 2 kW")!;
  assert.equal(row.mappingStatus, "rejected");
  assert.equal(row.issues.length > 0, true);
});

test("P86 zůstává netknuté — žádný mapping decision, žádná staged pricing row a booth seed beze změny", () => {
  const decisions: MappingDecision[] = [
    { identity: { sourceSheet: "PRICELIST", category: "Nábytek", rawName: "Židle čalouněná" }, decision: "confirmed", targetInternalCode: "M57" },
    { identity: { sourceSheet: "PRICELIST", category: "T. služby", rawName: "Přípojka el. energie - 2kW" }, decision: "confirmed", targetInternalCode: "L02" },
    { identity: { sourceSheet: "PRICELIST", category: "Kuchyňka", rawName: "Rychlovarná konvice příkon 2 kW" }, decision: "rejected", targetInternalCode: "L02" },
  ];
  const plan = buildBatch1Plan("batch-1", fixturePreview(), [], [], decisions);
  assert.equal(plan.mappingDecisionRows.some((r) => JSON.stringify(r.normalizedValues).includes("P86")), false);
  assert.equal(plan.stagedPricingRows.some((r) => r.rawName.includes("P86")), false);

  const p86 = boothTypes.find((booth) => booth.internalCode === "P86")!;
  assert.equal(p86.name, "Kóje 2 × 2 m");
  assert.equal(p86.widthMm, 2000);
  assert.equal(p86.depthMm, 2000);
});

test("dry-run summary hlásí databaseWrites = 0", () => {
  const plan = buildBatch1Plan("batch-1", fixturePreview(), [], [], []);
  const summary = summarizeBatch1Plan(plan, "dry-run");
  assert.equal(summary.databaseWrites, 0);
  // Section 7: pricing_entries insert/update/noop must always be 0 — staged in import_rows instead.
  assert.equal(summary.pricingEntries.insert, 0);
  assert.equal(summary.pricingEntries.update, 0);
  assert.equal(summary.pricingEntries.noop, 0);
});

test("buildBatch1Plan nemutuje vstupní preview ani existující data (čistá funkce)", () => {
  const preview = fixturePreview();
  const guardedEvents = new Proxy(preview.events, { set() { throw new Error("mutace events"); } });
  const plan = buildBatch1Plan("batch-1", { ...preview, events: guardedEvents as typeof preview.events }, [], [], []);
  assert.ok(plan.events.length > 0);
});
