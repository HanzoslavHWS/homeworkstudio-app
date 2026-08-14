import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  attachBasePricing,
  BATCH2B_SOURCE_SYSTEM,
  Batch2bPreflightError,
  buildBatch2bCatalogDocument,
  categoryGroupFor,
  classifyPricelistItemKind,
  detectBatch2bConflicts,
  isBatch2bEligibleRow,
  parseBoothFootprintFromAbfName,
  parseFurnitureDimensionsFromAbfName,
  planBatch2bMappings,
  planP86Canonical,
  planPricelistItem,
  planPricelistItems,
  previewBatch2bApply,
  runBatch2bPreflight,
  simulatePostApplyExistingItems,
  summarizeByCategoryGroup,
  type Batch2bPlanItem,
  type Batch2bSourceRow,
  type ExistingCatalogMappingRow,
} from "../domain/importBatch2b.ts";
import { CatalogItemConflictError, type ExistingCatalogItemRow } from "../domain/importBatch2a.ts";
import { applyBatch2bPlan, readExistingCatalogItemsSafely, TransientReadError } from "../lib/db/importBatch2b.supabase.ts";
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

// =========================================================================================
// SECTION 20 — APPLY WRITER (lib/db/importBatch2b.supabase.ts). NEVER invoked against real
// Supabase — fake in-memory client only, mirrors tests/importBatch2a.test.ts's own pattern.
// =========================================================================================

/** 10 Txx booths (section 5) — distinct footprints so no dimension/sourceKey collides. */
function buildTxxRows(): readonly Batch2bSourceRow[] {
  const specs: ReadonlyArray<readonly [string, number, number]> = [
    ["T04", 2, 2], ["T06", 3, 2], ["T09", 3, 3], ["T12", 4, 3], ["T15", 4, 4],
    ["T16", 5, 4], ["T18", 5, 5], ["T20", 6, 4], ["T24", 6, 6], ["T25", 8, 5],
  ];
  return specs.map(([code, w, d], i) =>
    row({ sourceRow: 10 + i, category: "Typovky", nameCz: `Typový stánek octanorm - ${code}`, status: "EXACT_SAFE", proposedCode: code, proposedName: `${code} - TYPOVÝ STÁNEK ${w}X${d} m (STAVBA)` }),
  );
}

/** 46 ordinary furniture rows, deliberately WITHOUT a dimension pattern in proposedName — missing dimensions must stay missing (section 3/16), never invented. */
function buildFurnitureRows(count: number): readonly Batch2bSourceRow[] {
  return Array.from({ length: count }, (_, i) =>
    row({ sourceRow: 1000 + i, category: "Nábytek", nameCz: `Testovací nábytek ${i + 1}`, status: "EXACT_SAFE", proposedCode: `F${String(i + 1).padStart(2, "0")}`, proposedName: `TESTOVACÍ NÁBYTEK ${i + 1}` }),
  );
}

const FULL_FIXTURE_ROWS: readonly Batch2bSourceRow[] = [...buildTxxRows(), ...buildFurnitureRows(46), M57_ROW];

/** 10 Txx + 46 furniture + M57(existing, noop) + P86(new) — mirrors the real report's 56 new / 1 noop / 1 canonical shape. */
function buildFullPlanItems(existing: readonly ExistingCatalogItemRow[] = [M57_EXISTING]): readonly Batch2bPlanItem[] {
  return [...planPricelistItems(FULL_FIXTURE_ROWS, existing), planP86Canonical(koje2x2, existing)];
}

const TEST_META = { sourceFileName: "test-fixture.json", sourceFingerprint: "fp-test-fixture" };

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
        const matched = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
        if (singleMode === "single") return matched[0] ? { data: matched[0], error: null } : { data: null, error: { message: "not found" } };
        return { data: matched, error: null };
      }
      if (op === "insert") {
        const newRow: FakeRow = { id: `fake-id-${nextId++}`, ...payload };
        rows.push(newRow);
        if (singleMode === "single") return { data: newRow, error: null };
        return { data: [newRow], error: null };
      }
      if (op === "update") {
        const matched = rows.filter((r) => filters.every(([c, v]) => r[c] === v));
        for (const r of matched) Object.assign(r, payload);
        return { data: matched, error: null };
      }
      return { data: null, error: { message: `unsupported op ${op}` } };
    }

    return builder;
  }

  return { from, _tables: tables };
}

