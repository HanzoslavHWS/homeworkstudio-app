import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  BATCH2B_SOURCE_SYSTEM,
  categoryGroupFor,
  classifyPricelistItemKind,
  detectBatch2bConflicts,
  isBatch2bEligibleRow,
  parseBoothFootprintFromAbfName,
  parseFurnitureDimensionsFromAbfName,
  planP86Canonical,
  planPricelistItem,
  planPricelistItems,
  summarizeByCategoryGroup,
  type Batch2bSourceRow,
} from "../domain/importBatch2b.ts";
import type { ExistingCatalogItemRow } from "../domain/importBatch2a.ts";
import { boothTypes } from "../data/booths.ts";

// ---------------------------------------------------------------------------------------
// Small, realistic in-memory fixtures — NOT the real (gitignored) private-imports files, so
// these tests stay deterministic and portable, matching tests/importBatch2a.test.ts's own
// fixturePreview() pattern.
// ---------------------------------------------------------------------------------------

function row(overrides: Partial<Batch2bSourceRow> & Pick<Batch2bSourceRow, "sourceRow" | "category" | "nameCz">): Batch2bSourceRow {
  return {
    unit: null,
    status: "EXACT_SAFE",
    proposedCode: null,
    proposedName: null,
    proposedForeignName: null,
    proposedUnit: "ks",
    ...overrides,
  };
}

const T04_ROW = row({ sourceRow: 2, category: "Typovky", nameCz: "Typový stánek octanorm - T4", status: "EXACT_SAFE", proposedCode: "T04", proposedName: "T04 - TYPOVÝ STÁNEK 2X2 m (STAVBA)" });
const T06_ROW = row({ sourceRow: 3, category: "Typovky", nameCz: "Typový stánek octanorm - T6", status: "EXACT_SAFE", proposedCode: "T06", proposedName: "T06 - TYPOVÝ STÁNEK 3X2 m (STAVBA)" });
const M57_ROW = row({ sourceRow: 68, category: "Nábytek", nameCz: "Židle čalouněná", status: "EXACT_SAFE", proposedCode: "M57", proposedName: "ŽIDLE KOVOVÁ ČALOUNĚNÁ" });
const REVIEW_ROW = row({ sourceRow: 19, category: "Stavba", nameCz: "Dveře shrnovací, uzamykatelné", status: "REVIEW", proposedCode: "M07", proposedName: "DVEŘE SHRNOVACÍ UZAMYKATELNÉ 1030X2000" });
const NO_MATCH_ROW = row({ sourceRow: 17, category: "Stavba", nameCz: "Stěna plná - octanorm (výška 250 cm) - 1 bm", status: "NO_MATCH" });
const TECHNICAL_SERVICE_ROW = row({ sourceRow: 200, category: "T. služby", nameCz: "Přípojka el. energie - 3kW", status: "EXACT_SAFE", proposedCode: "L03", proposedName: "PŘÍPOJKA EL. ENERGIE - 3KW" });
const TABLE_ROW = row({ sourceRow: 63, category: "Nábytek", nameCz: "Stůl 70x120x75 cm", status: "EXACT_SAFE", proposedCode: "M51", proposedName: "STŮL HRANATÝ 70X120X75 cm" });
const SVETLO_ROW = row({ sourceRow: 54, category: "Světlo", nameCz: "Bodové svítidlo 60 W", status: "EXACT_SAFE", proposedCode: "M60", proposedName: "SVÍTIDLO BODOVÉ 60 W" });

const M57_EXISTING: ExistingCatalogItemRow = { id: "existing-m57-uuid", internalCode: "M57", kind: "furniture", sourceSystem: BATCH2B_SOURCE_SYSTEM, sourceKey: "pricelist::nabytek::zidle-calounena" };
const L02_EXISTING: ExistingCatalogItemRow = { id: "existing-l02-uuid", internalCode: "L02", kind: "service" };
const NO_EXISTING: readonly ExistingCatalogItemRow[] = [];

// -----------------------------------------------------------------------------------------
// EXACT_SAFE / REVIEW / NO_MATCH code assignment
// -----------------------------------------------------------------------------------------

