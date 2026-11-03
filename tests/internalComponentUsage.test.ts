import assert from "node:assert/strict";
import test from "node:test";
import { CatalogReadinessError, evaluateCatalogReadiness } from "../domain/catalogReadiness.ts";
import { computeReadiness, InvalidCatalogItemAdminEditError, parseCatalogItemAdminCreateInput } from "../domain/catalogItemsAdmin.ts";
import { BUILT_IN_CATALOG_CATEGORIES, classificationIssue, findCategory } from "../domain/catalogClassification.ts";
import { CrossCodeCollisionError } from "../domain/catalogItemTypes.ts";
import { boothComponentUsageChangeIssue, usageChangeWarningCs, usagesForCategory } from "../domain/internalComponentUsage.ts";
import { selectGeneratorBoothComponents } from "../domain/generatorBoothComponents.ts";
import { priceKit } from "../domain/catalogKitPricing.ts";
import type { CatalogPackageItem } from "../domain/catalogPackages.ts";
import { createCatalogItemAdmin, readCatalogItemsAdmin, saveCatalogItemAdmin } from "../lib/db/catalogItemsAdmin.supabase.ts";
import type { ComponentDefinition } from "../domain/models.ts";

// Minimal in-memory Supabase: select/insert/update + eq/single/maybeSingle (same shape as tests/catalogRevision.test.ts).
type FakeRow = Record<string, unknown>;
function fakeClient(seed: Readonly<Record<string, readonly FakeRow[]>> = {}) {
  const tables = new Map<string, FakeRow[]>(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  let clock = 0;
  let nextId = 1;
  const stamp = () => `2026-11-03T00:00:${String(++clock).padStart(2, "0")}.000Z`;
  function from(name: string) {
    if (!tables.has(name)) tables.set(name, []);
    const rows = tables.get(name)!;
    let op: "select" | "insert" | "update" = "select";
    let payload: FakeRow | FakeRow[] | undefined;
    let single: "none" | "single" | "maybe" = "none";
    const filters: [string, unknown][] = [];
    const run = async (): Promise<{ data: unknown; error: unknown }> => {
      const matches = (row: FakeRow) => filters.every(([column, value]) => row[column] === value);
      if (op === "insert") {
        const inserted = (Array.isArray(payload) ? payload : [payload!]).map((row) => ({ created_at: stamp(), updated_at: stamp(), ...row, id: row.id ?? `fake-${nextId++}` }));
        rows.push(...inserted);
        return { data: single === "none" ? inserted : inserted[0], error: null };
      }
      if (op === "update") {
        const matched = rows.filter(matches);
        for (const row of matched) Object.assign(row, payload, { updated_at: stamp() });
        return { data: matched, error: null };
      }
      const matched = rows.filter(matches);
      if (single === "maybe") return { data: matched[0] ?? null, error: null };
      if (single === "single") return { data: matched[0] ?? null, error: matched[0] ? null : { code: "PGRST116" } };
      return { data: matched, error: null };
    };
    const builder = {
      select() { return builder; },
      insert(row: FakeRow | FakeRow[]) { op = "insert"; payload = row; return builder; },
      update(patch: FakeRow) { op = "update"; payload = patch; return builder; },
      eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
      limit() { return builder; },
      single() { single = "single"; return run(); },
      maybeSingle() { single = "maybe"; return run(); },
      then(resolve: (value: { data: unknown; error: unknown }) => unknown, reject?: (reason: unknown) => unknown) { return run().then(resolve, reject); },
    };
    return builder;
  }
  return { from, tables };
}

const GLB = { modelAsset: { id: "glb", storageKey: "catalog/internal/post/model.glb" } };
const SKP = { sourceAssets: [{ id: "skp", kind: "sketchup", asset: { id: "skp", storageKey: "catalog/internal/post/source/post.skp" } }] };
const POST_DOCUMENT = { displayName: "Sloupek", name: "Sloupek", category: "Sloupky", unit: "ks", widthMm: 40, depthMm: 40, heightMm: 2500, showIn2D: true, footprint2D: { shape: "rectangle" } };

function internalRow(overrides: FakeRow = {}): FakeRow {
  return {
    id: "post-uuid", internal_code: "INT-SLOUPEK", abf_code: null, item_type: "INTERNAL_COMPONENT", kind: "construction",
    lifecycle_status: "needs_review", display_name: "Sloupek", official_name: null, category: "Sloupky", unit: "ks",
    document: { ...POST_DOCUMENT }, created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z", ...overrides,
  };
}
const asAdmin = async (rows: FakeRow[]) => (await readCatalogItemsAdmin(fakeClient({ catalog_items: rows }) as never));

// ---------------------------------------------------------------------------------------------
// Povinný interní / generátorový kód
// ---------------------------------------------------------------------------------------------

test("založení: interní komponenta s vlastním kódem a bez ABF kódu projde; bez kódu je odmítnuta", () => {
  const input = parseCatalogItemAdminCreateInput({ itemType: "INTERNAL_COMPONENT", kind: "construction", displayName: "Sloupek", category: "Sloupky", internalCode: "INT-SLOUPEK", unitCode: "ks" });
  assert.equal(input.internalCode, "INT-SLOUPEK");
  assert.equal(input.abfCode, undefined);
  assert.throws(() => parseCatalogItemAdminCreateInput({ itemType: "INTERNAL_COMPONENT", kind: "construction", displayName: "Sloupek", category: "Sloupky" }), /generátorový kód/u);
  // Other types keep their optional code.
  assert.doesNotThrow(() => parseCatalogItemAdminCreateInput({ itemType: "PRODUCT", displayName: "Stůl", category: "Nábytek" }));
});

test("kolize: shodný interní kód i interní kód rovný ABF kódu jiné karty jsou odmítnuty", async () => {
  const existing = [{ id: "m57", internal_code: "M57", abf_code: "M57", item_type: "PRODUCT", kind: "furniture", lifecycle_status: "active", display_name: "Židle", category: "chairs", document: {} }];
  await assert.rejects(() => createCatalogItemAdmin(fakeClient({ catalog_items: [...existing, internalRow()] }) as never, parseCatalogItemAdminCreateInput({ itemType: "INTERNAL_COMPONENT", kind: "construction", displayName: "X", category: "Sloupky", internalCode: "int-sloupek" })), /INT-SLOUPEK|int-sloupek/iu);
  const otherAbf = [{ ...existing[0], internal_code: "HWS-ZIDLE", abf_code: "Z99" }];
  await assert.rejects(() => createCatalogItemAdmin(fakeClient({ catalog_items: otherAbf }) as never, parseCatalogItemAdminCreateInput({ itemType: "INTERNAL_COMPONENT", kind: "construction", displayName: "X", category: "Sloupky", internalCode: "Z99" })), CrossCodeCollisionError);
});

test("Lifecycle: interní komponenta bez kódu hlásí „Chybí interní/generátorový kód“ a není připravená; produkt beze změny", async () => {
  const [codeless] = await asAdmin([internalRow({ internal_code: null, document: { ...POST_DOCUMENT, reviewedAt: "2026-11-02" } })]);
  assert.deepEqual(computeReadiness(codeless!).issues, ["missing_internal_code"]);
  const [withCode] = await asAdmin([internalRow({ document: { ...POST_DOCUMENT, reviewedAt: "2026-11-02" } })]);
  assert.equal(computeReadiness(withCode!).ready, true);
  const productConstruction = { ...POST_DOCUMENT, reviewedAt: "2026-11-02" } as unknown as ComponentDefinition;
  assert.equal(evaluateCatalogReadiness(productConstruction, "construction", { itemType: "PRODUCT" }).ready, true, "Produkt (Stavba) kód nevyžaduje — beze změny");
  assert.ok(evaluateCatalogReadiness(productConstruction, "booth_component").issues.includes("missing_internal_code"), "booth_component je vždy interní — kód vyžaduje i bez kontextu");
});

test("aktivace: bez kódu ji server odmítne; po doplnění kódu a schválení projde (bez GLB/SKP u konstrukčního dílu)", async () => {
  const client = fakeClient({ catalog_items: [internalRow({ internal_code: null })] });
  const reviewed = await saveCatalogItemAdmin(client as never, "post-uuid", { markReviewed: true }, null);
  await assert.rejects(() => saveCatalogItemAdmin(client as never, "post-uuid", { lifecycleStatus: "active" }, reviewed.updatedAt), CatalogReadinessError);
  const withCode = await saveCatalogItemAdmin(client as never, "post-uuid", { fillInternalCode: "INT-SLOUPEK" }, null);
  const active = await saveCatalogItemAdmin(client as never, "post-uuid", { lifecycleStatus: "active" }, withCode.updatedAt);
  assert.equal(active.lifecycleStatus, "active");
  assert.equal(active.internalCode, "INT-SLOUPEK");
});

// ---------------------------------------------------------------------------------------------
// Režim A — Samostatný prvek generátoru (booth_component)
// ---------------------------------------------------------------------------------------------

test("režim A: booth_component vyžaduje GLB + SKP; po aktivaci je v nabídce generátoru jen s kódem a rozměry", async () => {
  const doc = (extra: object) => ({ ...POST_DOCUMENT, ...extra }) as unknown as ComponentDefinition;
  const context = { itemType: "INTERNAL_COMPONENT" as const };
  assert.deepEqual([...evaluateCatalogReadiness(withCode(doc({})), "booth_component", context).issues].sort(), ["missing_3d_asset", "missing_sketchup_source"]);
  assert.equal(evaluateCatalogReadiness(withCode(doc({ ...GLB, ...SKP })), "booth_component", context).ready, true);
  const items = await asAdmin([
    internalRow({ id: "a", kind: "booth_component", lifecycle_status: "active", document: { ...POST_DOCUMENT, ...GLB, ...SKP } }),
    internalRow({ id: "b", internal_code: "INT-B", kind: "booth_component", lifecycle_status: "active", document: { ...POST_DOCUMENT, ...GLB, ...SKP, widthMm: undefined } }),
    internalRow({ id: "c", internal_code: "INT-C", kind: "construction", lifecycle_status: "active", document: { ...POST_DOCUMENT, reviewedAt: "2026-11-02" } }),
  ]);
  assert.deepEqual(selectGeneratorBoothComponents(items).map((item) => item.id), ["a"], "bez rozměrů ne; konstrukční díl se samostatně nenabízí");
});

function withCode(document: ComponentDefinition): ComponentDefinition {
  return { ...document, internalCode: "INT-SLOUPEK" };
}

// ---------------------------------------------------------------------------------------------
// Režim B — Konstrukční díl / součást kompletu (construction)
// ---------------------------------------------------------------------------------------------

test("režim B: construction se aktivuje bez GLB/SKP (jen kód + schválení); zapnuté 3D bez modelu stále vyžaduje GLB", () => {
  const context = { itemType: "INTERNAL_COMPONENT" as const };
  const base = withCode({ ...POST_DOCUMENT, showIn3D: false } as unknown as ComponentDefinition);
  assert.deepEqual(evaluateCatalogReadiness(base, "construction", context).issues, ["requires_review"]);
  assert.equal(evaluateCatalogReadiness({ ...base, reviewedAt: "2026-11-02" }, "construction", context).ready, true);
  assert.ok(evaluateCatalogReadiness({ ...base, reviewedAt: "2026-11-02", showIn3D: true }, "construction", context).issues.includes("missing_3d_asset"));
  assert.equal(base.widthMm, 40, "strukturované rozměry zůstávají");
  assert.deepEqual(base.footprint2D, { shape: "rectangle" }, "2D reprezentace zůstává");
});

test("režim B v kompletu: řádek „V ceně“ se neúčtuje podruhé; nepovinný řádek bez ceny = „missing“ + komplet k nabídce, nikdy 0 Kč", () => {
  const line = (included: boolean): CatalogPackageItem => ({ id: "l", packageItemId: "p86", lineKey: "post", lineKind: "item", childItemId: "post-uuid", quantity: 4, unitCode: "ks", includedInPackage: included, sortOrder: 1, note: null });
  const included = priceKit({ kitPriceNet: 12000, lines: [line(true)], resolver: { unitPrice: () => undefined } });
  assert.equal(included.lines[0]!.status, "included");
  assert.equal(included.totalNet, 12000);
  assert.equal(included.lines[0]!.quantity, 4);
  const optional = priceKit({ kitPriceNet: 12000, lines: [line(false)], resolver: { unitPrice: () => undefined } });
  assert.equal(optional.lines[0]!.status, "missing");
  assert.equal(optional.needsQuote, true);
  const priced = priceKit({ kitPriceNet: 12000, lines: [line(false)], resolver: { unitPrice: () => ({ priceMode: "fixed", salePrice: 80 }) } });
  assert.equal(priced.totalNet, 12320, "samostatně oceňovaný sloupek podle platné ceny");
});

// ---------------------------------------------------------------------------------------------
// Klasifikace a dostupnost režimů
// ---------------------------------------------------------------------------------------------

test("režimy podle kategorie: interní kategorie nabízejí oba režimy, jiné druhy žádný", () => {
  for (const id of ["Sloupky", "Panely / stěny", "Límce", "Dveře", "Zázemí / konstrukce", "internal-other"]) {
    assert.deepEqual(usagesForCategory(findCategory(BUILT_IN_CATALOG_CATEGORIES, id)), ["booth_component", "construction"], id);
  }
  assert.deepEqual(usagesForCategory(findCategory(BUILT_IN_CATALOG_CATEGORIES, "graphics-fascia")), []);
  assert.deepEqual(usagesForCategory({ group: "internal_component", kinds: ["construction"] }), ["construction"], "jediný povolený druh = žádná neplatná volba");
});

test("klasifikace přes API: Interní komponenta → Sloupky s booth_component i construction platí; nepovolené kombinace odmítnuty", () => {
  const issue = (kind: string, category: string, itemType = "INTERNAL_COMPONENT") => classificationIssue(BUILT_IN_CATALOG_CATEGORIES, { itemType: itemType as never, kind: kind as never, category });
  assert.equal(issue("booth_component", "Sloupky"), undefined);
  assert.equal(issue("construction", "Sloupky"), undefined);
  assert.ok(issue("other", "Sloupky"), "Sloupky nepovolují druh other");
  assert.ok(issue("construction", "chairs"), "kategorie produktu");
  assert.ok(issue("furniture", "Sloupky", "PRODUCT"), "Produkt nesmí do kategorie Sloupky");
});

// ---------------------------------------------------------------------------------------------
// Změna režimu u existující karty
// ---------------------------------------------------------------------------------------------

test("změna režimu: rozpracovaná karta booth_component → construction projde, soubory zůstanou", async () => {
  const client = fakeClient({ catalog_items: [internalRow({ kind: "booth_component", document: { ...POST_DOCUMENT, ...GLB, ...SKP } })], projects: [] });
  const saved = await saveCatalogItemAdmin(client as never, "post-uuid", { kind: "construction" }, null);
  assert.equal(saved.kind, "construction");
  assert.deepEqual((saved.document as FakeRow).modelAsset, GLB.modelAsset, "GLB se nemaže");
  assert.deepEqual((saved.document as FakeRow).sourceAssets, SKP.sourceAssets, "SKP se nemaže");
});

test("změna režimu: aktivní komponentu ani komponentu použitou v projektu nelze přepnout", async () => {
  const active = fakeClient({ catalog_items: [internalRow({ kind: "booth_component", lifecycle_status: "active", document: { ...POST_DOCUMENT, ...GLB, ...SKP } })], projects: [] });
  await assert.rejects(() => saveCatalogItemAdmin(active as never, "post-uuid", { kind: "construction" }, null), InvalidCatalogItemAdminEditError);
  const used = fakeClient({
    catalog_items: [internalRow({ kind: "booth_component", document: { ...POST_DOCUMENT, ...GLB, ...SKP } })],
    projects: [{ id: "project-1", document: { name: "Veletrh 2026", components: [{ definitionId: "post-uuid" }] } }],
  });
  await assert.rejects(() => saveCatalogItemAdmin(used as never, "post-uuid", { kind: "construction" }, null), /Veletrh 2026/u);
  assert.equal(boothComponentUsageChangeIssue([]), undefined);
  assert.match(usageChangeWarningCs("booth_component", "construction")!, /zůstanou zachované/u);
  assert.match(usageChangeWarningCs("construction", "booth_component")!, /GLB a zdrojový SKP/u);
});

test("regrese: M57 (legacy) a ostatní druhy se novým pravidlem kódu nemění", async () => {
  const [m57] = await asAdmin([{ id: "m57", internal_code: "M57", abf_code: "M57", item_type: "PRODUCT", kind: "furniture", lifecycle_status: "active", display_name: "Židle", category: "chairs", unit: "ks", document: { displayName: "Židle", name: "Židle", category: "chairs" } }]);
  assert.ok(!computeReadiness(m57!).issues.includes("missing_internal_code"));
  const service = { displayName: "Elektřina 2 kW", name: "Elektřina 2 kW", category: "service-electricity", unit: "ks" } as unknown as ComponentDefinition;
  assert.equal(evaluateCatalogReadiness(service, "service", { itemType: "SERVICE" }).ready, true, "L02 bez interního kódu v dokumentu zůstává připravená");
  const graphics = { displayName: "Límec", name: "Límec", category: "graphics-fascia", unit: "bm" } as unknown as ComponentDefinition;
  assert.equal(evaluateCatalogReadiness(graphics, "graphics_service", { itemType: "SERVICE" }).ready, true);
});