test("writer default je dry-run: previewBatch2bApply je čistá funkce, nikdy nepřijímá Supabase klienta", () => {
  assert.equal(previewBatch2bApply.length, 3); // (items, existingCatalogItems, existingMappings) — no client parameter
  const source = readFileSync(new URL("../domain/importBatch2b.ts", import.meta.url), "utf8");
  assert.equal(/@supabase/u.test(source), false);
});

test("scripts/importBatch2b.ts vyžaduje explicitní --apply flag; default je dry-run", () => {
  const source = readFileSync(new URL("../scripts/importBatch2b.ts", import.meta.url), "utf8");
  assert.match(source, /args\.includes\("--apply"\)/u);
  assert.match(source, /if \(!apply\)/u);
});

test("live preview (section 17): 57 insertů (56 nových + P86), 1 noop (M57), 0 konfliktů, 56 mapping insertů", () => {
  const items = buildFullPlanItems();
  const preview = previewBatch2bApply(items, [M57_EXISTING], []);
  assert.equal(preview.catalogItems.insert, 57);
  assert.equal(preview.catalogItems.noop, 1);
  assert.equal(preview.catalogItems.conflicts, 0);
  assert.equal(preview.catalogMappings.insert, 56);
  assert.equal(preview.catalogMappings.noop, 0);
  assert.deepEqual(preview.conflictDetails, []);
});

test("preflight (section 12): OK pro čistý 57-položkový plán, žádné issues", () => {
  const items = buildFullPlanItems();
  const preflight = runBatch2bPreflight(items, [M57_EXISTING]);
  assert.equal(preflight.ok, true);
  assert.deepEqual(preflight.issues, []);
});

test("preflight: STOP pokud se L02 objeví v plánu (L02 je výhradně Batch #2A) — apply se nikdy nespustí, ani import_batches řádek nevznikne", async () => {
  const client = createFakeSupabaseClient();
  const l02Row = row({ sourceRow: 9999, category: "Nábytek", nameCz: "Testovací L02 bug", status: "EXACT_SAFE", proposedCode: "L02", proposedName: "L02 BUG" });
  const badItems = [...buildFullPlanItems(), planPricelistItem(l02Row, [])];
  const preflight = runBatch2bPreflight(badItems, [M57_EXISTING]);
  assert.equal(preflight.ok, false);
  assert.ok(preflight.issues.some((issue) => issue.code === "l02_touched"));
  await assert.rejects(() => applyBatch2bPlan(client as never, badItems, koje2x2, TEST_META), (error) => error instanceof Batch2bPreflightError);
  const tables = (client as unknown as { _tables: Map<string, FakeRow[]> })._tables;
  assert.equal((tables.get("import_batches") ?? []).length, 0, "preflight STOP musí nastat před prvním zápisem");
});

test("10 Txx booths mají správnou identitu (kind=booth), 56 nových ordinary položek je needs_review/generatorEligible=false, jen P86 může být generatorEligible", () => {
  const items = buildFullPlanItems();
  const txxCodes = ["T04", "T06", "T09", "T12", "T15", "T16", "T18", "T20", "T24", "T25"];
  for (const code of txxCodes) {
    const item = items.find((entry) => entry.internalCode === code);
    assert.ok(item, `${code} chybí v plánu`);
    assert.equal(item!.catalogKind, "booth");
    assert.equal(item!.lifecycleStatus, "needs_review");
    assert.equal(item!.generatorEligible, false);
  }
  const newOrdinary = items.filter((item) => item.status === "exact_safe" && item.internalCode !== "P86");
  assert.equal(newOrdinary.length, 56);
  assert.ok(newOrdinary.every((item) => item.lifecycleStatus === "needs_review" && item.generatorEligible === false));
  const generatorEligibleCodes = items.filter((item) => item.generatorEligible).map((item) => item.internalCode);
  assert.ok(generatorEligibleCodes.every((code) => code === "P86"), "jedině P86 smí být generatorEligible=true");
});

test("žádná REVIEW ani NO_MATCH položka nikdy nedostane action=insert (preflight by to i tak zachytil)", () => {
  const items = planPricelistItems([REVIEW_ROW, NO_MATCH_ROW], NO_EXISTING);
  assert.ok(items.every((item) => item.action !== "insert"));
  const preflight = runBatch2bPreflight(items, NO_EXISTING);
  assert.equal(preflight.ok, true); // no violation here BECAUSE nothing was marked insert — proves the guard is structurally moot, not merely untested
});

test("chybějící rozměry zůstávají chybějící (46 furniture řádků bez WxDxH patternu -> dimensions=undefined, nikdy vymyšlené)", () => {
  const items = buildFullPlanItems();
  const furniture = items.filter((item) => item.internalCode?.startsWith("F"));
  assert.equal(furniture.length, 46);
  assert.ok(furniture.every((item) => item.dimensions === undefined));
});