test("pouze EXACT_SAFE dostane skutečný ABF internalCode", () => {
  const plan = planPricelistItem(T04_ROW, NO_EXISTING);
  assert.equal(plan.internalCode, "T04");
  assert.equal(plan.status, "exact_safe");
});

test("REVIEW nikdy nedostane internalCode, i když proposedCode existuje", () => {
  const plan = planPricelistItem(REVIEW_ROW, NO_EXISTING);
  assert.equal(plan.internalCode, null);
  assert.equal(plan.action, "review");
  assert.notEqual(plan.action, "insert");
});

test("NO_MATCH nikdy nedostane internalCode", () => {
  const plan = planPricelistItem(NO_MATCH_ROW, NO_EXISTING);
  assert.equal(plan.internalCode, null);
  assert.equal(plan.action, "skip");
});

// -----------------------------------------------------------------------------------------
// Existing canonical items never duplicated
// -----------------------------------------------------------------------------------------

test("existující M57 se nikdy neduplikuje — resolve na existující catalog_item, action=noop", () => {
  const plan = planPricelistItem(M57_ROW, [M57_EXISTING]);
  assert.equal(plan.action, "noop");
  assert.equal(plan.status, "skip_existing");
  assert.equal(plan.catalogTarget, "existing-m57-uuid");
});

test("existující L02 (Batch #2A technical identity) se nikdy neduplikuje, i kdyby se omylem dostal do plánované sady", () => {
  // L02 sits behind isBatch2bEligibleRow's category filter in normal use, but the resolver
  // itself must ALSO refuse to duplicate it if ever called directly — defense in depth.
  const l02Row = row({ sourceRow: 201, category: "T. služby", nameCz: "Přípojka el. energie - 2kW", status: "EXACT_SAFE", proposedCode: "L02", proposedName: "L02" });
  const plan = planPricelistItem(l02Row, [L02_EXISTING]);
  assert.equal(plan.action, "noop");
  assert.equal(plan.catalogTarget, "existing-l02-uuid");
});

test("Batch #2A technical-service identity (category='T. služby') se nikdy neplánuje v Batch #2B — isBatch2bEligibleRow ji vyřadí", () => {
  assert.equal(isBatch2bEligibleRow(TECHNICAL_SERVICE_ROW), false);
  const filtered = planPricelistItems([T04_ROW, TECHNICAL_SERVICE_ROW], NO_EXISTING);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]?.internalCode, "T04");
});

// -----------------------------------------------------------------------------------------
// sourceKey determinism / never normalized-name-only identity
// -----------------------------------------------------------------------------------------

test("sourceKey je deterministický pro stejný (sheet, category, name)", () => {
  const a = planPricelistItem(T04_ROW, NO_EXISTING);
  const b = planPricelistItem(T04_ROW, NO_EXISTING);
  assert.equal(a.sourceKey, b.sourceKey);
  assert.equal(a.sourceKey, "pricelist::typovky::typovy-stanek-octanorm---t4");
});

test("normalized name samo o sobě nikdy nerozhoduje identitu — dva různé kategorie se stejným názvem dostanou různý sourceKey", () => {
  const nabytekRow = row({ sourceRow: 500, category: "Nábytek", nameCz: "Lamino", status: "NO_MATCH" });
  const laminoRow = row({ sourceRow: 501, category: "Lamino", nameCz: "Lamino", status: "NO_MATCH" });
  const planA = planPricelistItem(nabytekRow, NO_EXISTING);
  const planB = planPricelistItem(laminoRow, NO_EXISTING);
  assert.notEqual(planA.sourceKey, planB.sourceKey);
});

test("existing lookup nikdy nepoužívá normalized name — jiný internalCode se stejným normalized name se nesloučí", () => {
  const differentNameSameCodeExisting: ExistingCatalogItemRow = { id: "some-other-uuid", internalCode: "T04", kind: "booth" };
  const plan = planPricelistItem(T04_ROW, [differentNameSameCodeExisting]);
  // Must resolve via internalCode match (T04), not by name — proves identity lookup path.
  assert.equal(plan.catalogTarget, "some-other-uuid");
  assert.equal(plan.action, "noop");
});

