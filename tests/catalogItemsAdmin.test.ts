import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server.js";
import {
  applyCatalogItemEdit,
  buildCatalogItemListEntry,
  CatalogItemAdminNotFoundError,
  computeGeneratorEligibleLive,
  computeReadiness,
  documentBasePricing,
  documentDimensions,
  documentHas3DAsset,
  filterCatalogItemsAdmin,
  matchesCatalogItemAdminSearch,
  parseCatalogItemAdminEdit,
  type CatalogItemAdmin,
} from "../domain/catalogItemsAdmin.ts";
import { CatalogReadinessError } from "../domain/catalogReadiness.ts";
import {
  readCatalogItemsAdmin,
  saveCatalogItemAdmin,
} from "../lib/db/catalogItemsAdmin.supabase.ts";
import { ConcurrencyConflictError } from "../lib/db/concurrency.ts";
import { handleCatalogAdminItemsList } from "../app/api/catalog-admin/items/route.ts";
import { handleCatalogAdminItemsSave } from "../app/api/catalog-admin/items/save/route.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import { SupabaseConfigurationError } from "../lib/db/supabase.server.ts";

const SECRET = "catalog-admin-test-session-secret-32chars";
const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.APP_SESSION_SECRET = SECRET;

function authenticatedRequest(token: string | undefined, url: string, init: Readonly<{ method?: string; body?: unknown }> = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `homeworkstudio_session=${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest(url, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}

// ---------------------------------------------------------------------------------------
// Fake in-memory Supabase client — mirrors tests/pricingAdmin.test.ts's own builder.
// ---------------------------------------------------------------------------------------
type FakeRow = Record<string, unknown>;

function createFakeSupabaseClient(seed: Readonly<Record<string, readonly FakeRow[]>> = {}) {
  const tables = new Map<string, FakeRow[]>(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));

  function getTable(name: string): FakeRow[] {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }

  function from(tableName: string) {
    type Op = "select" | "update";
    let op: Op = "select";
    let filters: Array<[string, unknown]> = [];
    let payload: FakeRow | undefined;
    let singleMode: "none" | "maybeSingle" | "single" = "none";

    function matches(row: FakeRow): boolean {
      return filters.every(([column, value]) => row[column] === value);
    }

    const builder = {
      select(_columns?: string) { return builder; },
      update(patch: FakeRow) { op = "update"; payload = patch; return builder; },
      eq(column: string, value: unknown) { filters = [...filters, [column, value]]; return builder; },
      maybeSingle() { singleMode = "maybeSingle"; return execute(); },
      single() { singleMode = "single"; return execute(); },
      then(onFulfilled: (value: { data: unknown; error: unknown }) => unknown, onRejected?: (reason: unknown) => unknown) {
        return execute().then(onFulfilled, onRejected);
      },
    };

    async function execute(): Promise<{ data: unknown; error: unknown }> {
      const rows = getTable(tableName);
      if (op === "select") {
        const matched = rows.filter(matches);
        if (singleMode === "maybeSingle") return { data: matched[0] ?? null, error: null };
        return { data: matched, error: null };
      }
      if (op === "update") {
        const matched = rows.filter(matches);
        for (const row of matched) Object.assign(row, payload);
        return { data: matched, error: null };
      }
      return { data: null, error: null };
    }

    return builder;
  }

  return { from, tables };
}

// ---------------------------------------------------------------------------------------
// Fixtures — mirror the REAL shapes now living in remote catalog_items after Batch #2A/#2B.
// ---------------------------------------------------------------------------------------

const P86_DOCUMENT: FakeRow = {
  id: "koje-2x2",
  code: "P86",
  name: "Kóje 2 × 2 m",
  widthMm: 2000,
  depthMm: 2000,
  heightMm: 2500,
  category: "typova-koje",
  modelUrl: "/models/booths/koje-2x2/master.glb",
  defaultCarpetFinishId: "carpet-grey",
  parts: [
    { id: "p86-carpet-grey", kind: "floor-finish", name: "Šedý koberec", unit: "m²", quantity: 4, includedInBasePrice: true, finishId: "carpet-grey" },
    { id: "p86-construction", kind: "construction", name: "Stavba stánku", unit: "m²", quantity: 2, includedInBasePrice: true },
    { id: "p86-fascia-print", kind: "print-allowance", name: "Grafika na límec", unit: "bm", quantity: 2, printSurfaceId: "fascia-print", includedInBasePrice: true },
  ],
  printSurfaces: [{ id: "fascia-print", name: "Límec", widthMm: 2000, heightMm: 300, active: true }],
  pricingEntries: [{ id: "p86-base-czk", itemId: "koje-2x2", currency: "CZK", salePrice: 3640 }],
};

function p86Row(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "p86-uuid",
    internal_code: "P86",
    kind: "booth",
    lifecycle_status: "active",
    display_name: "Kóje 2 × 2 m (P86)",
    official_name: null,
    category: "Canonical",
    unit: "ks",
    document: P86_DOCUMENT,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-14T19:16:38.367959+00:00",
    ...overrides,
  };
}

// M57 — already active, but deliberately missing reviewedAt (readiness NOT satisfied) to prove
// that re-saving an already-active item never re-triggers the activation guard.
const M57_DOCUMENT: FakeRow = {
  id: "technical-service-stub-m57",
  internalCode: "M57",
  displayName: "Židle kovová čalouněná",
  name: "Židle kovová čalouněná",
  type: "furniture",
  category: "Nábytek",
  widthMm: 450,
  depthMm: 450,
  heightMm: 900,
  unit: "ks",
  sourceSystem: "excel-v6.6",
  sourceKey: "pricelist::nabytek::zidle-calounena",
  lifecycleStatus: "active",
  catalogItemKind: "furniture",
};

function m57Row(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "m57-uuid",
    internal_code: "M57",
    kind: "furniture",
    lifecycle_status: "active",
    display_name: "Židle kovová čalouněná",
    official_name: null,
    category: "Nábytek",
    unit: "ks",
    document: M57_DOCUMENT,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-14T19:16:38.000000+00:00",
    ...overrides,
  };
}

// A Batch #2B needs_review stub — missing dimensions AND missing 3D asset, exactly like the
// real 56 imported items.
const STUB_DOCUMENT: FakeRow = {
  id: "batch2b-F01",
  internalCode: "F01",
  displayName: "Testovací nábytek 1",
  name: "Testovací nábytek 1",
  type: "furniture",
  category: "Nábytek",
  widthMm: 0,
  depthMm: 0,
  unit: "ks",
  sourceSystem: "excel-v6.6",
  sourceKey: "pricelist::nabytek::testovaci-nabytek-1",
  lifecycleStatus: "needs_review",
  catalogItemKind: "furniture",
  pricingEntries: [{ id: "batch2b-F01-base-czk", itemId: "batch2b-F01", currency: "CZK", salePrice: 1200 }],
};

function stubRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "f01-uuid",
    internal_code: "F01",
    kind: "furniture",
    lifecycle_status: "needs_review",
    display_name: "Testovací nábytek 1",
    official_name: null,
    category: "Nábytek",
    unit: "ks",
    document: STUB_DOCUMENT,
    created_at: "2026-08-14T19:16:38.000000+00:00",
    updated_at: "2026-08-14T19:16:38.000000+00:00",
    ...overrides,
  };
}

function toAdmin(row: FakeRow): CatalogItemAdmin {
  return {
    id: row.id as string,
    internalCode: row.internal_code as string | null,
    kind: row.kind as CatalogItemAdmin["kind"],
    lifecycleStatus: row.lifecycle_status as CatalogItemAdmin["lifecycleStatus"],
    displayName: row.display_name as string,
    officialName: row.official_name as string | null,
    category: row.category as string | null,
    unit: row.unit as string | null,
    document: row.document as FakeRow,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// -----------------------------------------------------------------------------------------
// DETAIL — P86 opens with canonical nested metadata intact
// -----------------------------------------------------------------------------------------

test("P86 detail: dimensions 2000x2000x2500, 3D model present, readiness ready, generatorEligible=true", () => {
  const item = toAdmin(p86Row());
  const dims = documentDimensions(item.document);
  assert.deepEqual(dims, { widthMm: 2000, depthMm: 2000, heightMm: 2500, hasDimensions: true });
  assert.equal(documentHas3DAsset(item.document), true);
  const readiness = computeReadiness(item);
  assert.equal(readiness.ready, true);
  assert.equal(computeGeneratorEligibleLive(item), true);
});

test("P86 detail: base pricing CZK visible, EUR not set never shown as 0", () => {
  const item = toAdmin(p86Row());
  const pricing = documentBasePricing(item.document);
  assert.equal(pricing.czk, 3640);
  assert.equal(pricing.eur, null);
});

// -----------------------------------------------------------------------------------------
// DETAIL — M57 / L02 open correctly (M57 stands in for both; L02 is structurally identical)
// -----------------------------------------------------------------------------------------

test("M57 detail: opens with real DB identity, active, furniture kind", () => {
  const item = toAdmin(m57Row());
  const entry = buildCatalogItemListEntry(item);
  assert.equal(entry.internalCode, "M57");
  assert.equal(entry.lifecycleStatus, "active");
  assert.equal(entry.kind, "furniture");
});

// -----------------------------------------------------------------------------------------
// DETAIL — Batch #2B stub opens correctly; missing dimensions/model shown as missing, never invented
// -----------------------------------------------------------------------------------------

test("Batch #2B stub detail: missing dimensions shown as missing (null), missing 3D shown as missing, needs_review, generatorEligible=false", () => {
  const item = toAdmin(stubRow());
  const dims = documentDimensions(item.document);
  assert.deepEqual(dims, { widthMm: null, depthMm: null, heightMm: null, hasDimensions: false });
  assert.equal(documentHas3DAsset(item.document), false);
  assert.equal(item.lifecycleStatus, "needs_review");
  assert.equal(computeGeneratorEligibleLive(item), false);
});

test("generatorEligible is NEVER trusted from a stored field — a bogus document.generatorEligible=true is ignored by the live computation", () => {
  const item = toAdmin(stubRow({ document: { ...STUB_DOCUMENT, generatorEligible: true } }));
  assert.equal(computeGeneratorEligibleLive(item), false, "needs_review + missing dims/asset must stay ineligible regardless of any stray stored flag");
});

test("ordinary needs_review item stays generator-ineligible even once dimensions are filled in but 3D model is still missing", () => {
  const item = toAdmin(stubRow({ document: { ...STUB_DOCUMENT, widthMm: 600, depthMm: 600 } }));
  const readiness = computeReadiness(item);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("missing_3d_asset") || readiness.issues.includes("missing_scene_capability"));
  assert.equal(computeGeneratorEligibleLive(item), false);
});

// -----------------------------------------------------------------------------------------
// LIST ENTRY / FILTERS (section 5)
// -----------------------------------------------------------------------------------------

test("buildCatalogItemListEntry: 81 items can be represented uniformly regardless of BoothType vs ComponentDefinition document shape", () => {
  const entries = [toAdmin(p86Row()), toAdmin(m57Row()), toAdmin(stubRow())].map(buildCatalogItemListEntry);
  assert.equal(entries.length, 3);
  assert.ok(entries.every((entry) => typeof entry.displayName === "string"));
});

test("needs_review items are visible in the admin list (never filtered away by default)", () => {
  const entries = [toAdmin(p86Row()), toAdmin(stubRow())].map(buildCatalogItemListEntry);
  const filtered = filterCatalogItemsAdmin(entries, {});
  assert.equal(filtered.length, 2);
  assert.ok(filtered.some((entry) => entry.lifecycleStatus === "needs_review"));
});

test("filter: internalCode/search matches F01", () => {
  const entry = buildCatalogItemListEntry(toAdmin(stubRow()));
  assert.equal(matchesCatalogItemAdminSearch(entry, "F01"), true);
  assert.equal(matchesCatalogItemAdminSearch(entry, "P86"), false);
});

test("filter: kind narrows to furniture only", () => {
  const entries = [toAdmin(p86Row()), toAdmin(m57Row()), toAdmin(stubRow())].map(buildCatalogItemListEntry);
  const filtered = filterCatalogItemsAdmin(entries, { kind: "furniture" });
  assert.equal(filtered.length, 2);
  assert.ok(filtered.every((entry) => entry.kind === "furniture"));
});

test("filter: lifecycleStatus narrows to needs_review only ('K doplnění')", () => {
  const entries = [toAdmin(p86Row()), toAdmin(m57Row()), toAdmin(stubRow())].map(buildCatalogItemListEntry);
  const filtered = filterCatalogItemsAdmin(entries, { lifecycleStatus: "needs_review" });
  assert.deepEqual(filtered.map((entry) => entry.internalCode), ["F01"]);
});

test("filter: readiness ready/not-ready split matches P86 vs the needs_review stub", () => {
  const entries = [toAdmin(p86Row()), toAdmin(stubRow())].map(buildCatalogItemListEntry);
  assert.deepEqual(filterCatalogItemsAdmin(entries, { readiness: "ready" }).map((e) => e.internalCode), ["P86"]);
  assert.deepEqual(filterCatalogItemsAdmin(entries, { readiness: "not-ready" }).map((e) => e.internalCode), ["F01"]);
});

test("filter: asset has-3d/missing-3d split matches P86 vs the needs_review stub", () => {
  const entries = [toAdmin(p86Row()), toAdmin(stubRow())].map(buildCatalogItemListEntry);
  assert.deepEqual(filterCatalogItemsAdmin(entries, { asset: "has-3d" }).map((e) => e.internalCode), ["P86"]);
  assert.deepEqual(filterCatalogItemsAdmin(entries, { asset: "missing-3d" }).map((e) => e.internalCode), ["F01"]);
});

// -----------------------------------------------------------------------------------------
// EDIT / SAVE (sections 8, 9, 12) — pure merge + whitelist
// -----------------------------------------------------------------------------------------

test("parseCatalogItemAdminEdit: only whitelisted fields survive; internalCode/sourceSystem/sourceKey/document/unknown keys are dropped", () => {
  const edit = parseCatalogItemAdminEdit({
    displayName: "Nový název",
    internalCode: "HACKED",
    sourceSystem: "evil",
    sourceKey: "evil-key",
    document: { evil: true },
    unrelatedField: 123,
    lifecycleStatus: "active",
  });
  assert.deepEqual(edit, { displayName: "Nový název", lifecycleStatus: "active" });
});

test("parseCatalogItemAdminEdit: rejects an invalid lifecycleStatus string instead of accepting an invented value", () => {
  const edit = parseCatalogItemAdminEdit({ lifecycleStatus: "super-active" });
  assert.equal(edit.lifecycleStatus, undefined);
});

test("applyCatalogItemEdit: editing name on P86 preserves parts/printSurfaces/pricingEntries/defaultCarpetFinishId untouched (P86 sanity, section 12)", () => {
  const merged = applyCatalogItemEdit(P86_DOCUMENT, { name: "Kóje 2 × 2 m (upraveno)" });
  assert.equal(merged.name, "Kóje 2 × 2 m (upraveno)");
  assert.deepEqual(merged.parts, P86_DOCUMENT.parts);
  assert.deepEqual(merged.printSurfaces, P86_DOCUMENT.printSurfaces);
  assert.deepEqual(merged.pricingEntries, P86_DOCUMENT.pricingEntries);
  assert.equal(merged.defaultCarpetFinishId, "carpet-grey");
  assert.equal(merged.modelUrl, P86_DOCUMENT.modelUrl);
  assert.equal(merged.widthMm, 2000);
});

test("applyCatalogItemEdit: sourceKey/sourceSystem/internalCode are never overwritten because they are structurally absent from the edit type", () => {
  const merged = applyCatalogItemEdit(STUB_DOCUMENT, { displayName: "Nový název" });
  assert.equal(merged.sourceSystem, "excel-v6.6");
  assert.equal(merged.sourceKey, "pricelist::nabytek::testovaci-nabytek-1");
  assert.equal(merged.internalCode, "F01");
});

test("applyCatalogItemEdit: never invents a fake GLB path when editing unrelated fields", () => {
  const merged = applyCatalogItemEdit(STUB_DOCUMENT, { unit: "sada" });
  assert.equal(merged.modelUrl, undefined);
});

// -----------------------------------------------------------------------------------------
// SUPABASE REPO — readCatalogItemsAdmin / saveCatalogItemAdmin
// -----------------------------------------------------------------------------------------

test("readCatalogItemsAdmin: maps all rows, including full document (source traceability included, unlike the customer-safe summary)", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [p86Row(), m57Row(), stubRow()] });
  const items = await readCatalogItemsAdmin(client as never);
  assert.equal(items.length, 3);
  const stub = items.find((item) => item.internalCode === "F01")!;
  assert.equal((stub.document as FakeRow).sourceSystem, "excel-v6.6");
});

test("saveCatalogItemAdmin: edit displayName persists to both the document and the indexed display_name column", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { displayName: "Testovací nábytek (opraveno)" }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(saved.displayName, "Testovací nábytek (opraveno)");
  assert.equal((saved.document as FakeRow).displayName, "Testovací nábytek (opraveno)");
});

test("saveCatalogItemAdmin: edit dimensions persists and hasDimensions flips true", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { widthMm: 600, depthMm: 400 }, "2026-08-14T19:16:38.000000+00:00");
  const dims = documentDimensions(saved.document);
  assert.deepEqual(dims, { widthMm: 600, depthMm: 400, heightMm: null, hasDimensions: true });
});

test("saveCatalogItemAdmin: P86 parts/printSurfaces survive a routine metadata save untouched (never a small-form overwrite)", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [p86Row()] });
  const saved = await saveCatalogItemAdmin(client as never, "p86-uuid", { category: "typova-koje-2x2" }, "2026-08-14T19:16:38.367959+00:00");
  assert.deepEqual(saved.document.parts, P86_DOCUMENT.parts);
  assert.deepEqual(saved.document.printSurfaces, P86_DOCUMENT.printSurfaces);
  assert.equal(saved.document.defaultCarpetFinishId, "carpet-grey");
});

test("saveCatalogItemAdmin: sourceKey/internalCode preserved through a save — no edit path can ever touch them", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { displayName: "X" }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(saved.internalCode, "F01");
  assert.equal(saved.document.sourceKey, "pricelist::nabytek::testovaci-nabytek-1");
});

test("saveCatalogItemAdmin: duplicate internalCode can never be accidentally created — internal_code column is never part of the update patch", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow(), m57Row()] });
  await saveCatalogItemAdmin(client as never, "f01-uuid", { displayName: "X" }, "2026-08-14T19:16:38.000000+00:00");
  const row = client.tables.get("catalog_items")!.find((r) => r.id === "f01-uuid")!;
  assert.equal(row.internal_code, "F01", "internal_code column must be untouched by any admin save");
});

test("saveCatalogItemAdmin: not found throws CatalogItemAdminNotFoundError", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [] });
  await assert.rejects(() => saveCatalogItemAdmin(client as never, "missing-id", { displayName: "X" }, null), (error) => error instanceof CatalogItemAdminNotFoundError);
});

test("saveCatalogItemAdmin: stale expectedUpdatedAt throws ConcurrencyConflictError, no write happens", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  await assert.rejects(
    () => saveCatalogItemAdmin(client as never, "f01-uuid", { displayName: "X" }, "2020-01-01T00:00:00.000000+00:00"),
    (error) => error instanceof ConcurrencyConflictError,
  );
  const row = client.tables.get("catalog_items")!.find((r) => r.id === "f01-uuid")!;
  assert.equal(row.display_name, "Testovací nábytek 1", "stale write must never apply");
});

test("saveCatalogItemAdmin: expectedUpdatedAt=null skips the concurrency check", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { displayName: "X" }, null);
  assert.equal(saved.displayName, "X");
});

// -----------------------------------------------------------------------------------------
// READINESS / ACTIVATION (section 11) — activation cannot silently bypass readiness
// -----------------------------------------------------------------------------------------

test("saveCatalogItemAdmin: activating a needs_review item that fails readiness throws CatalogReadinessError, DB stays needs_review", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  await assert.rejects(
    () => saveCatalogItemAdmin(client as never, "f01-uuid", { lifecycleStatus: "active" }, "2026-08-14T19:16:38.000000+00:00"),
    (error) => error instanceof CatalogReadinessError,
  );
  const row = client.tables.get("catalog_items")!.find((r) => r.id === "f01-uuid")!;
  assert.equal(row.lifecycle_status, "needs_review", "blocked activation must never partially apply");
});

test("saveCatalogItemAdmin: activating a fully-ready item succeeds", async () => {
  const readyDocument = { ...STUB_DOCUMENT, widthMm: 600, depthMm: 400, showIn2D: true, footprint2D: { shape: "rectangle" }, reviewedAt: "2026-08-14T00:00:00.000Z" };
  const client = createFakeSupabaseClient({ catalog_items: [stubRow({ document: readyDocument })] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { lifecycleStatus: "active" }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(saved.lifecycleStatus, "active");
});

test("saveCatalogItemAdmin: re-saving an ALREADY active item (M57) with an unrelated edit never re-triggers the activation guard, even though M57's own readiness would fail today", async () => {
  const readiness = computeReadiness(toAdmin(m57Row()));
  assert.equal(readiness.ready, false, "fixture is deliberately readiness-non-compliant (missing reviewedAt) to prove the guard doesn't fire on routine edits");
  const client = createFakeSupabaseClient({ catalog_items: [m57Row()] });
  const saved = await saveCatalogItemAdmin(client as never, "m57-uuid", { displayName: "Židle kovová čalouněná (typo fix)" }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(saved.displayName, "Židle kovová čalouněná (typo fix)");
  assert.equal(saved.lifecycleStatus, "active");
});

test("P86 = canonical ready item = eligible; ordinary needs_review stays ineligible", () => {
  assert.equal(computeGeneratorEligibleLive(toAdmin(p86Row())), true);
  assert.equal(computeGeneratorEligibleLive(toAdmin(stubRow())), false);
});

// -----------------------------------------------------------------------------------------
// API ROUTES — security (section 19) + behavior
// -----------------------------------------------------------------------------------------

test("GET /api/catalog-admin/items: unauthenticated -> 401", async () => {
  const response = await handleCatalogAdminItemsList(authenticatedRequest(undefined, "http://localhost/api/catalog-admin/items"), async () => []);
  assert.equal(response.status, 401);
});

test("GET /api/catalog-admin/items: authenticated -> 200 with catalogItems", async () => {
  const token = await createSessionToken(SECRET);
  const items = [toAdmin(p86Row())];
  const response = await handleCatalogAdminItemsList(authenticatedRequest(token, "http://localhost/api/catalog-admin/items"), async () => items);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { catalogItems: unknown[] };
  assert.equal(body.catalogItems.length, 1);
});

test("GET /api/catalog-admin/items: missing Supabase config -> 503", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsList(authenticatedRequest(token, "http://localhost/api/catalog-admin/items"), async () => {
    throw new SupabaseConfigurationError(["SUPABASE_URL"]);
  });
  assert.equal(response.status, 503);
});

test("GET /api/catalog-admin/items: generic DB error -> 502", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsList(authenticatedRequest(token, "http://localhost/api/catalog-admin/items"), async () => {
    throw new Error("connection reset");
  });
  assert.equal(response.status, 502);
});

test("POST /api/catalog-admin/items/save: unauthenticated -> 401", async () => {
  const response = await handleCatalogAdminItemsSave(authenticatedRequest(undefined, "http://localhost/api/catalog-admin/items/save", { method: "POST", body: { id: "x", edit: {} } }));
  assert.equal(response.status, 401);
});

test("POST /api/catalog-admin/items/save: missing id -> 400", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsSave(authenticatedRequest(token, "http://localhost/api/catalog-admin/items/save", { method: "POST", body: { edit: {} } }));
  assert.equal(response.status, 400);
});

test("POST /api/catalog-admin/items/save: concurrency conflict -> 409", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsSave(
    authenticatedRequest(token, "http://localhost/api/catalog-admin/items/save", { method: "POST", body: { id: "f01-uuid", edit: { displayName: "X" }, expectedUpdatedAt: "stale" } }),
    async () => { throw new ConcurrencyConflictError("catalog_item", "f01-uuid"); },
  );
  assert.equal(response.status, 409);
});

test("POST /api/catalog-admin/items/save: blocked activation (readiness) -> 400 with issues", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsSave(
    authenticatedRequest(token, "http://localhost/api/catalog-admin/items/save", { method: "POST", body: { id: "f01-uuid", edit: { lifecycleStatus: "active" } } }),
    async () => { throw new CatalogReadinessError(["missing_dimensions", "missing_3d_asset"]); },
  );
  assert.equal(response.status, 400);
  const body = (await response.json()) as { issues?: string[] };
  assert.deepEqual(body.issues, ["missing_dimensions", "missing_3d_asset"]);
});

test("POST /api/catalog-admin/items/save: not found -> 404", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsSave(
    authenticatedRequest(token, "http://localhost/api/catalog-admin/items/save", { method: "POST", body: { id: "missing", edit: {} } }),
    async () => { throw new CatalogItemAdminNotFoundError("missing"); },
  );
  assert.equal(response.status, 404);
});

test("POST /api/catalog-admin/items/save: missing Supabase config -> 503", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsSave(
    authenticatedRequest(token, "http://localhost/api/catalog-admin/items/save", { method: "POST", body: { id: "f01-uuid", edit: {} } }),
    async () => { throw new SupabaseConfigurationError(["SUPABASE_SECRET_KEY"]); },
  );
  assert.equal(response.status, 503);
});

test("POST /api/catalog-admin/items/save: generic DB error -> 502", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsSave(
    authenticatedRequest(token, "http://localhost/api/catalog-admin/items/save", { method: "POST", body: { id: "f01-uuid", edit: {} } }),
    async () => { throw new Error("network error"); },
  );
  assert.equal(response.status, 502);
});

test("POST /api/catalog-admin/items/save: request body cannot smuggle internalCode/sourceSystem/document into the saved edit", async () => {
  const token = await createSessionToken(SECRET);
  let capturedEdit: unknown;
  await handleCatalogAdminItemsSave(
    authenticatedRequest(token, "http://localhost/api/catalog-admin/items/save", {
      method: "POST",
      body: { id: "f01-uuid", edit: { displayName: "X", internalCode: "HACK", sourceSystem: "evil", document: { evil: true } } },
    }),
    async (id, edit) => {
      capturedEdit = edit;
      return toAdmin(stubRow());
    },
  );
  assert.deepEqual(capturedEdit, { displayName: "X" });
});

// -----------------------------------------------------------------------------------------
// GENERATOR UNTOUCHED (section 18) — structural guard
// -----------------------------------------------------------------------------------------

test("ComponentLibrary.tsx (generator) is untouched by this admin switch — still static data/components.ts, no catalog-admin import", () => {
  const source = readFileSync(new URL("../components/configurator/ComponentLibrary.tsx", import.meta.url), "utf8");
  assert.match(source, /from ["']\.\.\/\.\.\/data\/components["']/u);
  assert.doesNotMatch(source, /catalogItemsAdmin|catalog-admin/u);
});

test("BoothGenerator.tsx: the 'components' admin section now renders ComponentAdminPage (DB-backed), not the old static ComponentCatalogPage", () => {
  const source = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  assert.match(source, /workspaceSection === "components"[\s\S]{0,120}<ComponentAdminPage/u);
  assert.doesNotMatch(source, /<ComponentCatalogPage/u);
});

test("ComponentAdminPage.tsx never imports R2/asset-upload modules (section 15 — no functional upload button this session)", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /uploadAsset|assetClient|@aws-sdk/u);
});

// -----------------------------------------------------------------------------------------
// UI shape (source-scan, matching this repo's established pattern — see
// tests/pricingAdmin.test.ts's UI section) — required list columns, filters, detail sections,
// and the "Upravit ceny" hand-off to the EXISTING Pricing Administration (never a duplicate).
// -----------------------------------------------------------------------------------------

test("UI: list view shows the required columns (section 4)", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  for (const label of ["Interní kód", "Název", "Kategorie / Kind", "Stav", "Rozměry", "3D", "Cena", "Generator"]) {
    assert.match(source, new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `missing list column "${label}"`);
  }
});

test("UI: filters cover search/kind/lifecycle/readiness/asset (section 5)", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /Hledat interní kód/u);
  assert.match(source, /Kategorie: vše/u);
  assert.match(source, /Stav: vše/u);
  assert.match(source, /Readiness: vše/u);
  assert.match(source, /Asset: vše/u);
});

test("UI: detail sections match Identita/Rozměry/Lifecycle/Assety/Ceny (section 6)", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  for (const heading of ["Identita", "Rozměry", "Lifecycle", "Assety", "Ceny"]) {
    assert.match(source, new RegExp(`<h3>${heading}</h3>`), `missing detail section "${heading}"`);
  }
});

test("UI: internalCode is rendered read-only (span), never as an editable input (section 7)", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /Interní kód"><span className="readOnlyField">\{item\.internalCode/u);
});

test("UI: 'Upravit ceny' hands off to the existing Pricing Administration via onOpenPricing — no second price editor is defined in this file", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /Upravit ceny/u);
  assert.match(source, /onClick=\{onOpenPricing\}/u);
  assert.doesNotMatch(source, /PricingMatrix/u);
});

test("UI: 'Aktivovat' is disabled when readiness.ready is false — never a parallel readiness rule", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /disabled=\{!readiness\.ready/u);
  assert.match(source, /computeReadiness\(item\)/u);
});

test("UI: missing base price is shown as text, never rendered as 0", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /Cena není nastavena/u);
});

test("PricingAdminPage: accepts initialCatalogItemId and opens the matrix preselected on mount", () => {
  const source = readFileSync(new URL("../components/workflow/PricingAdminPages.tsx", import.meta.url), "utf8");
  assert.match(source, /initialCatalogItemId/u);
  assert.match(source, /openMatrix\(\[initialCatalogItemId\]\)/u);
});