test("buildBatch2bCatalogDocument nikdy nevymyslí modelUrl/GLB cestu pro nové needs_review položky — jen prázdné/undefined pole", () => {
  const items = buildFullPlanItems();
  const f01 = items.find((item) => item.internalCode === "F01")!;
  const document = buildBatch2bCatalogDocument(f01);
  assert.equal(document.modelUrl, undefined);
  assert.equal(document.widthMm, 0);
  assert.equal(document.depthMm, 0);
  assert.equal(document.heightMm, undefined);
});

test("sourceKey fallback identita je idempotentní i bez internalCode na existující DB řádce (nikdy jen normalized name)", () => {
  const testRow = row({ sourceRow: 5000, category: "Nábytek", nameCz: "Fallback test", status: "EXACT_SAFE", proposedCode: "F99", proposedName: "FALLBACK TEST" });
  const sourceKey = planPricelistItem(testRow, []).sourceKey;
  const existingBySourceKeyOnly: ExistingCatalogItemRow = { id: "existing-by-sourcekey", sourceSystem: BATCH2B_SOURCE_SYSTEM, sourceKey, kind: "furniture" };
  const plan = planPricelistItem(testRow, [existingBySourceKeyOnly]);
  assert.equal(plan.action, "noop");
  assert.equal(plan.catalogTarget, "existing-by-sourcekey");
});

test("idempotency simulace (section 15, pure): druhý previewBatch2bApply po simulatePostApplyExistingItems dává insert=0 pro catalog_items I catalog_mappings", () => {
  const items = buildFullPlanItems();
  const firstPreview = previewBatch2bApply(items, [M57_EXISTING], []);
  assert.equal(firstPreview.catalogItems.insert, 57);

  const simulatedItems = simulatePostApplyExistingItems(items, [M57_EXISTING]);
  assert.equal(simulatedItems.length, 58, "1 preexistující M57 + 57 nově vložených");

  const plannedMappings = planBatch2bMappings(items);
  const simulatedMappings: readonly ExistingCatalogMappingRow[] = plannedMappings.map((m) => ({ sourceSystem: m.sourceSystem, sourceKey: m.sourceKey, catalogItemId: `simulated-${m.catalogItemRef}` }));

  const secondPreview = previewBatch2bApply(items, simulatedItems, simulatedMappings);
  assert.equal(secondPreview.catalogItems.insert, 0, "druhý apply nesmí nic znovu vložit");
  assert.equal(secondPreview.catalogItems.noop, 58);
  assert.equal(secondPreview.catalogMappings.insert, 0, "0 duplicitních catalog_mappings insertů");
  assert.equal(secondPreview.catalogMappings.noop, 56);
});

test("apply writer end-to-end: první apply vloží 57 catalog_items + 56 catalog_mappings, M57 zůstává noop; druhý apply proti stejnému stavu je 0/0 (skutečná idempotence přes fake DB)", async () => {
  const client = createFakeSupabaseClient();
  (client as unknown as { _tables: Map<string, FakeRow[]> })._tables.set("catalog_items", [
    { id: M57_EXISTING.id, internal_code: "M57", kind: "furniture", document: { sourceSystem: BATCH2B_SOURCE_SYSTEM, sourceKey: M57_EXISTING.sourceKey } },
  ]);

  const items = buildFullPlanItems();
  const first = await applyBatch2bPlan(client as never, items, koje2x2, TEST_META);
  assert.equal(first.catalogItems.inserted, 57);
  assert.equal(first.catalogItems.noop, 1);
  assert.equal(first.catalogMappings.inserted, 56);
  assert.equal(first.pricingEntriesWrites, 0);

  const existingAfterFirst = await readExistingCatalogItemsSafely(client as never);
  assert.equal(existingAfterFirst.length, 58);
  assert.equal(existingAfterFirst.filter((r) => r.internalCode === "P86").length, 1, "P86 vzniká maximálně jednou");

  const secondItems = buildFullPlanItems(existingAfterFirst);
  const second = await applyBatch2bPlan(client as never, secondItems, koje2x2, TEST_META);
  assert.equal(second.catalogItems.inserted, 0, "druhý apply nesmí nic znovu vložit");
  assert.equal(second.catalogItems.noop, 58);
  assert.equal(second.catalogMappings.inserted, 0, "0 duplicitních catalog_mappings insertů");

  const finalCatalogItems = await readExistingCatalogItemsSafely(client as never);
  assert.equal(finalCatalogItems.length, 58, "žádné duplicitní catalog_items po dvou apply bězích");
  assert.equal(finalCatalogItems.filter((r) => r.internalCode === "P86").length, 1);

  const tables = (client as unknown as { _tables: Map<string, FakeRow[]> })._tables;
  assert.equal((tables.get("pricing_entries") ?? []).length, 0, "writer se nikdy nedotkne pricing_entries");
});