// -----------------------------------------------------------------------------------------
// P86 canonical explicit identity — never P84, never T04
// -----------------------------------------------------------------------------------------

const koje2x2 = boothTypes.find((booth) => booth.internalCode === "P86")!;

test("P86 canonical plán existuje a nese explicitní verification reasons (ne fuzzy matching)", () => {
  const plan = planP86Canonical(koje2x2, NO_EXISTING);
  assert.equal(plan.internalCode, "P86");
  assert.ok(plan.reasons.some((reason) => reason.includes("PŘÍMÝM ABF kódovým lookupem")));
});

test("P86 != P84: plán nikdy neoznačí P86 jako P84 ani nepoužije P84 název — 'P84'/'JOBS' se smí objevit JEN v disambiguation reasons, nikde jinde", () => {
  const plan = planP86Canonical(koje2x2, NO_EXISTING);
  assert.notEqual(plan.internalCode, "P84");
  assert.notEqual(plan.sourceName, "KÓJE 2X2 JOBS");
  const { reasons, ...withoutReasons } = plan;
  assert.doesNotMatch(JSON.stringify(withoutReasons), /P84|JOBS/u);
  assert.ok(reasons.some((reason) => reason.includes("P84")), "reasons musí explicitně zmínit P84 jako disambiguation warning");
});

test("P86 != T04: přestože oba mají footprint 2×2 m, jde o odlišné položky s odlišným internalCode", () => {
  const p86Plan = planP86Canonical(koje2x2, NO_EXISTING);
  const t04Plan = planPricelistItem(T04_ROW, NO_EXISTING);
  assert.notEqual(p86Plan.internalCode, t04Plan.internalCode);
  assert.equal(p86Plan.internalCode, "P86");
  assert.equal(t04Plan.internalCode, "T04");
  assert.notEqual(p86Plan.sourceKey, t04Plan.sourceKey);
});

test("P86 canonical identity zachovává existující package/business definici (rozměry z reálného seedu, ne z fuzzy reportu)", () => {
  const plan = planP86Canonical(koje2x2, NO_EXISTING);
  assert.deepEqual(plan.dimensions, { widthMm: 2000, depthMm: 2000, heightMm: 2500 });
  assert.equal(plan.assetStatus, "reused-from-seed");
});

test("P86 se nikdy neduplikuje, pokud už existuje v DB", () => {
  const p86Existing: ExistingCatalogItemRow = { id: "existing-p86-uuid", internalCode: "P86", kind: "booth" };
  const plan = planP86Canonical(koje2x2, [p86Existing]);
  assert.equal(plan.action, "noop");
  assert.equal(plan.catalogTarget, "existing-p86-uuid");
});

// -----------------------------------------------------------------------------------------
// Txx family — each resolves its expected code, dimensions never conflict
// -----------------------------------------------------------------------------------------

test("T04 resolvuje očekávaný ABF kód a rozměry 2000x2000mm z ABF proposedName", () => {
  const plan = planPricelistItem(T04_ROW, NO_EXISTING);
  assert.equal(plan.internalCode, "T04");
  assert.deepEqual(plan.dimensions, { widthMm: 2000, depthMm: 2000 });
  assert.equal(plan.catalogKind, "booth");
});

test("T06 resolvuje očekávaný ABF kód a rozměry 3000x2000mm — odlišné od T04, žádný konflikt", () => {
  const plan = planPricelistItem(T06_ROW, NO_EXISTING);
  assert.equal(plan.internalCode, "T06");
  assert.deepEqual(plan.dimensions, { widthMm: 3000, depthMm: 2000 });
  assert.notDeepEqual(plan.dimensions, planPricelistItem(T04_ROW, NO_EXISTING).dimensions);
});

test("Txx dimenze se parsují jen z jednoznačného 'WxD m' patternu — žádné vymyšlené rozměry pro nejasný text", () => {
  const unclear = row({ sourceRow: 999, category: "Typovky", nameCz: "Typový stánek bez rozměru", status: "EXACT_SAFE", proposedCode: "T99", proposedName: "T99 - TYPOVÝ STÁNEK (STAVBA)" });
  const plan = planPricelistItem(unclear, NO_EXISTING);
  assert.equal(plan.dimensions, undefined);
});