test("apply writer: catalog_mappings ukazující na jiný catalog_item_id (data drift) vyhodí CatalogItemConflictError, batch skončí status='failed', pricing_entries se nezapíše", async () => {
  const client = createFakeSupabaseClient();
  const items = buildFullPlanItems();
  const f01 = items.find((item) => item.internalCode === "F01")!;
  (client as unknown as { _tables: Map<string, FakeRow[]> })._tables.set("catalog_mappings", [
    { id: "stale-mapping", source_system: BATCH2B_SOURCE_SYSTEM, source_key: f01.sourceKey, catalog_item_id: "some-other-unrelated-id", confirmed: true },
  ]);

  await assert.rejects(() => applyBatch2bPlan(client as never, items, koje2x2, TEST_META), (error) => error instanceof CatalogItemConflictError);

  const tables = (client as unknown as { _tables: Map<string, FakeRow[]> })._tables;
  assert.equal((tables.get("import_batches") ?? [])[0]?.status, "failed");
  assert.equal((tables.get("pricing_entries") ?? []).length, 0, "pricing_entries se nesmí zapsat, pokud mapping krok selže");
});

test("transient read guard (section 13): dvě čtení catalog_items s rozdílným počtem řádků -> TransientReadError, STOP před jakýmkoli zápisem", async () => {
  const client = createFakeSupabaseClient();
  (client as unknown as { _tables: Map<string, FakeRow[]> })._tables.set("catalog_items", [{ id: "a", internal_code: "X1", kind: "furniture", document: {} }]);
  const realFrom = client.from.bind(client);
  let selectCount = 0;
  client.from = ((tableName: string) => {
    const builder = realFrom(tableName);
    if (tableName === "catalog_items") {
      const originalThen = builder.then.bind(builder);
      builder.then = ((onFulfilled: (value: { data: unknown; error: unknown }) => unknown, onRejected?: (reason: unknown) => unknown) => {
        selectCount += 1;
        if (selectCount === 2) return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
        return originalThen(onFulfilled, onRejected);
      }) as typeof builder.then;
    }
    return builder;
  }) as typeof client.from;

  await assert.rejects(() => readExistingCatalogItemsSafely(client as never), (error) => error instanceof TransientReadError);
});

test("transient read guard: dvě konzistentní čtení nikdy nevyhodí TransientReadError (happy path)", async () => {
  const client = createFakeSupabaseClient();
  (client as unknown as { _tables: Map<string, FakeRow[]> })._tables.set("catalog_items", [{ id: "a", internal_code: "M57", kind: "furniture", document: {} }]);
  const result = await readExistingCatalogItemsSafely(client as never);
  assert.equal(result.length, 1);
});

test("pricing_entries writes = 0 strukturálně garantováno typem (Batch2bApplyResult.pricingEntriesWrites je literal 0)", async () => {
  const client = createFakeSupabaseClient();
  const items = buildFullPlanItems();
  const result = await applyBatch2bPlan(client as never, items, koje2x2, TEST_META);
  assert.equal(result.pricingEntriesWrites, 0);
});

test("attachBasePricing nikdy nevymyslí cenu chybějící ve zdroji a P86 (sourceRow=-1) nikdy nedostane base pricing z PRICELIST mapy", () => {
  const items = buildFullPlanItems();
  const basePricingByRow = new Map([[1000, { saleCzk: 1000, saleEur: 40, purchaseCzk: 500 }]]);
  const enriched = attachBasePricing(items, basePricingByRow);
  const f01 = enriched.find((item) => item.internalCode === "F01")!;
  assert.deepEqual(f01.basePricing, { saleCzk: 1000, saleEur: 40, purchaseCzk: 500 });
  const f02 = enriched.find((item) => item.internalCode === "F02")!;
  assert.equal(f02.basePricing, undefined, "žádná cena ve zdroji -> zůstává undefined, nikdy vymyšlená");
  const p86 = enriched.find((item) => item.internalCode === "P86")!;
  assert.equal(p86.basePricing, undefined, "P86 (sourceRow=-1) nikdy nedostane PRICELIST base pricing");
});