// -----------------------------------------------------------------------------------------
// Conflict detection — duplicate internalCode, duplicate sourceKey
// -----------------------------------------------------------------------------------------

test("duplicitní internalCode v rámci plánovaných insertů je detekován jako conflict", () => {
  const rowA = row({ sourceRow: 700, category: "Nábytek", nameCz: "Položka A", status: "EXACT_SAFE", proposedCode: "M99", proposedName: "M99 TEST" });
  const rowB = row({ sourceRow: 701, category: "Kuchyňka", nameCz: "Položka B", status: "EXACT_SAFE", proposedCode: "M99", proposedName: "M99 TEST 2" });
  const items = planPricelistItems([rowA, rowB], NO_EXISTING);
  const conflicts = detectBatch2bConflicts(items, NO_EXISTING);
  assert.ok(conflicts.some((conflict) => conflict.kind === "duplicate_internal_code_in_plan" && conflict.internalCode === "M99"));
});

test("duplicitní sourceKey (stejná kategorie+název dvakrát) je detekován jako conflict", () => {
  const items = planPricelistItems([T04_ROW, T04_ROW], NO_EXISTING);
  const conflicts = detectBatch2bConflicts(items, NO_EXISTING);
  assert.ok(conflicts.some((conflict) => conflict.kind === "duplicate_source_key_in_plan"));
});

test("žádné conflicty pro čistý, bezkolizní plán (T04, T06, M57 existující)", () => {
  const items = planPricelistItems([T04_ROW, T06_ROW, M57_ROW], [M57_EXISTING]);
  const conflicts = detectBatch2bConflicts(items, [M57_EXISTING]);
  assert.deepEqual(conflicts, []);
});

// -----------------------------------------------------------------------------------------
// EXACT_SAFE code alone never implies generatorEligible
// -----------------------------------------------------------------------------------------

test("EXACT_SAFE samo o sobě NEZNAMENÁ generatorEligible=true — nová položka je vždy needs_review/false", () => {
  const plan = planPricelistItem(T04_ROW, NO_EXISTING);
  assert.equal(plan.status, "exact_safe");
  assert.equal(plan.generatorEligible, false);
  assert.equal(plan.lifecycleStatus, "needs_review");
});

test("furniture EXACT_SAFE (stůl) je také needs_review/generatorEligible=false, i s vysokou match confidence", () => {
  const plan = planPricelistItem(TABLE_ROW, NO_EXISTING);
  assert.equal(plan.generatorEligible, false);
  assert.equal(plan.lifecycleStatus, "needs_review");
});

// -----------------------------------------------------------------------------------------
// Missing asset never invents a path
// -----------------------------------------------------------------------------------------

test("chybějící asset se nikdy nevymyslí — nová položka bez známého GLB/foto má assetStatus='missing', nikdy fabrikovanou cestu", () => {
  const plan = planPricelistItem(T04_ROW, NO_EXISTING);
  assert.equal(plan.assetStatus, "missing");
});

test("položka reusující existující seed (P86) má assetStatus='reused-from-seed', ne 'missing' ani vymyšlenou cestu jinam", () => {
  const plan = planP86Canonical(koje2x2, NO_EXISTING);
  assert.equal(plan.assetStatus, "reused-from-seed");
});

// -----------------------------------------------------------------------------------------
// Kind classification — never invents a new kind, ambiguous -> low confidence / needs_review
// -----------------------------------------------------------------------------------------

test("kategorie 'Světlo' (osvětlení) nemá jistou kind klasifikaci — confident=false, kind zůstává v podporovaném enumu", () => {
  const classification = classifyPricelistItemKind({ category: "Světlo", proposedCode: "M60" });
  assert.equal(classification.confident, false);
  assert.ok(["booth", "construction", "furniture", "technical_point", "service", "graphics_service", "floor_finish", "other"].includes(classification.kind));
});

test("koberec (M01/M02) se klasifikuje jako floor_finish s jistotou", () => {
  assert.equal(classifyPricelistItemKind({ category: "Stavba", proposedCode: "M01" }).kind, "floor_finish");
  assert.equal(classifyPricelistItemKind({ category: "Stavba", proposedCode: "M01" }).confident, true);
});

test("planPricelistItem pro Světlo kategorii zanese warning o nejisté klasifikaci", () => {
  const plan = planPricelistItem(SVETLO_ROW, NO_EXISTING);
  assert.ok(plan.warnings.length > 0);
});

// -----------------------------------------------------------------------------------------
// Dimension parsing helpers — never invent partial/ambiguous matches
// -----------------------------------------------------------------------------------------

test("parseFurnitureDimensionsFromAbfName parsuje jen jednoznačný WxDxH cm formát", () => {
  assert.deepEqual(parseFurnitureDimensionsFromAbfName("STŮL HRANATÝ 70X120X75 cm"), { widthMm: 700, depthMm: 1200, heightMm: 750 });
  assert.equal(parseFurnitureDimensionsFromAbfName("STŮL BEZ ROZMĚRU"), undefined);
  assert.equal(parseFurnitureDimensionsFromAbfName(null), undefined);
});

test("parseBoothFootprintFromAbfName parsuje jen jednoznačný WxD m formát", () => {
  assert.deepEqual(parseBoothFootprintFromAbfName("T04 - TYPOVÝ STÁNEK 2X2 m (STAVBA)"), { widthMm: 2000, depthMm: 2000 });
  assert.equal(parseBoothFootprintFromAbfName("TYPOVÝ STÁNEK BEZ ROZMĚRU"), undefined);
});

// -----------------------------------------------------------------------------------------
// Category summary / grouping sanity
// -----------------------------------------------------------------------------------------

test("summarizeByCategoryGroup rozdělí REVIEW a NO_MATCH do samostatných skupin, nikdy do Furniture/Booths", () => {
  const items = planPricelistItems([T04_ROW, REVIEW_ROW, NO_MATCH_ROW], NO_EXISTING);
  const summaries = summarizeByCategoryGroup(items);
  const reviewGroup = summaries.find((summary) => summary.group === "REVIEW");
  const noMatchGroup = summaries.find((summary) => summary.group === "NO_MATCH");
  assert.equal(reviewGroup?.sourceCount, 1);
  assert.equal(noMatchGroup?.sourceCount, 1);
  assert.equal(categoryGroupFor(planPricelistItem(REVIEW_ROW, NO_EXISTING)), "REVIEW");
});

// -----------------------------------------------------------------------------------------
// No R2 / no DB writes / manual pricing protection untouched — structural guards
// -----------------------------------------------------------------------------------------

test("domain/importBatch2b.ts obsahuje pouze čistou plánovací logiku — žádný Supabase/R2 import", () => {
  const source = readFileSync(new URL("../domain/importBatch2b.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /supabase-js|createClient|@aws-sdk|cloudflareR2/iu);
});

test("scripts/importBatch2b.ts nikdy nevolá insert/update/upsert/delete na pricing_entries ani catalog_items (dry-run only)", () => {
  const source = readFileSync(new URL("../scripts/importBatch2b.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\.insert\(|\.update\(|\.upsert\(|\.delete\(/u);
  assert.match(source, /DATABASE WRITES.*0|DATABASE WRITES: 0/u);
});

test("scripts/importBatch2b.ts nikdy neimportuje R2/asset upload moduly", () => {
  const source = readFileSync(new URL("../scripts/importBatch2b.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /cloudflareR2|assetClient|uploadAsset|@aws-sdk/iu);
});

test("Batch #2B modul nezasahuje do manual pricing protection (pricingAdmin.ts source/sourcePrice logika) — žádný import odtud", () => {
  const domainSource = readFileSync(new URL("../domain/importBatch2b.ts", import.meta.url), "utf8");
  const scriptSource = readFileSync(new URL("../scripts/importBatch2b.ts", import.meta.url), "utf8");
  assert.doesNotMatch(domainSource, /pricingAdmin/u);
  assert.doesNotMatch(scriptSource, /resolveImportPriceUpdate|saveManyPricingEntriesAdmin|duplicatePriceListAdmin/u);
});
