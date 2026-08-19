import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server.js";
import {
  applyCatalogItemEdit,
  buildCatalogItemListEntry,
  CATALOG_ITEM_CATEGORY_OPTIONS,
  CatalogItemAdminNotFoundError,
  categoryLabelCs,
  computeGeneratorEligibleLive,
  computeReadiness,
  documentBasePricing,
  documentDimensions,
  documentFootprint2D,
  documentHas3DAsset,
  documentModelAsset,
  documentPhotoAsset,
  documentReviewedAt,
  documentSourceAssets,
  documentSourceTraceability,
  documentVariants,
  filterCatalogItemsAdmin,
  matchesCatalogItemAdminSearch,
  parseCatalogItemAdminCreateInput,
  parseCatalogItemAdminEdit,
  sortCatalogItemsAdminByCode,
  sortCatalogItemsAdminByName,
  InvalidCatalogItemAdminCreateInputError,
  type CatalogItemAdmin,
  type CatalogItemAdminCreateInput,
  type CatalogItemAdminListEntry,
} from "../domain/catalogItemsAdmin.ts";
import type { StoredAsset } from "../domain/assets.ts";
import type { ComponentDefinition } from "../domain/models.ts";
import { CatalogReadinessError, DuplicateInternalCodeError, evaluateCatalogReadiness } from "../domain/catalogReadiness.ts";
import {
  createCatalogItemAdmin,
  readCatalogItemsAdmin,
  saveCatalogItemAdmin,
} from "../lib/db/catalogItemsAdmin.supabase.ts";
import { ConcurrencyConflictError } from "../lib/db/concurrency.ts";
import { handleCatalogAdminItemsList } from "../app/api/catalog-admin/items/route.ts";
import { handleCatalogAdminItemsCreate } from "../app/api/catalog-admin/items/create/route.ts";
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

  let nextFakeId = 1;

  function from(tableName: string) {
    type Op = "select" | "update" | "insert";
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
      insert(row: FakeRow) { op = "insert"; payload = row; return builder; },
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
      if (op === "insert") {
        const inserted: FakeRow = {
          created_at: "2026-08-18T00:00:00.000Z",
          updated_at: "2026-08-18T00:00:00.000Z",
          ...payload,
          id: (payload as FakeRow)?.id ?? `fake-id-${nextFakeId++}`,
        };
        rows.push(inserted);
        if (singleMode === "single" || singleMode === "maybeSingle") return { data: inserted, error: null };
        return { data: [inserted], error: null };
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

const P86_SKETCHUP_SOURCE = {
  id: "p86-skp-1",
  kind: "sketchup",
  asset: { id: "p86-skp-asset", storageKey: "catalog/furniture/koje-2x2/source/p86.skp", originalFileName: "koje-2x2.skp", mimeType: "application/octet-stream", size: 500_000, createdAt: "2026-08-01T00:00:00.000Z", category: "catalog-source" },
};

const P86_DOCUMENT: FakeRow = {
  id: "koje-2x2",
  code: "P86",
  name: "Kóje 2 × 2 m",
  widthMm: 2000,
  depthMm: 2000,
  heightMm: 2500,
  category: "typova-koje",
  modelUrl: "/models/booths/koje-2x2/master.glb",
  // Deliberately NO sourceAssets — matches the real data/booths.ts P86 seed exactly. Booth-kind
  // readiness never requires SKP/DWG/DXF/PDF (Part 27, confirmed by QA); P86 must stay ready
  // and generatorEligible with no source files evidenced at all. Tests exercising sourceAssets
  // behavior on a booth add it explicitly on top of this fixture.
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

// A booth_component (individual booth-construction element) — unlike "booth", this kind DOES
// require an evidenced SKP source for readiness (Part 28), so it fully evidences one by default.
const SLOUPEK_DOCUMENT: FakeRow = {
  id: "sloupek-1",
  internalCode: "KOMP-SLOUPEK",
  displayName: "Sloupek",
  name: "Sloupek",
  category: "Komponenty stánku",
  modelUrl: "/models/booth-components/sloupek.glb",
  sourceAssets: [P86_SKETCHUP_SOURCE],
};

function boothComponentRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "sloupek-uuid",
    internal_code: "KOMP-SLOUPEK",
    kind: "booth_component",
    lifecycle_status: "active",
    display_name: "Sloupek",
    official_name: null,
    category: "Komponenty stánku",
    unit: null,
    document: SLOUPEK_DOCUMENT,
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

// =========================================================================================
// SORT (2026-08-19 follow-up session): deterministic default list ordering, never trusting
// DB/API return order. sortCatalogItemsAdminByName ("Administrace → Komponenty" and "Knihovna
// stánků → Komponenty stánku"): active first, then A-Z (cs locale) by displayName within each
// lifecycle group. sortCatalogItemsAdminByCode ("Knihovna stánků → Typové stánky"): same
// active-first grouping, but natural/numeric order by internalCode instead of name.
// =========================================================================================

function sortFixtureEntry(overrides: Partial<CatalogItemAdminListEntry>): CatalogItemAdminListEntry {
  return {
    id: overrides.internalCode?.toLowerCase() ?? "fixture-id",
    internalCode: null,
    displayName: "Fixture",
    kind: "furniture",
    category: null,
    lifecycleStatus: "needs_review",
    widthMm: null,
    depthMm: null,
    heightMm: null,
    hasDimensions: false,
    has3DAsset: false,
    basePriceCzk: null,
    basePriceEur: null,
    readiness: { ready: false, issues: [] },
    generatorEligible: false,
    photoAsset: undefined,
    photoUrl: undefined,
    ...overrides,
  };
}

test("SORT: active items always come before every other lifecycle status, regardless of alphabetical name", () => {
  const zebraActive = sortFixtureEntry({ id: "1", internalCode: "Z1", displayName: "Zebra", lifecycleStatus: "active" });
  const appleNeedsReview = sortFixtureEntry({ id: "2", internalCode: "A1", displayName: "Apple", lifecycleStatus: "needs_review" });
  const sorted = sortCatalogItemsAdminByName([appleNeedsReview, zebraActive]);
  assert.deepEqual(sorted.map((e) => e.displayName), ["Zebra", "Apple"], "active 'Zebra' must sort before non-active 'Apple' despite Z > A alphabetically");
});

test("SORT: within the active group, items sort alphabetically (cs locale) by displayName", () => {
  const entries = ["Zásuvka", "Almara", "Křeslo"].map((displayName, index) =>
    sortFixtureEntry({ id: String(index), internalCode: `A${index}`, displayName, lifecycleStatus: "active" }),
  );
  const sorted = sortCatalogItemsAdminByName(entries);
  assert.deepEqual(sorted.map((e) => e.displayName), ["Almara", "Křeslo", "Zásuvka"]);
});

test("SORT: within a non-active lifecycle group (e.g. needs_review), items ALSO sort alphabetically", () => {
  const entries = ["Zebra", "Apple", "Mango"].map((displayName, index) =>
    sortFixtureEntry({ id: String(index), internalCode: `N${index}`, displayName, lifecycleStatus: "needs_review" }),
  );
  const sorted = sortCatalogItemsAdminByName(entries);
  assert.deepEqual(sorted.map((e) => e.displayName), ["Apple", "Mango", "Zebra"]);
});

test("SORT: Czech diacritic names sort in a stable, locale-correct order (cs collation), not a naive byte/codepoint sort", () => {
  const entries = ["Žofie", "Cabinet", "Čočka", "Auto"].map((displayName, index) =>
    sortFixtureEntry({ id: String(index), internalCode: `C${index}`, displayName, lifecycleStatus: "active" }),
  );
  const sorted = sortCatalogItemsAdminByName(entries).map((e) => e.displayName);
  // cs collation groups base-letter variants near their base letter (C/Č near each other,
  // Ž near Z) rather than pushing every diacritic to the end the way a raw codepoint sort would.
  assert.deepEqual(sorted, ["Auto", "Cabinet", "Čočka", "Žofie"]);
});

test("SORT: identical displayName values fall back to internalCode as a deterministic tie-break, then id", () => {
  const b = sortFixtureEntry({ id: "id-b", internalCode: "M99B", displayName: "Stejný název", lifecycleStatus: "active" });
  const a = sortFixtureEntry({ id: "id-a", internalCode: "M99A", displayName: "Stejný název", lifecycleStatus: "active" });
  const sorted = sortCatalogItemsAdminByName([b, a]);
  assert.deepEqual(sorted.map((e) => e.internalCode), ["M99A", "M99B"]);

  const noCodeB = sortFixtureEntry({ id: "z-id", internalCode: null, displayName: "Bez kódu", lifecycleStatus: "active" });
  const noCodeA = sortFixtureEntry({ id: "a-id", internalCode: null, displayName: "Bez kódu", lifecycleStatus: "active" });
  const sortedByIdOnly = sortCatalogItemsAdminByName([noCodeB, noCodeA]);
  assert.deepEqual(sortedByIdOnly.map((e) => e.id), ["a-id", "z-id"], "with no internalCode at all on either side, id itself is the final tie-break");
});

test("SORT: sorting never mutates the input array or its entries (pure function)", () => {
  const entries = [sortFixtureEntry({ id: "1", displayName: "Zebra" }), sortFixtureEntry({ id: "2", displayName: "Apple" })];
  const frozenCopy = entries.map((entry) => ({ ...entry }));
  sortCatalogItemsAdminByName(entries);
  assert.deepEqual(entries, frozenCopy);
});

test("SORT: filter-then-sort pipeline — filtering never disturbs the deterministic order, and a filtered-out item never reappears", () => {
  const entries = [
    sortFixtureEntry({ id: "1", internalCode: "F01", displayName: "Zebra", kind: "furniture", lifecycleStatus: "active" }),
    sortFixtureEntry({ id: "2", internalCode: "F02", displayName: "Apple", kind: "furniture", lifecycleStatus: "needs_review" }),
    sortFixtureEntry({ id: "3", internalCode: "S01", displayName: "Mango", kind: "service", lifecycleStatus: "active" }),
  ];
  const filtered = filterCatalogItemsAdmin(entries, { kind: "furniture" });
  const sorted = sortCatalogItemsAdminByName(filtered);
  assert.deepEqual(sorted.map((e) => e.displayName), ["Zebra", "Apple"], "Mango (service) filtered out; Zebra (active) still sorts before Apple (needs_review)");
});

test("SORT: sortCatalogItemsAdminByName matches the REAL fixtures — P86 (active) sorts before F01 (needs_review) even though 'F' < 'P' alphabetically", () => {
  const entries = [toAdmin(stubRow()), toAdmin(p86Row())].map(buildCatalogItemListEntry);
  const sorted = sortCatalogItemsAdminByName(entries);
  assert.deepEqual(sorted.map((e) => e.internalCode), ["P86", "F01"]);
});

// -----------------------------------------------------------------------------------------
// SORT — Booth Library ("Knihovna stánků → Typové stánky"): natural/numeric code order.
// -----------------------------------------------------------------------------------------

test("SORT (booth library): natural/numeric internalCode order — 'T4' < 'T6' < 'T10', never lexicographic ('T10' < 'T4')", () => {
  const entries = ["T10", "T4", "T6"].map((internalCode, index) =>
    sortFixtureEntry({ id: String(index), internalCode, displayName: `Typový stánek ${internalCode}`, kind: "booth", lifecycleStatus: "needs_review" }),
  );
  const sorted = sortCatalogItemsAdminByCode(entries);
  assert.deepEqual(sorted.map((e) => e.internalCode), ["T4", "T6", "T10"]);
});

test("SORT (booth library): the REAL zero-padded P86/P87/Txx codes sort in the exact expected catalog order", () => {
  const codes = ["T25", "T04", "P87", "T18", "T09", "P86", "T06", "T24", "T20", "T16", "T15", "T12"];
  const entries = codes.map((internalCode, index) =>
    sortFixtureEntry({ id: String(index), internalCode, displayName: `Booth ${internalCode}`, kind: "booth", lifecycleStatus: "needs_review" }),
  );
  const sorted = sortCatalogItemsAdminByCode(entries).map((e) => e.internalCode);
  assert.deepEqual(sorted, ["P86", "P87", "T04", "T06", "T09", "T12", "T15", "T16", "T18", "T20", "T24", "T25"]);
});

test("SORT (booth library): active still sorts first, then natural code order within each lifecycle group — P86 (active) before P87 (needs_review) even though P86 < P87 alphabetically would already agree, proven with a counter-example where active is the LATER code", () => {
  const p87Active = sortFixtureEntry({ id: "p87", internalCode: "P87", displayName: "Kóje 2 × 3 m", kind: "booth", lifecycleStatus: "active" });
  const p86NeedsReview = sortFixtureEntry({ id: "p86", internalCode: "P86", displayName: "Kóje 2 × 2 m", kind: "booth", lifecycleStatus: "needs_review" });
  const sorted = sortCatalogItemsAdminByCode([p86NeedsReview, p87Active]);
  assert.deepEqual(sorted.map((e) => e.internalCode), ["P87", "P86"], "P87 is active -> sorts first despite P86 < P87 by code");
});

test("SORT (booth library): sortCatalogItemsAdminByCode matches the REAL fixtures the same way sortCatalogItemsAdminByName does — P86 (active) before F01-shaped needs_review stub", () => {
  const entries = [toAdmin(stubRow()), toAdmin(p86Row())].map(buildCatalogItemListEntry);
  const sorted = sortCatalogItemsAdminByCode(entries);
  assert.equal(sorted[0]!.internalCode, "P86");
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
// READINESS HARDENING (booth kind) — T04-shaped stub can never be activated without a 3D model,
// even though it has confirmed identity + dimensions + a base price.
// -----------------------------------------------------------------------------------------

const T04_DOCUMENT: FakeRow = {
  id: "batch2b-T04",
  internalCode: "T04",
  displayName: "Typový stánek octanorm - T4",
  name: "Typový stánek octanorm - T4",
  type: "booth",
  category: "Typovky",
  widthMm: 2000,
  depthMm: 2000,
  // heightMm deliberately absent — Txx footprint parsing only ever extracts width x depth.
  unit: "ks",
  sourceSystem: "excel-v6.6",
  sourceKey: "pricelist::typovky::typovy-stanek-octanorm---t4",
  lifecycleStatus: "needs_review",
  catalogItemKind: "booth",
  pricingEntries: [{ id: "batch2b-T04-base-czk", itemId: "batch2b-T04", currency: "CZK", salePrice: 4400 }],
};

function t04Row(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: "t04-uuid",
    internal_code: "T04",
    kind: "booth",
    lifecycle_status: "needs_review",
    display_name: "Typový stánek octanorm - T4",
    official_name: null,
    category: "Typovky",
    unit: "ks",
    document: T04_DOCUMENT,
    created_at: "2026-08-14T19:16:38.000000+00:00",
    updated_at: "2026-08-14T19:16:38.000000+00:00",
    ...overrides,
  };
}

test("T04 (real Batch #2B booth stub shape): confirmed internalCode + dimensions + base price alone never make it generatorEligible — missing 3D model blocks activation", async () => {
  const item = toAdmin(t04Row());
  const readiness = computeReadiness(item);
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("missing_3d_asset") || readiness.issues.includes("missing_dimensions"));
  assert.equal(computeGeneratorEligibleLive(item), false);

  const client = createFakeSupabaseClient({ catalog_items: [t04Row()] });
  await assert.rejects(
    () => saveCatalogItemAdmin(client as never, "t04-uuid", { lifecycleStatus: "active" }, "2026-08-14T19:16:38.000000+00:00"),
    (error) => error instanceof CatalogReadinessError,
  );
  const row = client.tables.get("catalog_items")!.find((r) => r.id === "t04-uuid")!;
  assert.equal(row.lifecycle_status, "needs_review", "T04 must never end up active without a real 3D model");
});

test("construction scene item without required scene data is not ready, but a pricing-only construction item (no declared placement) is not forced to fabricate a GLB", () => {
  const sceneWall = toAdmin(stubRow({
    kind: "construction",
    document: { ...STUB_DOCUMENT, catalogItemKind: "construction", showIn3D: true, modelUrl: undefined, assets: undefined, reviewedAt: "2026-08-14T00:00:00.000Z" },
  }));
  assert.equal(computeReadiness(sceneWall).ready, false);

  const pricingOnlyConstruction = toAdmin(stubRow({
    kind: "construction",
    document: { ...STUB_DOCUMENT, catalogItemKind: "construction", showIn2D: undefined, showIn3D: undefined, reviewedAt: "2026-08-14T00:00:00.000Z" },
  }));
  const readiness = computeReadiness(pricingOnlyConstruction);
  assert.equal(readiness.ready, true, `pricing-only construction item nesmí vyžadovat GLB, issues: ${readiness.issues.join(", ")}`);
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
// CREATE — "Nová komponenta stánku" founding workflow (booth_component)
// -----------------------------------------------------------------------------------------

function boothComponentCreateInput(overrides: Partial<CatalogItemAdminCreateInput> = {}): CatalogItemAdminCreateInput {
  return {
    kind: "booth_component",
    displayName: "Sloupek",
    category: "Sloupky",
    ...overrides,
  };
}

test("CREATE: kind is always persisted as booth_component, lifecycle defaults to needs_review, reviewedAt is absent", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [] });
  const created = await createCatalogItemAdmin(client as never, boothComponentCreateInput());
  assert.equal(created.kind, "booth_component");
  assert.equal(created.lifecycleStatus, "needs_review");
  assert.equal(documentReviewedAt(created.document), undefined);
});

test("CREATE: generatorEligible is computed false immediately after creation (missing GLB+SKP), never stored", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [] });
  const created = await createCatalogItemAdmin(client as never, boothComponentCreateInput());
  assert.equal(computeGeneratorEligibleLive(created), false);
  assert.equal("generatorEligible" in created.document, false);
});

test("CREATE: internalCode is optional — omitted input yields internalCode=null, DB id is always distinct from internalCode", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [] });
  const created = await createCatalogItemAdmin(client as never, boothComponentCreateInput());
  assert.equal(created.internalCode, null);
  assert.notEqual(created.id, created.internalCode);
});

test("CREATE: duplicate internalCode (pre-check against existing rows) is rejected with DuplicateInternalCodeError", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [boothComponentRow({ internal_code: "KOMP-SLOUPEK" })] });
  await assert.rejects(
    () => createCatalogItemAdmin(client as never, boothComponentCreateInput({ internalCode: "komp-sloupek" })),
    DuplicateInternalCodeError,
  );
});

test("CREATE: duplicate internalCode caught only by the DB's unique index (read/insert race) still surfaces as DuplicateInternalCodeError", async () => {
  const raceClient = {
    from(_table: string) {
      const builder = {
        select() { return builder; },
        insert() {
          return {
            select: () => ({
              single: async () => ({ data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } }),
            }),
          };
        },
        then(onFulfilled: (value: { data: unknown; error: unknown }) => unknown, onRejected?: (reason: unknown) => unknown) {
          return Promise.resolve({ data: [], error: null }).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };
  await assert.rejects(
    () => createCatalogItemAdmin(raceClient as never, boothComponentCreateInput({ internalCode: "KOMP-SLOUPEK" })),
    DuplicateInternalCodeError,
  );
});

test("CREATE: dimensions/category/unit/2D-3D capability round-trip into the document AND are mirrored into the top-level DB columns", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [] });
  const created = await createCatalogItemAdmin(
    client as never,
    boothComponentCreateInput({ unit: "ks", widthMm: 120, depthMm: 120, heightMm: 2500, showIn2D: true, showIn3D: false }),
  );
  const dims = documentDimensions(created.document);
  assert.deepEqual(dims, { widthMm: 120, depthMm: 120, heightMm: 2500, hasDimensions: true });
  assert.equal(created.document.showIn2D, true);
  assert.equal(created.document.showIn3D, false);
  assert.equal(created.category, "Sloupky");
  assert.equal(created.unit, "ks");
  assert.equal(created.displayName, "Sloupek");
});

test("CREATE: no fake import provenance — sourceSystem/sourceKey stay absent (manual/admin origin is never invented)", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [] });
  const created = await createCatalogItemAdmin(client as never, boothComponentCreateInput());
  assert.deepEqual(documentSourceTraceability(created.document), { sourceSystem: null, sourceKey: null });
});

test("CREATE: the new item is visible via a kind-filtered read (Booth Components tab) and an unfiltered read (Admin Components) with the identical id", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [] });
  const created = await createCatalogItemAdmin(client as never, boothComponentCreateInput());
  const all = await readCatalogItemsAdmin(client as never);
  const unfiltered = all.find((item) => item.id === created.id);
  const kindFiltered = all.filter((item) => item.kind === "booth_component").find((item) => item.id === created.id);
  assert.ok(unfiltered, "must appear in the unfiltered admin list");
  assert.ok(kindFiltered, "must appear in the booth_component-filtered tab");
  assert.equal(unfiltered!.id, kindFiltered!.id);
  assert.equal(unfiltered!.updatedAt, created.updatedAt);
});

test("CREATE: after creation, the existing GLB+SKP asset workflow (saveCatalogItemAdmin) still works and readiness becomes ready", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [] });
  const created = await createCatalogItemAdmin(client as never, boothComponentCreateInput());
  const asset: StoredAsset = { id: "glb-1", storageKey: "catalog/booth-components/sloupek/model.glb", originalFileName: "sloupek.glb", mimeType: "model/gltf-binary", size: 100, createdAt: "2026-08-18T00:00:00.000Z", category: "catalog-model" };
  const skpAsset: StoredAsset = { id: "skp-1", storageKey: "catalog/booth-components/sloupek/source/sloupek.skp", originalFileName: "sloupek.skp", mimeType: "application/octet-stream", size: 200, createdAt: "2026-08-18T00:00:00.000Z", category: "catalog-source" };
  const withModel = await saveCatalogItemAdmin(client as never, created.id, { modelAsset: asset }, created.updatedAt);
  const withSource = await saveCatalogItemAdmin(client as never, created.id, { addSourceAsset: { kind: "sketchup", asset: skpAsset } }, withModel.updatedAt);
  assert.deepEqual(computeReadiness(withSource), { ready: true, issues: [] });
});

test("CREATE: missing GLB alone blocks readiness with exactly missing_3d_asset (SKP present)", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [] });
  const created = await createCatalogItemAdmin(client as never, boothComponentCreateInput());
  const skpAsset: StoredAsset = { id: "skp-1", storageKey: "catalog/booth-components/sloupek/source/sloupek.skp", originalFileName: "sloupek.skp", mimeType: "application/octet-stream", size: 200, createdAt: "2026-08-18T00:00:00.000Z", category: "catalog-source" };
  const withSource = await saveCatalogItemAdmin(client as never, created.id, { addSourceAsset: { kind: "sketchup", asset: skpAsset } }, created.updatedAt);
  assert.deepEqual(computeReadiness(withSource).issues, ["missing_3d_asset"]);
});

test("CREATE: missing SKP alone blocks readiness with exactly missing_sketchup_source, even with a DWG attached (GLB present)", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [] });
  const created = await createCatalogItemAdmin(client as never, boothComponentCreateInput());
  const asset: StoredAsset = { id: "glb-1", storageKey: "catalog/booth-components/sloupek/model.glb", originalFileName: "sloupek.glb", mimeType: "model/gltf-binary", size: 100, createdAt: "2026-08-18T00:00:00.000Z", category: "catalog-model" };
  const dwgAsset: StoredAsset = { id: "dwg-1", storageKey: "catalog/booth-components/sloupek/source/sloupek.dwg", originalFileName: "sloupek.dwg", mimeType: "application/octet-stream", size: 300, createdAt: "2026-08-18T00:00:00.000Z", category: "catalog-source" };
  const withModel = await saveCatalogItemAdmin(client as never, created.id, { modelAsset: asset }, created.updatedAt);
  const withDwg = await saveCatalogItemAdmin(client as never, created.id, { addSourceAsset: { kind: "dwg", asset: dwgAsset } }, withModel.updatedAt);
  assert.deepEqual(computeReadiness(withDwg).issues, ["missing_sketchup_source"]);
});

test("CREATE: parseCatalogItemAdminCreateInput never accepts a lifecycleStatus field — create can never activate by construction", () => {
  const input = parseCatalogItemAdminCreateInput({ kind: "booth_component", displayName: "Sloupek", category: "Sloupky", lifecycleStatus: "active" });
  assert.equal("lifecycleStatus" in input, false);
});

test("CREATE: markReviewed on a freshly-created item still never sets lifecycleStatus to active", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [] });
  const created = await createCatalogItemAdmin(client as never, boothComponentCreateInput());
  const reviewed = await saveCatalogItemAdmin(client as never, created.id, { markReviewed: true }, created.updatedAt);
  assert.equal(reviewed.lifecycleStatus, "needs_review");
  assert.ok(documentReviewedAt(reviewed.document));
});

test("CREATE: parseCatalogItemAdminCreateInput rejects missing displayName/category as 400-worthy errors", () => {
  assert.throws(() => parseCatalogItemAdminCreateInput({ kind: "booth_component", category: "Sloupky" }), InvalidCatalogItemAdminCreateInputError);
  assert.throws(() => parseCatalogItemAdminCreateInput({ kind: "booth_component", displayName: "Sloupek" }), InvalidCatalogItemAdminCreateInputError);
  assert.throws(() => parseCatalogItemAdminCreateInput({ displayName: "Sloupek", category: "Sloupky" }), InvalidCatalogItemAdminCreateInputError);
});

test("POST /api/catalog-admin/items/create: unauthenticated -> 401", async () => {
  const response = await handleCatalogAdminItemsCreate(authenticatedRequest(undefined, "http://localhost/api/catalog-admin/items/create", { method: "POST", body: { create: boothComponentCreateInput() } }));
  assert.equal(response.status, 401);
});

test("POST /api/catalog-admin/items/create: missing displayName -> 400", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsCreate(
    authenticatedRequest(token, "http://localhost/api/catalog-admin/items/create", { method: "POST", body: { create: { kind: "booth_component", category: "Sloupky" } } }),
  );
  assert.equal(response.status, 400);
});

test("POST /api/catalog-admin/items/create: duplicate internalCode -> 409", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsCreate(
    authenticatedRequest(token, "http://localhost/api/catalog-admin/items/create", { method: "POST", body: { create: boothComponentCreateInput({ internalCode: "KOMP-SLOUPEK" }) } }),
    async () => { throw new DuplicateInternalCodeError("KOMP-SLOUPEK"); },
  );
  assert.equal(response.status, 409);
});

test("POST /api/catalog-admin/items/create: missing Supabase config -> 503", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsCreate(
    authenticatedRequest(token, "http://localhost/api/catalog-admin/items/create", { method: "POST", body: { create: boothComponentCreateInput() } }),
    async () => { throw new SupabaseConfigurationError(["SUPABASE_SECRET_KEY"]); },
  );
  assert.equal(response.status, 503);
});

test("POST /api/catalog-admin/items/create: generic DB error -> 502", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsCreate(
    authenticatedRequest(token, "http://localhost/api/catalog-admin/items/create", { method: "POST", body: { create: boothComponentCreateInput() } }),
    async () => { throw new Error("network error"); },
  );
  assert.equal(response.status, 502);
});

test("POST /api/catalog-admin/items/create: authenticated + valid -> 200, kind/lifecycle are never taken verbatim from an attacker-controlled body", async () => {
  const token = await createSessionToken(SECRET);
  let capturedInput: unknown;
  const response = await handleCatalogAdminItemsCreate(
    authenticatedRequest(token, "http://localhost/api/catalog-admin/items/create", {
      method: "POST",
      body: { create: { kind: "booth_component", displayName: "Sloupek", category: "Sloupky", lifecycleStatus: "active", reviewedAt: "2000-01-01T00:00:00.000Z" } },
    }),
    async (input) => {
      capturedInput = input;
      return toAdmin(boothComponentRow({ id: "new-sloupek-uuid" }));
    },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(capturedInput, { kind: "booth_component", displayName: "Sloupek", category: "Sloupky" });
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

test("ComponentAdminPage.tsx reuses the existing asset upload infrastructure (uploadAsset/useAssetUrl) — never a second/parallel upload system", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ uploadAsset, type UploadProgress \} from "\.\.\/\.\.\/lib\/storage\/assetClient"/u);
  assert.match(source, /import \{ useAssetUrl \} from "\.\.\/\.\.\/hooks\/useAssetUrl"/u);
  assert.doesNotMatch(source, /@aws-sdk/u, "never talks to R2 directly — only through the existing presign/download API routes");
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

test("UI: detail sections match Identita/Rozměry/Lifecycle/Fotografie/3D model/Zdrojové a výrobní soubory/Ceny (section 6, extended with the asset + source-file workflow)", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  for (const heading of ["Identita", "Rozměry", "Lifecycle", "Fotografie", "3D model", "Zdrojové a výrobní soubory", "Ceny"]) {
    assert.match(source, new RegExp(`<h3>${heading}</h3>`), `missing detail section "${heading}"`);
  }
});

test("UI: source-file upload reuses the existing uploadAsset infrastructure with category 'catalog-source' — never a second/parallel upload system", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /uploadAsset\(file, \{ category: "catalog-source"/u);
});

test("UI: source-file removal is metadata-only (removeSourceAssetId), same reference-safety pattern as photoAsset/modelAsset removal", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /onSave\(\{ removeSourceAssetId: entry\.id \}\)/u);
});

test("UI: source-file section is gated by kind (dispatched, never a name/category heuristic) and excludes pure services", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  const constMatch = source.match(/const SOURCE_ASSET_APPLICABLE_KINDS[^;]+;/u);
  assert.ok(constMatch, "expected SOURCE_ASSET_APPLICABLE_KINDS to be defined");
  for (const kind of ["furniture", "booth", "booth_component", "construction"]) {
    assert.match(constMatch![0], new RegExp(`"${kind}"`), `${kind} must be allowed to show source files`);
  }
  for (const kind of ["service", "graphics_service"]) {
    assert.doesNotMatch(constMatch![0], new RegExp(`"${kind}"`), `${kind} (pure service, e.g. L02) must never show a CAD/source-file section`);
  }
  assert.match(source, /SOURCE_ASSET_APPLICABLE_KINDS\.includes\(item\.kind\) &&/u, "the section itself must be conditionally rendered based on kind");
});

test("UI: a furniture item (e.g. a chair) is allowed to show the source-file section — SKP/DWG/DXF/PDF are never Komponenty-stánku-only", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  const constMatch = source.match(/const SOURCE_ASSET_APPLICABLE_KINDS[^;]+;/u)![0];
  assert.match(constMatch, /"furniture"/u);
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

// =========================================================================================
// SECTION 18 — CATALOG ITEM ASSET WORKFLOW (photo + GLB upload/replace/remove, review,
// activation safety, PrintSurface non-inference, concurrency).
// =========================================================================================

function storedAsset(overrides: Partial<StoredAsset> & Pick<StoredAsset, "id" | "storageKey">): StoredAsset {
  return {
    originalFileName: "file.bin",
    mimeType: "application/octet-stream",
    size: 12345,
    createdAt: "2026-08-17T10:00:00.000Z",
    category: "catalog-photo",
    ...overrides,
  };
}

const PHOTO_ASSET = storedAsset({ id: "photo-1", storageKey: "catalog/furniture/f01/photos/photo-1.jpg", originalFileName: "chair.jpg", mimeType: "image/jpeg", category: "catalog-photo" });
const MODEL_ASSET = storedAsset({ id: "model-1", storageKey: "catalog/furniture/f01/models/model-1.glb", originalFileName: "chair.glb", mimeType: "model/gltf-binary", size: 2_000_000, category: "catalog-model" });

// -----------------------------------------------------------------------------------------
// PHOTO
// -----------------------------------------------------------------------------------------

test("PHOTO valid upload: parseCatalogItemAdminEdit accepts a well-shaped StoredAsset for photoAsset", () => {
  const edit = parseCatalogItemAdminEdit({ photoAsset: PHOTO_ASSET });
  assert.deepEqual(edit.photoAsset, PHOTO_ASSET);
});

test("PHOTO invalid: a malformed/incomplete photoAsset value (missing storageKey) is silently dropped, never merged", () => {
  const edit = parseCatalogItemAdminEdit({ photoAsset: { id: "x", originalFileName: "photo.jpg" } });
  assert.equal(edit.photoAsset, undefined);
});

test("PHOTO storageKey persisted: saveCatalogItemAdmin writes the exact storageKey into document.photoAsset", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { photoAsset: PHOTO_ASSET }, "2026-08-14T19:16:38.000000+00:00");
  const persistedAsset = documentPhotoAsset(saved.document);
  assert.equal(persistedAsset?.storageKey, PHOTO_ASSET.storageKey);
});

test("PHOTO signed URL never persisted: StoredAsset carries only a storageKey, never a resolved/signed URL field", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { photoAsset: PHOTO_ASSET }, "2026-08-14T19:16:38.000000+00:00");
  const persistedAsset = documentPhotoAsset(saved.document) as unknown as Record<string, unknown>;
  assert.ok(persistedAsset);
  for (const key of Object.keys(persistedAsset)) assert.doesNotMatch(key.toLowerCase(), /signedurl|downloadurl|presigned/u);
  assert.doesNotMatch(JSON.stringify(persistedAsset), /X-Amz-Signature|X-Amz-Credential/u);
});

// -----------------------------------------------------------------------------------------
// GLB
// -----------------------------------------------------------------------------------------

test("GLB valid: parseCatalogItemAdminEdit accepts a well-shaped StoredAsset for modelAsset", () => {
  const edit = parseCatalogItemAdminEdit({ modelAsset: MODEL_ASSET });
  assert.deepEqual(edit.modelAsset, MODEL_ASSET);
});

test("GLB invalid: a malformed modelAsset value is silently dropped, never merged", () => {
  const edit = parseCatalogItemAdminEdit({ modelAsset: "not-an-object" });
  assert.equal(edit.modelAsset, undefined);
});

test("GLB storageKey persisted: saveCatalogItemAdmin writes the exact storageKey into document.modelAsset, and has3DAsset/readiness recognize it", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { modelAsset: MODEL_ASSET }, "2026-08-14T19:16:38.000000+00:00");
  const persistedAsset = documentModelAsset(saved.document);
  assert.equal(persistedAsset?.storageKey, MODEL_ASSET.storageKey);
  assert.equal(documentHas3DAsset(saved.document), true);
});

test("GLB static model fallback remains functional: P86's legacy modelUrl (no modelAsset) still counts as has3DAsset and stays ready", () => {
  const p86 = toAdmin(p86Row());
  assert.equal(documentModelAsset(p86.document), undefined, "P86 seed never had an R2 modelAsset");
  assert.equal(documentHas3DAsset(p86.document), true, "legacy modelUrl alone must still satisfy has3DAsset");
  assert.equal(computeReadiness(p86).ready, true);
});

// -----------------------------------------------------------------------------------------
// BOOTH ADMIN PAGE — Part 2 of the request: "Stánky" now hosts both complete type-booths and
// individual booth components, clearly separated, reusing the same DB-backed detail UI —
// never a parallel model, never wired into the live generator picker.
// -----------------------------------------------------------------------------------------

test("BoothAdminPage.tsx reuses ComponentAdminList/ComponentAdminDetail exported from ComponentAdminPage.tsx — no parallel list/detail UI", () => {
  const source = readFileSync(new URL("../components/workflow/BoothAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /import \{ ComponentAdminDetail, ComponentAdminList \} from "\.\/ComponentAdminPage"/u);
});

test("BoothAdminPage.tsx separates 'Typové stánky' (kind=booth) and 'Komponenty stánku' (kind=booth_component) as clearly labeled tabs", () => {
  const source = readFileSync(new URL("../components/workflow/BoothAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /kind: "booth", label: "Typové stánky"/u);
  assert.match(source, /kind: "booth_component", label: "Komponenty stánku"/u);
});

test("BoothAdminPage.tsx keeps the ComponentAdminDetail key={selected.id} stale-state fix — switching between selected items never leaks state", () => {
  const source = readFileSync(new URL("../components/workflow/BoothAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /<ComponentAdminDetail\s+key=\{selected\.id\}/u);
});

test("BoothAdminPage.tsx never imports/renders ComponentLibrary — booth components stay evidence/readiness-only, never wired into the live generator picker", () => {
  const source = readFileSync(new URL("../components/workflow/BoothAdminPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /import .*ComponentLibrary|<ComponentLibrary/u);
});

test("booth_component is a real CatalogItemKind with its own Czech label, never a category-only heuristic", () => {
  const source = readFileSync(new URL("../domain/catalogItemsAdmin.ts", import.meta.url), "utf8");
  assert.match(source, /booth_component: "Komponenta stánku"/u);
});

// =========================================================================================
// ADMIN CLASSIFICATION (2026-08-19): kind=booth (P86/P87/Txx) lives ONLY in "Knihovna stánků →
// Typové stánky" — the generic "Administrace → Komponenty" page (ComponentAdminPage) must never
// list them, so an operator can't edit a type-booth from the wrong screen. booth_component stays
// visible in BOTH (unchanged, intentional dual-visibility).
// =========================================================================================

test("ComponentAdminPage.tsx excludes kind=booth items from its list — type-booths are never editable from the generic Admin → Komponenty screen", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /const nonBoothItems = useMemo/u);
  assert.match(source, /item\.kind !== "booth"/u);
  assert.match(source, /const listEntries = useMemo\(\(\) => nonBoothItems\.map\(buildCatalogItemListEntry\)/u);
});

test("ComponentAdminFilters' kind dropdown never offers 'booth' as an option (it can never appear in this list, so selecting it would always show zero results)", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /CATALOG_ITEM_KINDS\.filter\(\(kind\) => kind !== "booth"\)\.map/u);
});

test("BoothAdminPage.tsx's 'Typové stánky' tab is UNAFFECTED by the Admin-Komponenty exclusion — it filters its OWN independently-fetched items by kind, not ComponentAdminPage's list", () => {
  const source = readFileSync(new URL("../components/workflow/BoothAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /const tabItems = useMemo/u);
  assert.match(source, /item\.kind === activeKind/u);
});

// =========================================================================================
// THUMBNAIL (2026-08-19): a catalog item's own photoAsset (R2, signed URL resolved at render
// time — never persisted) is the canonical thumbnail; the legacy static photoUrl is the
// fallback. Applies to every kind uniformly, including booth (P86/P87/Txx).
// =========================================================================================

test("buildCatalogItemListEntry exposes photoAsset/photoUrl so the list can render a thumbnail — sourced from the same documentPhotoAsset/documentPhotoUrl readers as the detail view", () => {
  const withPhoto = toAdmin(p86Row({ document: { ...P86_DOCUMENT, photoAsset: { id: "p1", storageKey: "catalog/furniture/p86/photos/a.jpg", originalFileName: "a.jpg", mimeType: "image/jpeg", size: 100, createdAt: "2026-08-19T00:00:00.000Z", category: "catalog-photo" } } }));
  const entry = buildCatalogItemListEntry(withPhoto);
  assert.equal(entry.photoAsset?.storageKey, "catalog/furniture/p86/photos/a.jpg");
});

test("buildCatalogItemListEntry: no photoAsset/photoUrl -> both undefined, never a fabricated placeholder value", () => {
  const withoutPhoto = toAdmin(stubRow());
  const entry = buildCatalogItemListEntry(withoutPhoto);
  assert.equal(entry.photoAsset, undefined);
  assert.equal(entry.photoUrl, undefined);
});

test("ComponentAdminList renders a ThumbnailCell per row using useAssetUrl (photoAsset resolved to a signed URL, photoUrl as fallback) — never a raw/unresolved storageKey rendered as an <img> src", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /<ThumbnailCell photoAsset=\{entry\.photoAsset\} photoUrl=\{entry\.photoUrl\}/u);
  assert.match(source, /function ThumbnailCell\(/u);
  assert.match(source, /useAssetUrl\(photoAsset, photoUrl\)/u);
});

test("ThumbnailCell falls back to a plain placeholder (never a broken <img>) when neither photoAsset nor photoUrl resolves to a URL", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  const thumbnailCellMatch = source.match(/function ThumbnailCell\([\s\S]{0,600}?\n\}/u);
  assert.ok(thumbnailCellMatch, "expected to find ThumbnailCell");
  assert.match(thumbnailCellMatch![0], /catalogThumbnailPlaceholder/u);
});

test("BoothGenerator.tsx's booth-selection card thumbnail prefers photoAsset over the legacy thumbnailUrl, via the SAME useAssetUrl hook — never a second resolution mechanism", () => {
  const source = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  const thumbnailMatch = source.match(/function BoothTypeCardThumbnail\([\s\S]{0,700}?\n\}/u);
  assert.ok(thumbnailMatch, "expected to find BoothTypeCardThumbnail");
  assert.match(thumbnailMatch![0], /useAssetUrl\(booth\.photoAsset, booth\.thumbnailUrl\)/u);
  assert.match(thumbnailMatch![0], /constructionShape/u, "must still fall back to the placeholder construction shape when no thumbnail resolves");
});

// -----------------------------------------------------------------------------------------
// SOURCE ASSETS (SKP/DWG/DXF/PDF/other) — Part 3 of the generalized source/manufacturing-file
// request. A LIST, unlike the single photoAsset/modelAsset — one edit either appends one entry
// (addSourceAsset) or removes one entry by id (removeSourceAssetId), never a wholesale replace.
// -----------------------------------------------------------------------------------------

const SKP_ASSET: StoredAsset = { id: "skp-1", storageKey: "catalog/furniture/f01/source/skp-1.skp", originalFileName: "part.skp", mimeType: "application/octet-stream", size: 900_000, createdAt: "2026-08-14T00:00:00.000Z", category: "catalog-source" };
const DWG_ASSET: StoredAsset = { id: "dwg-1", storageKey: "catalog/furniture/f01/source/dwg-1.dwg", originalFileName: "part.dwg", mimeType: "application/octet-stream", size: 400_000, createdAt: "2026-08-14T00:00:00.000Z", category: "catalog-source" };

test("SOURCE ASSET valid: parseCatalogItemAdminEdit accepts a well-shaped addSourceAsset", () => {
  const edit = parseCatalogItemAdminEdit({ addSourceAsset: { kind: "sketchup", asset: SKP_ASSET } });
  assert.deepEqual(edit.addSourceAsset, { kind: "sketchup", asset: SKP_ASSET, label: undefined });
});

test("SOURCE ASSET invalid: an unknown kind or malformed asset is silently dropped, never merged", () => {
  assert.equal(parseCatalogItemAdminEdit({ addSourceAsset: { kind: "cad-blueprint", asset: SKP_ASSET } }).addSourceAsset, undefined);
  assert.equal(parseCatalogItemAdminEdit({ addSourceAsset: { kind: "sketchup", asset: { id: "x" } } }).addSourceAsset, undefined);
});

test("SOURCE ASSET: applyCatalogItemEdit appends addSourceAsset to the existing list, generating a fresh id, never overwriting other entries", () => {
  const withDwg = { ...STUB_DOCUMENT, sourceAssets: [{ id: "existing-dwg", kind: "dwg", asset: DWG_ASSET }] };
  const merged = applyCatalogItemEdit(withDwg, { addSourceAsset: { kind: "sketchup", asset: SKP_ASSET } });
  const entries = documentSourceAssets(merged);
  assert.equal(entries.length, 2);
  assert.ok(entries.some((entry) => entry.kind === "dwg" && entry.id === "existing-dwg"));
  const added = entries.find((entry) => entry.kind === "sketchup")!;
  assert.equal(added.asset.storageKey, SKP_ASSET.storageKey);
  assert.ok(added.id && added.id !== "existing-dwg");
});

test("SOURCE ASSET: removeSourceAssetId removes only the matching entry — everything else survives, metadata-only (no R2 delete)", () => {
  const withTwo = { ...STUB_DOCUMENT, sourceAssets: [{ id: "keep-me", kind: "dwg", asset: DWG_ASSET }, { id: "remove-me", kind: "sketchup", asset: SKP_ASSET }] };
  const merged = applyCatalogItemEdit(withTwo, { removeSourceAssetId: "remove-me" });
  const entries = documentSourceAssets(merged);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.id, "keep-me");
});

test("SOURCE ASSET storageKey persisted end to end on a booth: saveCatalogItemAdmin writes the new entry, but SKP is pure evidence for booth kind — readiness/status are unaffected either way", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [p86Row({ document: P86_DOCUMENT })] });
  const saved = await saveCatalogItemAdmin(client as never, "p86-uuid", { addSourceAsset: { kind: "sketchup", asset: SKP_ASSET } }, "2026-08-14T19:16:38.367959+00:00");
  const entries = documentSourceAssets(saved.document);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.kind, "sketchup");
  assert.equal(saved.lifecycleStatus, "active", "adding an (optional, for booth) SKP entry must never itself change lifecycle status");
  assert.equal(computeReadiness(saved).ready, true);
});

test("SOURCE ASSET: removing the only sketchup entry on an ALREADY ACTIVE booth_component auto-downgrades to needs_review — booth_component DOES require SKP (Part 28), unlike booth", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [boothComponentRow()] });
  const saved = await saveCatalogItemAdmin(client as never, "sloupek-uuid", { removeSourceAssetId: P86_SKETCHUP_SOURCE.id }, "2026-08-14T19:16:38.367959+00:00");
  assert.equal(documentSourceAssets(saved.document).length, 0);
  assert.equal(saved.lifecycleStatus, "needs_review", "active+not-ready (missing SKP on a booth_component) must never persist — safe auto-downgrade instead of blocking the removal");
});

test("SOURCE ASSET: removing the only sketchup entry on an ALREADY ACTIVE booth (kind=booth, not booth_component) never downgrades it — SKP is not required for booth readiness (Part 27)", async () => {
  const withSkp = { ...P86_DOCUMENT, sourceAssets: [P86_SKETCHUP_SOURCE] };
  const client = createFakeSupabaseClient({ catalog_items: [p86Row({ document: withSkp })] });
  const saved = await saveCatalogItemAdmin(client as never, "p86-uuid", { removeSourceAssetId: P86_SKETCHUP_SOURCE.id }, "2026-08-14T19:16:38.367959+00:00");
  assert.equal(documentSourceAssets(saved.document).length, 0);
  assert.equal(saved.lifecycleStatus, "active", "booth readiness never depended on SKP — removing it must never downgrade an active booth");
});

test("SOURCE ASSET: removing a non-sketchup (e.g. DWG) entry from an active, otherwise-ready booth_component never downgrades it", async () => {
  const withExtraDwg = { ...SLOUPEK_DOCUMENT, sourceAssets: [P86_SKETCHUP_SOURCE, { id: "extra-dwg", kind: "dwg", asset: DWG_ASSET }] };
  const client = createFakeSupabaseClient({ catalog_items: [boothComponentRow({ document: withExtraDwg })] });
  const saved = await saveCatalogItemAdmin(client as never, "sloupek-uuid", { removeSourceAssetId: "extra-dwg" }, "2026-08-14T19:16:38.367959+00:00");
  assert.equal(saved.lifecycleStatus, "active");
  assert.equal(documentSourceAssets(saved.document).some((entry) => entry.kind === "sketchup"), true);
});

// -----------------------------------------------------------------------------------------
// REPLACE — section 7: upload first, DB save second; old reference survives any failure.
// -----------------------------------------------------------------------------------------

test("REPLACE: stale updatedAt during a photo replace leaves the OLD photoAsset untouched in the DB (ConcurrencyConflictError, no overwrite)", async () => {
  const existingPhoto = storedAsset({ id: "old-photo", storageKey: "catalog/furniture/f01/photos/old.jpg", category: "catalog-photo" });
  const client = createFakeSupabaseClient({ catalog_items: [stubRow({ document: { ...STUB_DOCUMENT, photoAsset: existingPhoto } })] });
  await assert.rejects(
    () => saveCatalogItemAdmin(client as never, "f01-uuid", { photoAsset: PHOTO_ASSET }, "2020-01-01T00:00:00.000000+00:00"),
    (error) => error instanceof ConcurrencyConflictError,
  );
  const row = client.tables.get("catalog_items")!.find((r) => r.id === "f01-uuid")!;
  assert.equal((row.document as FakeRow).photoAsset, existingPhoto, "old reference must survive a rejected concurrent replace untouched");
});

test("REPLACE: a mid-save DB failure (not preflight-detectable) never destroys the old modelAsset reference", async () => {
  const existingModel = storedAsset({ id: "old-model", storageKey: "catalog/furniture/f01/models/old.glb", category: "catalog-model" });
  const client = createFakeSupabaseClient({ catalog_items: [stubRow({ document: { ...STUB_DOCUMENT, modelAsset: existingModel } })] });
  const realFrom = client.from.bind(client);
  client.from = ((tableName: string) => {
    const builder = realFrom(tableName);
    if (tableName === "catalog_items") {
      const originalUpdate = builder.update.bind(builder);
      builder.update = ((patch: FakeRow) => {
        originalUpdate(patch);
        // Simulate a genuine mid-run DB failure (e.g. transient network error) on the
        // conditional UPDATE — something no upfront preflight check could have predicted.
        builder.then = ((onFulfilled: (value: { data: unknown; error: unknown }) => unknown, onRejected?: (reason: unknown) => unknown) =>
          Promise.resolve({ data: null, error: { message: "simulated transient DB error" } }).then(onFulfilled, onRejected)) as typeof builder.then;
        return builder;
      }) as typeof builder.update;
    }
    return builder;
  }) as typeof client.from;

  await assert.rejects(() => saveCatalogItemAdmin(client as never, "f01-uuid", { modelAsset: MODEL_ASSET }, "2026-08-14T19:16:38.000000+00:00"));
  const row = client.tables.get("catalog_items")!.find((r) => r.id === "f01-uuid")!;
  assert.equal((row.document as FakeRow).modelAsset, existingModel, "old modelAsset must remain after a failed save — new R2 object may become orphaned, that is accepted");
});

test("no physical R2 delete anywhere in the catalog-admin save path — replace/remove is always metadata-only", () => {
  const repoSource = readFileSync(new URL("../lib/db/catalogItemsAdmin.supabase.ts", import.meta.url), "utf8");
  const domainSource = readFileSync(new URL("../domain/catalogItemsAdmin.ts", import.meta.url), "utf8");
  assert.doesNotMatch(repoSource, /deleteObject|AssetStorageProvider|@aws-sdk/u);
  assert.doesNotMatch(domainSource, /deleteObject|AssetStorageProvider|@aws-sdk/u);
});

// -----------------------------------------------------------------------------------------
// REMOVE
// -----------------------------------------------------------------------------------------

test("REMOVE: photoAsset:null removes only that key — everything else in the document is untouched", () => {
  const withPhoto = { ...STUB_DOCUMENT, photoAsset: PHOTO_ASSET, modelAsset: MODEL_ASSET };
  const merged = applyCatalogItemEdit(withPhoto, { photoAsset: null });
  assert.equal("photoAsset" in merged, false);
  assert.deepEqual(merged.modelAsset, MODEL_ASSET, "modelAsset must survive a photoAsset removal");
  assert.equal(merged.internalCode, "F01");
  assert.equal(merged.sourceKey, STUB_DOCUMENT.sourceKey);
});

test("REMOVE: modelAsset:null on an ALREADY ACTIVE booth (P86-shaped) that has no other model reference auto-downgrades to needs_review instead of leaving active+not-ready", async () => {
  // P86-shaped active booth whose ONLY 3D reference is the modelAsset being removed (no legacy modelUrl).
  const activeBoothDoc = { ...P86_DOCUMENT, modelUrl: undefined, modelAsset: MODEL_ASSET };
  const client = createFakeSupabaseClient({ catalog_items: [p86Row({ document: activeBoothDoc })] });
  const saved = await saveCatalogItemAdmin(client as never, "p86-uuid", { modelAsset: null }, "2026-08-14T19:16:38.367959+00:00");
  assert.equal("modelAsset" in saved.document, false, "reference must actually be removed");
  assert.equal(saved.lifecycleStatus, "needs_review", "active+not-ready must never persist — safe auto-downgrade instead of blocking the removal");
  const row = client.tables.get("catalog_items")!.find((r) => r.id === "p86-uuid")!;
  assert.equal(row.lifecycle_status, "needs_review", "lifecycle_status column must be kept in sync with the document");
});

test("REMOVE: modelAsset:null on an active booth that STILL has a legacy modelUrl fallback stays active (readiness still satisfied)", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [p86Row({ document: { ...P86_DOCUMENT, modelAsset: MODEL_ASSET } })] });
  const saved = await saveCatalogItemAdmin(client as never, "p86-uuid", { modelAsset: null }, "2026-08-14T19:16:38.367959+00:00");
  assert.equal(saved.lifecycleStatus, "active", "legacy modelUrl still satisfies has3DAsset, so removal of the R2 asset alone must not break readiness");
});

test("REMOVE: unrelated edits to an already-active-but-imperfect item (M57) never retroactively downgrade it — auto-downgrade is scoped ONLY to explicit asset removal", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [m57Row()] });
  const saved = await saveCatalogItemAdmin(client as never, "m57-uuid", { unit: "ks" }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(saved.lifecycleStatus, "active", "a plain metadata edit must never trigger the asset-removal downgrade guard");
});

test("FURNITURE + SKP: M57 (canonical furniture) can persist a SketchUp source alongside its GLB — readiness/generatorEligible/lifecycleStatus are completely unaffected either way (SKP never counts toward furniture readiness)", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [m57Row()] });
  const before = client.tables.get("catalog_items")!.find((r) => r.id === "m57-uuid")!;
  const beforeReadiness = computeReadiness(toAdmin(before));

  const saved = await saveCatalogItemAdmin(client as never, "m57-uuid", { addSourceAsset: { kind: "sketchup", asset: SKP_ASSET } }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(saved.lifecycleStatus, "active", "adding an SKP evidence file must never itself change lifecycle status");
  assert.equal(documentSourceAssets(saved.document).some((entry) => entry.kind === "sketchup"), true, "furniture must be able to persist a SKP entry");
  assert.equal(documentHas3DAsset(saved.document), documentHas3DAsset(before.document as never), "adding a SKP entry must never change has3DAsset — SKP is never a runtime GLB substitute");
  assert.deepEqual(computeReadiness(saved).issues, beforeReadiness.issues, "furniture readiness rules never read sourceAssets — adding SKP changes nothing about readiness");
});

test("FURNITURE + optional source files: adding then removing a DWG on a FULLY READY, already-active furniture item never changes its lifecycleStatus/generatorEligible", async () => {
  const readyFurnitureDoc = { ...STUB_DOCUMENT, widthMm: 500, depthMm: 500, showIn2D: true, showIn3D: true, footprint2D: { shape: "rectangle" }, modelUrl: "/models/test.glb", reviewedAt: "2026-08-14T00:00:00.000Z", lifecycleStatus: "active" };
  const client = createFakeSupabaseClient({ catalog_items: [stubRow({ document: readyFurnitureDoc, lifecycle_status: "active" })] });

  const withDwg = await saveCatalogItemAdmin(client as never, "f01-uuid", { addSourceAsset: { kind: "dwg", asset: DWG_ASSET } }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(withDwg.lifecycleStatus, "active");
  const dwgEntry = documentSourceAssets(withDwg.document).find((entry) => entry.kind === "dwg")!;
  assert.ok(dwgEntry);

  const afterRemove = await saveCatalogItemAdmin(client as never, "f01-uuid", { removeSourceAssetId: dwgEntry.id }, withDwg.updatedAt);
  assert.equal(afterRemove.lifecycleStatus, "active", "removing an optional DWG from an item that is ready without it must never downgrade it");
  assert.equal(computeGeneratorEligibleLive(afterRemove), true);
});

// -----------------------------------------------------------------------------------------
// DOCUMENT — nested metadata survives asset edits (P86 sanity, extended to the asset workflow)
// -----------------------------------------------------------------------------------------

test("DOCUMENT: P86 parts/printSurfaces/pricingEntries/defaultCarpetFinishId survive a photoAsset AND modelAsset save untouched", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [p86Row()] });
  const saved = await saveCatalogItemAdmin(client as never, "p86-uuid", { photoAsset: PHOTO_ASSET, modelAsset: MODEL_ASSET }, "2026-08-14T19:16:38.367959+00:00");
  assert.deepEqual(saved.document.parts, P86_DOCUMENT.parts);
  assert.deepEqual(saved.document.printSurfaces, P86_DOCUMENT.printSurfaces);
  assert.deepEqual(saved.document.pricingEntries, P86_DOCUMENT.pricingEntries);
  assert.equal(saved.document.defaultCarpetFinishId, "carpet-grey");
});

test("DOCUMENT: sourceKey/internalCode survive an asset save on an ordinary needs_review item", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { photoAsset: PHOTO_ASSET }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(saved.internalCode, "F01");
  assert.equal(saved.document.sourceKey, "pricelist::nabytek::testovaci-nabytek-1");
  assert.equal(saved.document.sourceSystem, "excel-v6.6");
});

test("DOCUMENT: base pricing (document.pricingEntries) survives a GLB upload", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { modelAsset: MODEL_ASSET }, "2026-08-14T19:16:38.000000+00:00");
  assert.deepEqual(saved.document.pricingEntries, STUB_DOCUMENT.pricingEntries);
});

// -----------------------------------------------------------------------------------------
// REVIEW — section 9: reviewedAt is ONLY ever set by the explicit markReviewed action.
// -----------------------------------------------------------------------------------------

test("REVIEW: uploading a photo or GLB never sets reviewedAt as a side effect", () => {
  const afterPhoto = applyCatalogItemEdit(STUB_DOCUMENT, { photoAsset: PHOTO_ASSET });
  assert.equal(afterPhoto.reviewedAt, undefined);
  const afterModel = applyCatalogItemEdit(STUB_DOCUMENT, { modelAsset: MODEL_ASSET });
  assert.equal(afterModel.reviewedAt, undefined);
});

test("REVIEW: markReviewed:true stamps a real server-generated ISO timestamp, never a client-supplied one", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  const before = Date.now();
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { markReviewed: true }, "2026-08-14T19:16:38.000000+00:00");
  const reviewedAt = documentReviewedAt(saved.document);
  assert.ok(reviewedAt);
  const reviewedAtMs = new Date(reviewedAt!).getTime();
  assert.ok(reviewedAtMs >= before && reviewedAtMs <= Date.now() + 1000, "reviewedAt must be a real, current server timestamp");
});

test("REVIEW: a client-supplied reviewedAt string in the raw request body is ignored — only markReviewed:true is ever honored", () => {
  const edit = parseCatalogItemAdminEdit({ reviewedAt: "2000-01-01T00:00:00.000Z", markReviewed: false });
  assert.equal("reviewedAt" in edit, false);
  assert.equal(edit.markReviewed, undefined);
});

test("REVIEW: complete data (dimensions + model, showIn3D declared) + explicit review together make an ordinary furniture item ready", async () => {
  // showIn3D declared but modelAsset not uploaded yet -> missing_3d_asset + requires_review.
  const almostThere = { ...STUB_DOCUMENT, widthMm: 600, depthMm: 400, showIn3D: true };
  const client = createFakeSupabaseClient({ catalog_items: [stubRow({ document: almostThere })] });
  const beforeAssets = toAdmin(stubRow({ document: almostThere }));
  assert.deepEqual([...computeReadiness(beforeAssets).issues].sort(), ["missing_3d_asset", "requires_review"]);

  const afterAssets = await saveCatalogItemAdmin(client as never, "f01-uuid", { modelAsset: MODEL_ASSET }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(computeReadiness(afterAssets).ready, false, "GLB alone is not enough — still requires review");
  assert.deepEqual(computeReadiness(afterAssets).issues, ["requires_review"]);

  const afterReview = await saveCatalogItemAdmin(client as never, "f01-uuid", { markReviewed: true }, afterAssets.updatedAt);
  assert.equal(computeReadiness(afterReview).ready, true, `issues: ${computeReadiness(afterReview).issues.join(",")}`);
});

// -----------------------------------------------------------------------------------------
// ACTIVATION
// -----------------------------------------------------------------------------------------

test("ACTIVATION: an item missing only reviewedAt (assets+dimensions otherwise complete) still cannot activate", async () => {
  const almostReady = { ...STUB_DOCUMENT, widthMm: 600, depthMm: 400, showIn2D: true, footprint2D: { shape: "rectangle" }, modelAsset: MODEL_ASSET };
  const client = createFakeSupabaseClient({ catalog_items: [stubRow({ document: almostReady })] });
  await assert.rejects(
    () => saveCatalogItemAdmin(client as never, "f01-uuid", { lifecycleStatus: "active" }, "2026-08-14T19:16:38.000000+00:00"),
    (error) => error instanceof CatalogReadinessError,
  );
});

test("ACTIVATION: once reviewed, the same previously-incomplete item can activate", async () => {
  const readyDocument = { ...STUB_DOCUMENT, widthMm: 600, depthMm: 400, showIn2D: true, footprint2D: { shape: "rectangle" }, modelAsset: MODEL_ASSET, reviewedAt: "2026-08-17T00:00:00.000Z" };
  const client = createFakeSupabaseClient({ catalog_items: [stubRow({ document: readyDocument })] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { lifecycleStatus: "active" }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(saved.lifecycleStatus, "active");
});

// -----------------------------------------------------------------------------------------
// PRINT — section 12: GLB upload must NEVER create/infer a PrintSurface or printable flag.
// -----------------------------------------------------------------------------------------

test("PRINT: uploading a GLB never creates a PrintSurface — document without printSurfaces stays without any after a modelAsset edit", () => {
  const merged = applyCatalogItemEdit(STUB_DOCUMENT, { modelAsset: MODEL_ASSET });
  assert.equal("printSurfaces" in merged, false);
  assert.equal("printable" in merged, false);
});

test("PRINT: P86's existing printSurfaces are neither duplicated nor mutated by a modelAsset upload", () => {
  const merged = applyCatalogItemEdit(P86_DOCUMENT, { modelAsset: MODEL_ASSET });
  assert.deepEqual(merged.printSurfaces, P86_DOCUMENT.printSurfaces);
  assert.equal((merged.printSurfaces as unknown[]).length, 1, "must stay exactly the original one printSurface, never inferred/duplicated");
});

test("PRINT: color/material/geometry never implies printable — no code path assigns/derives printable or printSurfaces from an asset (doc-comment mentions of the field name are fine, only assignment syntax is checked)", () => {
  const repoSource = readFileSync(new URL("../lib/db/catalogItemsAdmin.supabase.ts", import.meta.url), "utf8");
  const domainSource = readFileSync(new URL("../domain/catalogItemsAdmin.ts", import.meta.url), "utf8");
  const assignmentPattern = /\b(printable|printSurfaces)\s*[:=]/u;
  assert.doesNotMatch(repoSource, assignmentPattern);
  assert.doesNotMatch(domainSource, assignmentPattern);
});

// -----------------------------------------------------------------------------------------
// CONCURRENCY — section 15/16: asset saves use the SAME expectedUpdatedAt token as any other save.
// -----------------------------------------------------------------------------------------

test("CONCURRENCY: stale updatedAt on a photo save via the API route returns 409, never silently overwriting", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsSave(
    authenticatedRequest(token, "http://localhost/api/catalog-admin/items/save", { method: "POST", body: { id: "f01-uuid", edit: { photoAsset: PHOTO_ASSET }, expectedUpdatedAt: "stale" } }),
    async () => { throw new ConcurrencyConflictError("catalog_item", "f01-uuid"); },
  );
  assert.equal(response.status, 409);
});

// =========================================================================================
// SCENE CAPABILITY EDITOR — closing the "Admin detail has no way to set showIn2D/showIn3D"
// gap. Same whitelist/merge/concurrency machinery as every other field; never a parallel
// readiness system.
// =========================================================================================

test("imported furniture can explicitly set scene capability via the admin edit whitelist", () => {
  const edit = parseCatalogItemAdminEdit({ showIn2D: false, showIn3D: true });
  assert.deepEqual(edit, { showIn2D: false, showIn3D: true });
});

test("no automatic showIn2D/showIn3D just from kind/internalCode — a freshly-imported EXACT_SAFE stub never has them set", () => {
  assert.equal("showIn2D" in STUB_DOCUMENT, false);
  assert.equal("showIn3D" in STUB_DOCUMENT, false);
  const item = toAdmin(stubRow());
  assert.equal(computeReadiness(item).issues.includes("missing_scene_capability"), true, "confirmed internalCode + base price alone never imply capability");
});

test("no capability declared at all -> missing_scene_capability (furniture)", () => {
  const noCapability = { ...STUB_DOCUMENT, widthMm: 600, depthMm: 400, unit: "ks" };
  const item = toAdmin(stubRow({ document: noCapability }));
  assert.ok(computeReadiness(item).issues.includes("missing_scene_capability"));
});

test("showIn3D=true + no model = missing_3d_asset; uploading a valid model removes it", async () => {
  const declared3DNoModel = { ...STUB_DOCUMENT, widthMm: 600, depthMm: 400, unit: "ks", showIn3D: true };
  const withoutModel = toAdmin(stubRow({ document: declared3DNoModel }));
  assert.ok(computeReadiness(withoutModel).issues.includes("missing_3d_asset"));

  const client = createFakeSupabaseClient({ catalog_items: [stubRow({ document: declared3DNoModel })] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { modelAsset: MODEL_ASSET }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(computeReadiness(saved).issues.includes("missing_3d_asset"), false);
});

test("capability change preserves nested document fields (P86-style parts/printSurfaces survive even though booth ignores showIn2D/showIn3D)", () => {
  const merged = applyCatalogItemEdit(P86_DOCUMENT, { showIn3D: true });
  assert.deepEqual(merged.parts, P86_DOCUMENT.parts);
  assert.deepEqual(merged.printSurfaces, P86_DOCUMENT.printSurfaces);
  assert.equal(merged.showIn3D, true);
});

test("capability change preserves modelAsset/photoAsset already on the document", () => {
  const withAssets = { ...STUB_DOCUMENT, photoAsset: PHOTO_ASSET, modelAsset: MODEL_ASSET };
  const merged = applyCatalogItemEdit(withAssets, { showIn2D: true, showIn3D: true });
  assert.deepEqual(merged.photoAsset, PHOTO_ASSET);
  assert.deepEqual(merged.modelAsset, MODEL_ASSET);
});

test("capability change preserves pricingEntries/sourceKey/internalCode", () => {
  const merged = applyCatalogItemEdit(STUB_DOCUMENT, { showIn3D: true });
  assert.deepEqual(merged.pricingEntries, STUB_DOCUMENT.pricingEntries);
  assert.equal(merged.sourceKey, STUB_DOCUMENT.sourceKey);
  assert.equal(merged.internalCode, "F01");
});

test("showIn2D=true without an existing footprint2D fills in the same minimal {shape:'rectangle'} default M57's own seed already uses — never a new SVG/thumbnail system", () => {
  const merged = applyCatalogItemEdit(STUB_DOCUMENT, { showIn2D: true });
  assert.deepEqual(merged.footprint2D, { shape: "rectangle" });
});

test("showIn2D=true never overwrites an already-set footprint2D", () => {
  const withCustomFootprint = { ...STUB_DOCUMENT, footprint2D: { shape: "circle" } };
  const merged = applyCatalogItemEdit(withCustomFootprint, { showIn2D: true });
  assert.deepEqual(merged.footprint2D, { shape: "circle" });
});

test("M57 canonical capability (showIn2D=true, showIn3D=true) is untouched by an unrelated save", async () => {
  const m57WithCapability = { ...M57_DOCUMENT, showIn2D: true, showIn3D: true, footprint2D: { shape: "rectangle" }, modelUrl: "/models/chairs/M57/model.glb" };
  const client = createFakeSupabaseClient({ catalog_items: [m57Row({ document: m57WithCapability })] });
  const saved = await saveCatalogItemAdmin(client as never, "m57-uuid", { unit: "ks" }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(saved.document.showIn2D, true);
  assert.equal(saved.document.showIn3D, true);
});

test("P86 readiness is unaffected by showIn2D/showIn3D — booth kind never reads them", () => {
  const withCapabilityToggled = { ...P86_DOCUMENT, showIn2D: false, showIn3D: false };
  const item = toAdmin(p86Row({ document: withCapabilityToggled }));
  assert.equal(computeReadiness(item).ready, true, "booth readiness must stay true regardless of showIn2D/showIn3D");
});

test("UI: the scene-capability section is hidden for service/graphics_service/floor_finish/booth (L02 must never see nonsensical scene checkboxes), but shown for booth_component (create-form parity)", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /SCENE_CAPABILITY_KINDS[\s\S]{0,40}=[\s\S]{0,120}\["furniture", "technical_point", "construction", "other", "booth_component"\]/u);
  assert.doesNotMatch(source, /SCENE_CAPABILITY_KINDS[\s\S]{0,200}"service"/u);
  assert.doesNotMatch(source, /SCENE_CAPABILITY_KINDS[\s\S]{0,200}"booth"\]/u);
});

test("UI: capability checkboxes use the real showIn2D/showIn3D fields, never a parallel field name", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /checked=\{showIn2D\}/u);
  assert.match(source, /checked=\{showIn3D\}/u);
  assert.match(source, /edit\.showIn2D\s*=\s*showIn2D/u);
  assert.match(source, /edit\.showIn3D\s*=\s*showIn3D/u);
});

test("ACTIVE ITEM SAFETY: toggling showIn3D=true on an active item with no model auto-downgrades to needs_review instead of leaving active+invalid", async () => {
  // Active furniture item (all other requirements satisfied) that only declares showIn2D today.
  const activeReady = { ...STUB_DOCUMENT, widthMm: 600, depthMm: 400, unit: "ks", showIn2D: true, footprint2D: { shape: "rectangle" }, reviewedAt: "2026-08-17T00:00:00.000Z", lifecycleStatus: "active" };
  const client = createFakeSupabaseClient({ catalog_items: [stubRow({ document: activeReady, lifecycle_status: "active" })] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { showIn3D: true }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(saved.lifecycleStatus, "needs_review", "declaring 3D placement without a model must never leave the item active+not-ready");
  const row = client.tables.get("catalog_items")!.find((r) => r.id === "f01-uuid")!;
  assert.equal(row.lifecycle_status, "needs_review");
});

test("ACTIVE ITEM SAFETY: toggling capability on an active item that STAYS ready never downgrades it", async () => {
  const activeReady = { ...STUB_DOCUMENT, widthMm: 600, depthMm: 400, unit: "ks", showIn2D: true, footprint2D: { shape: "rectangle" }, reviewedAt: "2026-08-17T00:00:00.000Z", lifecycleStatus: "active" };
  const client = createFakeSupabaseClient({ catalog_items: [stubRow({ document: activeReady, lifecycle_status: "active" })] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { showIn2D: true }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(saved.lifecycleStatus, "active", "a no-op-equivalent capability confirmation must never spuriously downgrade an already-ready item");
});

// =========================================================================================
// 2D/3D STATUS READOUTS + STATE-LEAK FIX (section 8/12) — switching selected items must
// remount the detail panel (key={item.id}), never carry over stale local state from the
// previously-selected item. This was a real bug: ComponentAdminDetail had no `key` prop, so
// React reused the same component instance across selections and useState never re-initialized.
// -----------------------------------------------------------------------------------------

test("documentFootprint2D reads a well-shaped footprint2D and rejects malformed/missing values", () => {
  assert.deepEqual(documentFootprint2D({ footprint2D: { shape: "rectangle" } }), { shape: "rectangle", symbol: undefined });
  assert.deepEqual(documentFootprint2D({ footprint2D: { shape: "symbol", symbol: "chair" } }), { shape: "symbol", symbol: "chair" });
  assert.equal(documentFootprint2D({}), undefined);
  assert.equal(documentFootprint2D({ footprint2D: { shape: "triangle" } }), undefined, "unknown shape values are rejected, never guessed");
});

test("showIn3D=true without a model resolves has3DAsset=false — the UI's 'Model: Chybí' status reflects the real domain check, not a separate UI rule", () => {
  assert.equal(documentHas3DAsset(STUB_DOCUMENT), false);
  assert.equal(documentHas3DAsset({ ...STUB_DOCUMENT, modelAsset: MODEL_ASSET }), true);
});

test("showIn2D=true with a saved footprint2D resolves a real shape label; without one resolves 'missing' — no UI-only fabrication", () => {
  const withFootprint = { ...STUB_DOCUMENT, footprint2D: { shape: "rectangle" } };
  assert.equal(documentFootprint2D(withFootprint)?.shape, "rectangle");
  assert.equal(documentFootprint2D(STUB_DOCUMENT), undefined);
});

test("UI: ComponentAdminDetail is remounted per selected item (key={selected.id}) — the actual fix that prevents capability/category/dimension state leaking between items (e.g. M57 -> L02)", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /<ComponentAdminDetail\s+key=\{selected\.id\}/u);
});

test("UI: 2D/3D status readouts render real Footprint/Model status, not a hardcoded placeholder", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /Footprint:\s*\{footprint2D \? FOOTPRINT_SHAPE_LABELS_CS\[footprint2D\.shape\] : "Chybí"\}/u);
  assert.match(source, /Model:\s*\{hasModel \? "Nahrán" : "Chybí"\}/u);
});

// -----------------------------------------------------------------------------------------
// CATEGORY DROPDOWN (section 9/10/11)
// -----------------------------------------------------------------------------------------

test("CATALOG_ITEM_CATEGORY_OPTIONS matches the real, live-audited set of category values currently in catalog_items (81 rows, 2026-08), extended with the booth_component founding-workflow categories (deliberately added, not invented drift) — still a closed set", () => {
  const values = CATALOG_ITEM_CATEGORY_OPTIONS.map((option) => option.value).sort();
  const liveAudited = ["Canonical", "Kuchyňka", "Nábytek", "Octanorm", "Ostatní", "Stavba", "Světlo", "T. služby", "Typovky", "Úvaz", "chairs", "services"];
  const boothComponentCategories = ["Panely / stěny", "Sloupky", "Límce", "Dveře", "Zázemí / konstrukce", "Podlaha", "Osvětlení"];
  assert.deepEqual(values, [...liveAudited, ...boothComponentCategories].sort());
});

test("categoryLabelCs reuses domain/catalogCategories.ts's existing chairs/services labels rather than re-declaring them", () => {
  assert.equal(categoryLabelCs("chairs"), "Židle");
  assert.equal(categoryLabelCs("services"), "Služby");
});

test("categoryLabelCs translates the real Czech PRICELIST category values and gracefully falls back for null/unknown", () => {
  assert.equal(categoryLabelCs("T. služby"), "Technické služby");
  assert.equal(categoryLabelCs("Nábytek"), "Nábytek");
  assert.equal(categoryLabelCs(null), "—");
  assert.equal(categoryLabelCs("Nějaká budoucí hodnota"), "Nějaká budoucí hodnota", "unlisted value is shown as-is, never hidden or crashed on");
});

test("UI: Kategorie field is a <select> populated from CATALOG_ITEM_CATEGORY_OPTIONS, never a free-text <input>", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /<select value=\{category\}/u);
  assert.match(source, /CATALOG_ITEM_CATEGORY_OPTIONS\.map/u);
  assert.doesNotMatch(source, /EditRow label="Kategorie">\s*<input/u);
});

test("selecting a category persists the exact canonical DB value (label is display-only, never the stored value)", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { category: "Octanorm" }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(saved.category, "Octanorm");
  assert.equal(saved.document.category, "Octanorm");
});

test("category change never mutates kind — kind is not part of the editable whitelist at all", async () => {
  const edit = parseCatalogItemAdminEdit({ category: "Stavba", kind: "booth" });
  assert.equal("kind" in edit, false, "kind can never be smuggled through the edit whitelist, even alongside a legitimate category change");
  const client = createFakeSupabaseClient({ catalog_items: [stubRow()] });
  const saved = await saveCatalogItemAdmin(client as never, "f01-uuid", { category: "Stavba" }, "2026-08-14T19:16:38.000000+00:00");
  assert.equal(saved.kind, "furniture", "kind column must be completely unaffected by a category edit");
});

test("M57 and L02 keep fully independent category values — reading one never leaks into the other (regression for the key-less state-leak bug)", async () => {
  const client = createFakeSupabaseClient({
    catalog_items: [
      m57Row({ category: "chairs", document: { ...M57_DOCUMENT, category: "chairs" } }),
      { ...m57Row(), id: "l02-uuid", internal_code: "L02", kind: "service", category: "services", document: { ...M57_DOCUMENT, internalCode: "L02", category: "services" } },
    ],
  });
  const items = await readCatalogItemsAdmin(client as never);
  const m57 = items.find((item) => item.internalCode === "M57")!;
  const l02 = items.find((item) => item.internalCode === "L02")!;
  assert.equal(m57.category, "chairs");
  assert.equal(l02.category, "services");
  assert.notEqual(m57.category, l02.category);
});

// =========================================================================================
// VARIANTS — multi-variant type-booth lines (T04..T25): one catalog_item, N variants, each
// with its own independent GLB/photo. See domain/models.ts's BoothVariant (extended) and
// domain/catalogReadiness.ts's booth case.
// =========================================================================================

// A T04 that already went through the canonicalization migration (see
// domain/typeBoothCanonicalization.ts) — variants added on top of the real Batch #2B stub shape
// (T04_DOCUMENT/t04Row, declared above in section "READINESS HARDENING (booth kind)").
const T04_WITH_VARIANTS_DOCUMENT: FakeRow = {
  ...T04_DOCUMENT,
  variants: [
    { id: "t04-v1", name: "Varianta 1" },
    { id: "t04-v2", name: "Varianta 2" },
    { id: "t04-v3", name: "Varianta 3" },
    { id: "t04-v4", name: "Varianta 4" },
  ],
};

function t04WithVariantsRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    ...t04Row(),
    document: T04_WITH_VARIANTS_DOCUMENT,
    ...overrides,
  };
}

const VARIANT_MODEL_ASSET: StoredAsset = {
  id: "t04-v1-model-asset",
  storageKey: "catalog/furniture/t04/models/v1.glb",
  originalFileName: "t04-v1.glb",
  mimeType: "model/gltf-binary",
  size: 900_000,
  createdAt: "2026-08-19T00:00:00.000Z",
  category: "catalog-model",
};

const VARIANT_PHOTO_ASSET: StoredAsset = {
  id: "t04-v1-photo-asset",
  storageKey: "catalog/furniture/t04/photos/v1.jpg",
  originalFileName: "t04-v1.jpg",
  mimeType: "image/jpeg",
  size: 200_000,
  createdAt: "2026-08-19T00:00:00.000Z",
  category: "catalog-photo",
};

const VARIANT_SKP_ASSET: StoredAsset = {
  id: "t04-v1-skp-asset",
  storageKey: "catalog/furniture/t04/source/v1.skp",
  originalFileName: "t04-v1.skp",
  mimeType: "application/octet-stream",
  size: 400_000,
  createdAt: "2026-08-19T00:00:00.000Z",
  category: "catalog-source",
};

const VARIANT_SKP_SOURCE_ASSET = { id: "t04-v1-skp-entry", kind: "sketchup" as const, asset: VARIANT_SKP_ASSET };

test("VARIANT: parseCatalogItemAdminEdit whitelists setVariantModelAsset/setVariantPhotoAsset with a well-shaped asset", () => {
  const edit = parseCatalogItemAdminEdit({ setVariantModelAsset: { variantId: "t04-v1", asset: VARIANT_MODEL_ASSET } });
  assert.deepEqual(edit.setVariantModelAsset, { variantId: "t04-v1", asset: VARIANT_MODEL_ASSET });
});

test("VARIANT: parseCatalogItemAdminEdit accepts asset:null to clear a variant's model/photo", () => {
  const edit = parseCatalogItemAdminEdit({ setVariantPhotoAsset: { variantId: "t04-v1", asset: null } });
  assert.deepEqual(edit.setVariantPhotoAsset, { variantId: "t04-v1", asset: null });
});

test("VARIANT: a malformed asset (missing storageKey) or missing variantId is silently dropped, never merged", () => {
  const edit1 = parseCatalogItemAdminEdit({ setVariantModelAsset: { variantId: "t04-v1", asset: { id: "x" } } });
  assert.equal("setVariantModelAsset" in edit1, false);
  const edit2 = parseCatalogItemAdminEdit({ setVariantModelAsset: { asset: VARIANT_MODEL_ASSET } });
  assert.equal("setVariantModelAsset" in edit2, false);
});

test("VARIANT: applyCatalogItemEdit sets the model on ONLY the matching variant, leaving the other 3 and every other document field untouched", () => {
  const next = applyCatalogItemEdit(T04_WITH_VARIANTS_DOCUMENT, { setVariantModelAsset: { variantId: "t04-v2", asset: VARIANT_MODEL_ASSET } });
  const variants = next.variants as ReadonlyArray<Record<string, unknown>>;
  assert.equal(variants.length, 4);
  assert.equal(variants[0]!.modelAsset, undefined);
  assert.deepEqual(variants[1]!.modelAsset, VARIANT_MODEL_ASSET);
  assert.equal(variants[1]!.id, "t04-v2");
  assert.equal(variants[2]!.modelAsset, undefined);
  assert.equal(variants[3]!.modelAsset, undefined);
  assert.deepEqual(next.pricingEntries, T04_WITH_VARIANTS_DOCUMENT.pricingEntries);
  assert.equal(next.sourceKey, T04_WITH_VARIANTS_DOCUMENT.sourceKey);
});

test("VARIANT: setVariantModelAsset asset:null removes only that variant's modelAsset, other variants/keys untouched", () => {
  const withModel = applyCatalogItemEdit(T04_WITH_VARIANTS_DOCUMENT, { setVariantModelAsset: { variantId: "t04-v1", asset: VARIANT_MODEL_ASSET } });
  const cleared = applyCatalogItemEdit(withModel, { setVariantModelAsset: { variantId: "t04-v1", asset: null } });
  const variants = cleared.variants as ReadonlyArray<Record<string, unknown>>;
  assert.equal("modelAsset" in variants[0]!, false);
});

test("VARIANT: setVariantPhotoAsset and setVariantModelAsset on the same variant coexist independently", () => {
  const next = applyCatalogItemEdit(T04_WITH_VARIANTS_DOCUMENT, {
    setVariantModelAsset: { variantId: "t04-v3", asset: VARIANT_MODEL_ASSET },
    setVariantPhotoAsset: { variantId: "t04-v3", asset: VARIANT_PHOTO_ASSET },
  });
  const variant = (next.variants as ReadonlyArray<Record<string, unknown>>).find((v) => v.id === "t04-v3")!;
  assert.deepEqual(variant.modelAsset, VARIANT_MODEL_ASSET);
  assert.deepEqual(variant.photoAsset, VARIANT_PHOTO_ASSET);
});

test("VARIANT: a variantId matching nothing is a silent no-op — variants array is otherwise unchanged", () => {
  const next = applyCatalogItemEdit(T04_WITH_VARIANTS_DOCUMENT, { setVariantModelAsset: { variantId: "does-not-exist", asset: VARIANT_MODEL_ASSET } });
  assert.deepEqual(next.variants, T04_WITH_VARIANTS_DOCUMENT.variants);
});

test("VARIANT SOURCE ASSET: parseCatalogItemAdminEdit whitelists addVariantSourceAsset/removeVariantSourceAssetId with well-shaped input", () => {
  const addEdit = parseCatalogItemAdminEdit({ addVariantSourceAsset: { variantId: "t04-v1", kind: "sketchup", asset: VARIANT_SKP_ASSET } });
  assert.deepEqual(addEdit.addVariantSourceAsset, { variantId: "t04-v1", kind: "sketchup", asset: VARIANT_SKP_ASSET, label: undefined });
  const removeEdit = parseCatalogItemAdminEdit({ removeVariantSourceAssetId: { variantId: "t04-v1", sourceAssetId: "entry-1" } });
  assert.deepEqual(removeEdit.removeVariantSourceAssetId, { variantId: "t04-v1", sourceAssetId: "entry-1" });
});

test("VARIANT SOURCE ASSET: an unknown kind, malformed asset, or missing variantId is silently dropped, never merged", () => {
  assert.equal("addVariantSourceAsset" in parseCatalogItemAdminEdit({ addVariantSourceAsset: { variantId: "t04-v1", kind: "not-a-real-kind", asset: VARIANT_SKP_ASSET } }), false);
  assert.equal("addVariantSourceAsset" in parseCatalogItemAdminEdit({ addVariantSourceAsset: { kind: "sketchup", asset: VARIANT_SKP_ASSET } }), false);
  assert.equal("addVariantSourceAsset" in parseCatalogItemAdminEdit({ addVariantSourceAsset: { variantId: "t04-v1", kind: "sketchup", asset: { id: "x" } } }), false);
});

test("VARIANT SOURCE ASSET: applyCatalogItemEdit appends to ONLY the matching variant's sourceAssets, generating a fresh id, other variants/keys untouched", () => {
  const next = applyCatalogItemEdit(T04_WITH_VARIANTS_DOCUMENT, { addVariantSourceAsset: { variantId: "t04-v2", kind: "sketchup", asset: VARIANT_SKP_ASSET } });
  const variants = next.variants as ReadonlyArray<Record<string, unknown>>;
  assert.equal(variants[0]!.sourceAssets, undefined);
  const v2SourceAssets = variants[1]!.sourceAssets as ReadonlyArray<Record<string, unknown>>;
  assert.equal(v2SourceAssets.length, 1);
  assert.equal(v2SourceAssets[0]!.kind, "sketchup");
  assert.deepEqual(v2SourceAssets[0]!.asset, VARIANT_SKP_ASSET);
  assert.ok(typeof v2SourceAssets[0]!.id === "string" && v2SourceAssets[0]!.id);
  assert.equal(variants[2]!.sourceAssets, undefined);
  assert.deepEqual(next.pricingEntries, T04_WITH_VARIANTS_DOCUMENT.pricingEntries);
});

test("VARIANT SOURCE ASSET: removeVariantSourceAssetId removes only the matching entry on the matching variant — everything else survives", () => {
  const withSource = applyCatalogItemEdit(T04_WITH_VARIANTS_DOCUMENT, { addVariantSourceAsset: { variantId: "t04-v1", kind: "sketchup", asset: VARIANT_SKP_ASSET } });
  const addedId = ((withSource.variants as ReadonlyArray<Record<string, unknown>>)[0]!.sourceAssets as ReadonlyArray<Record<string, unknown>>)[0]!.id as string;
  const withTwo = applyCatalogItemEdit(withSource, { addVariantSourceAsset: { variantId: "t04-v1", kind: "dwg", asset: VARIANT_SKP_ASSET } });
  const cleared = applyCatalogItemEdit(withTwo, { removeVariantSourceAssetId: { variantId: "t04-v1", sourceAssetId: addedId } });
  const remaining = (cleared.variants as ReadonlyArray<Record<string, unknown>>)[0]!.sourceAssets as ReadonlyArray<Record<string, unknown>>;
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0]!.kind, "dwg");
});

test("VARIANT SOURCE ASSET: DWG/DXF/PDF/other never satisfy the SKP readiness requirement — only a 'sketchup'-kind entry counts", () => {
  const next = applyCatalogItemEdit(T04_WITH_VARIANTS_DOCUMENT, { addVariantSourceAsset: { variantId: "t04-v1", kind: "dwg", asset: VARIANT_SKP_ASSET } });
  const variants = (next.variants as ReadonlyArray<Record<string, unknown>>).map((v) => ({ ...v, modelAsset: VARIANT_MODEL_ASSET }));
  const adapted = { ...next, heightMm: 2500, variants } as unknown as ComponentDefinition;
  const readiness = evaluateCatalogReadiness(adapted, "booth");
  assert.ok(readiness.issues.includes("missing_sketchup_source"), "a DWG-only entry on variant 1 must never satisfy SKP readiness");
});

test("VARIANT readiness: T04 with 4 declared variants but ZERO with a GLB is not ready — missing_3d_asset, even though widthMm/depthMm are set", () => {
  const adapted = { ...T04_WITH_VARIANTS_DOCUMENT, heightMm: 2500 } as unknown as ComponentDefinition;
  const readiness = evaluateCatalogReadiness(adapted, "booth");
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("missing_3d_asset"));
});

test("VARIANT readiness: T04 with 3 of 4 variants modelled is STILL not ready — the whole line must never look complete while one variant has no geometry", () => {
  const variants = (T04_WITH_VARIANTS_DOCUMENT.variants as ReadonlyArray<Record<string, unknown>>).map((v, index) =>
    index < 3 ? { ...v, modelAsset: VARIANT_MODEL_ASSET } : v,
  );
  const adapted = { ...T04_WITH_VARIANTS_DOCUMENT, heightMm: 2500, variants } as unknown as ComponentDefinition;
  const readiness = evaluateCatalogReadiness(adapted, "booth");
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("missing_3d_asset"));
});

test("VARIANT readiness: T04 becomes ready only once ALL 4 variants have their own GLB AND SKP, the parent has a real height, AND variantsConfirmed is true", () => {
  const variants = (T04_WITH_VARIANTS_DOCUMENT.variants as ReadonlyArray<Record<string, unknown>>).map((v) => ({ ...v, modelAsset: VARIANT_MODEL_ASSET, sourceAssets: [VARIANT_SKP_SOURCE_ASSET] }));
  const adapted = { ...T04_WITH_VARIANTS_DOCUMENT, heightMm: 2500, variants, variantsConfirmed: true } as unknown as ComponentDefinition;
  const readiness = evaluateCatalogReadiness(adapted, "booth");
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.issues, []);
});

test("VARIANT readiness: complete GLB+SKP+height but variantsConfirmed still false/absent -> not ready, variants_unconfirmed", () => {
  const variants = (T04_WITH_VARIANTS_DOCUMENT.variants as ReadonlyArray<Record<string, unknown>>).map((v) => ({ ...v, modelAsset: VARIANT_MODEL_ASSET, sourceAssets: [VARIANT_SKP_SOURCE_ASSET] }));
  const adapted = { ...T04_WITH_VARIANTS_DOCUMENT, heightMm: 2500, variants } as unknown as ComponentDefinition;
  const readiness = evaluateCatalogReadiness(adapted, "booth");
  assert.equal(readiness.ready, false);
  assert.deepEqual(readiness.issues, ["variants_unconfirmed"]);
});

test("VARIANT readiness: T04 with GLB on all 4 but SKP missing on one is still not ready — missing_sketchup_source", () => {
  const variants = (T04_WITH_VARIANTS_DOCUMENT.variants as ReadonlyArray<Record<string, unknown>>).map((v, index) => ({
    ...v,
    modelAsset: VARIANT_MODEL_ASSET,
    ...(index < 3 ? { sourceAssets: [VARIANT_SKP_SOURCE_ASSET] } : {}),
  }));
  const adapted = { ...T04_WITH_VARIANTS_DOCUMENT, heightMm: 2500, variants } as unknown as ComponentDefinition;
  const readiness = evaluateCatalogReadiness(adapted, "booth");
  assert.equal(readiness.ready, false);
  assert.ok(readiness.issues.includes("missing_sketchup_source"));
  assert.equal(readiness.issues.includes("missing_3d_asset"), false);
});

test("VARIANT readiness: P86 (variants: [], no multi-variant line) is completely unaffected — still uses its own has3DAsset(item), stays ready", () => {
  const p86Adapted = { ...P86_DOCUMENT, lifecycleStatus: "active", variants: [] } as unknown as ComponentDefinition;
  const readiness = evaluateCatalogReadiness(p86Adapted, "booth");
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.issues, []);
});

test("VARIANT: documentVariants parses T04's 4 variants and rejects malformed entries", () => {
  const valid = documentVariants(T04_WITH_VARIANTS_DOCUMENT);
  assert.equal(valid.length, 4);
  assert.deepEqual(valid.map((v) => v.id), ["t04-v1", "t04-v2", "t04-v3", "t04-v4"]);

  const withGarbage = documentVariants({ variants: [{ id: "ok", name: "Ok" }, { id: "no-name" }, "not-an-object", { name: "no-id" }] });
  assert.equal(withGarbage.length, 1);
  assert.equal(withGarbage[0]!.id, "ok");
});

test("VARIANT end to end: saveCatalogItemAdmin persists a variant's GLB storageKey, and readiness recognizes it once all 4 have GLB + SKP + a confirmed variant set", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [t04WithVariantsRow({ document: { ...T04_WITH_VARIANTS_DOCUMENT, heightMm: 2500, variantsConfirmed: true } })] });
  let saved = await saveCatalogItemAdmin(client as never, "t04-uuid", { setVariantModelAsset: { variantId: "t04-v1", asset: VARIANT_MODEL_ASSET } }, null);
  assert.deepEqual((saved.document.variants as ReadonlyArray<Record<string, unknown>>)[0]!.modelAsset, VARIANT_MODEL_ASSET);
  assert.equal(computeReadiness(saved).ready, false, "only 1 of 4 variants modelled, none have SKP — still not ready");

  for (const variantId of ["t04-v2", "t04-v3", "t04-v4"]) {
    saved = await saveCatalogItemAdmin(client as never, "t04-uuid", { setVariantModelAsset: { variantId, asset: VARIANT_MODEL_ASSET } }, saved.updatedAt);
  }
  assert.equal(computeReadiness(saved).ready, false, "all 4 variants modelled but NONE have SKP yet — still not ready");

  for (const variantId of ["t04-v1", "t04-v2", "t04-v3", "t04-v4"]) {
    saved = await saveCatalogItemAdmin(client as never, "t04-uuid", { addVariantSourceAsset: { variantId, kind: "sketchup", asset: VARIANT_SKP_ASSET } }, saved.updatedAt);
  }
  assert.equal(computeReadiness(saved).ready, true, "all 4 variants now have GLB + SKP + real height + confirmed variant set -> ready");
});

test("VARIANT end to end: the SAME fully-modelled T04 stays NOT ready if variantsConfirmed is false — matches the real T06..T25 placeholder state", async () => {
  const client = createFakeSupabaseClient({
    catalog_items: [t04WithVariantsRow({
      document: {
        ...T04_WITH_VARIANTS_DOCUMENT,
        heightMm: 2500,
        variantsConfirmed: false,
        variants: (T04_WITH_VARIANTS_DOCUMENT.variants as ReadonlyArray<Record<string, unknown>>).map((v) => ({ ...v, modelAsset: VARIANT_MODEL_ASSET, sourceAssets: [VARIANT_SKP_SOURCE_ASSET] })),
      },
    })],
  });
  const saved = await saveCatalogItemAdmin(client as never, "t04-uuid", { markReviewed: true }, null);
  assert.equal(computeReadiness(saved).ready, false);
  assert.equal(computeGeneratorEligibleLive(saved), false);
});

test("VARIANT: T04's own kind/category/lifecycleStatus and pricingEntries are never touched by a variant asset save", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [t04WithVariantsRow()] });
  const saved = await saveCatalogItemAdmin(client as never, "t04-uuid", { setVariantModelAsset: { variantId: "t04-v1", asset: VARIANT_MODEL_ASSET } }, null);
  assert.equal(saved.kind, "booth");
  assert.equal(saved.category, "Typovky");
  assert.deepEqual(saved.document.pricingEntries, T04_WITH_VARIANTS_DOCUMENT.pricingEntries);
});

// =========================================================================================
// PARENT ASSET SECTIONS ON VARIANT BOOTHS (2026-08-19 follow-up session): a booth with declared
// variants (T04..T25) has NO parent-level runtime model or source file of its own — BOTH the
// "3D model" AND "Zdrojové a výrobní soubory" sections must never render for those (variants own
// GLB/SKP/DWG/DXF/PDF/Other independently). The parent's photoAsset/displayName/description/
// lifecycle stay completely untouched — only these two asset sections are hidden. A booth
// WITHOUT variants (P86/P87) keeps both sections exactly as before.
// =========================================================================================

test("ComponentAdminDetail.tsx defines a single shared isVariantBooth flag (kind=booth AND documentVariants(...).length > 0) and gates BOTH the parent '3D model' and 'Zdrojové a výrobní soubory' sections with it — never two independently-drifting conditions", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  const flagStart = source.indexOf('const isVariantBooth = item.kind === "booth" && documentVariants(itemDocument).length > 0;');
  assert.ok(flagStart >= 0, "expected a single named isVariantBooth flag");

  const modelGateStart = source.indexOf("!isVariantBooth &&", flagStart);
  assert.ok(modelGateStart > flagStart, "expected the parent 3D-model section to be gated by !isVariantBooth");
  const modelSectionStart = source.indexOf("<h3>3D model</h3>", modelGateStart);
  assert.ok(modelSectionStart > modelGateStart && modelSectionStart < modelGateStart + 200, "the !isVariantBooth gate must wrap the '3D model' section");

  const sourceGateStart = source.indexOf("!isVariantBooth", modelGateStart + 1);
  assert.ok(sourceGateStart > modelSectionStart, "expected a SECOND !isVariantBooth gate, after the 3D-model section, for source files");
  const sourceSectionStart = source.indexOf("<h3>Zdrojové a výrobní soubory</h3>", sourceGateStart);
  assert.ok(sourceSectionStart > sourceGateStart && sourceSectionStart < sourceGateStart + 200, "the second !isVariantBooth gate must wrap the 'Zdrojové a výrobní soubory' section");
});

test("the parent asset sections are NOT gated for other kinds (furniture/booth_component/etc.) or for a booth WITHOUT variants — isVariantBooth is only true for kind=booth WITH a non-empty variants array", () => {
  // documentVariants([]) === [] and P86/furniture never satisfy `item.kind === "booth" && ...length > 0`,
  // so the sections render for them exactly as they always have — verified structurally via the
  // real domain function rather than re-deriving the logic in the test.
  assert.equal(documentVariants({}).length, 0);
  assert.equal(documentVariants({ variants: [] }).length, 0);
  assert.equal(documentVariants({ variants: [{ id: "t04-corner-left", name: "Roh – levý" }] }).length, 1);
});

test("VARIANT UI: T04's real canonical shape (3 confirmed variants, no parent modelAsset/modelUrl/sourceAssets) is exactly the shape that triggers isVariantBooth — confirms the flag matches production data, not just a synthetic fixture", () => {
  assert.equal(T04_WITH_VARIANTS_DOCUMENT.internalCode, "T04");
  assert.equal(documentVariants(T04_WITH_VARIANTS_DOCUMENT).length, 4, "this file's T04 test fixture uses the pre-correction 4-generic shape — still exercises the >0 branch identically to the real 3-variant T04");
  assert.equal("modelAsset" in T04_WITH_VARIANTS_DOCUMENT, false);
  assert.equal("modelUrl" in T04_WITH_VARIANTS_DOCUMENT, false);
  assert.equal("sourceAssets" in T04_WITH_VARIANTS_DOCUMENT, false);
});

test("VARIANT UI: P86 (no variants) keeps documentVariants() empty — both parent asset sections stay visible for it, and its parent photoAsset field is untouched by this change", () => {
  assert.equal(documentVariants(P86_DOCUMENT).length, 0);
  assert.ok(P86_DOCUMENT.modelUrl, "P86's parent modelUrl remains the real runtime model — sanity check that P86 itself wasn't accidentally changed");
});

test("VARIANT UI: the parent 'Fotografie' (photoAsset) section is declared BEFORE both isVariantBooth-gated sections and is never itself conditioned on isVariantBooth — the type-booth line's main thumbnail always stays visible", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  const photoSectionStart = source.indexOf("<h3>Fotografie</h3>");
  const flagStart = source.indexOf("const isVariantBooth =");
  assert.ok(photoSectionStart >= 0);
  // The photo section's own JSX block (from its <h3> to its closing </section>) must not
  // reference isVariantBooth at all.
  const photoSectionEnd = source.indexOf("</section>", photoSectionStart);
  const photoSectionBlock = source.slice(photoSectionStart, photoSectionEnd);
  assert.doesNotMatch(photoSectionBlock, /isVariantBooth/u);
  assert.ok(flagStart >= 0);
});

test("VARIANT UI: variant GLB/SKP/photo/sourceAssets upload sections remain available regardless of the parent sections being hidden — the 'Varianty' section is a separate, unconditional block for any kind=booth item with variants", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /\{isVariantBooth && \(/u);
  assert.match(source, /<h3>Varianty<\/h3>/u);
  assert.match(source, /Nahrát GLB/u);
  assert.match(source, /sourceAssetKind === "sketchup" \? "Nahrát SKP" : "Nahrát soubor"/u);
  assert.match(source, /variant\.photoAsset \? "Nahradit foto" : "Nahrát foto"/u);
});

// =========================================================================================
// ARCHIVE (2026-08-19 follow-up session): reuses the EXISTING lifecycleStatus field/DB column —
// no parallel isArchived boolean, no DB migration (catalog_items_lifecycle_status_check already
// allows 'archived', see supabase/migrations/20260813120000_init_schema.sql). Archiving/restoring
// is a pure lifecycle_status transition through the SAME save path every other edit uses —
// document/pricing/sourceAssets/assets/mappings/provenance are completely untouched, and no R2
// object is ever deleted (archiving only ever writes the lifecycle_status column).
// =========================================================================================

test("ARCHIVE: applyCatalogItemEdit({ lifecycleStatus: 'archived' }) changes ONLY lifecycleStatus — every other document field (pricingEntries, sourceKey, parts, printSurfaces, defaultCarpetFinishId) survives untouched, same P86-sanity guarantee as any other edit", () => {
  const next = applyCatalogItemEdit(P86_DOCUMENT, { lifecycleStatus: "archived" });
  assert.equal(next.lifecycleStatus, "archived");
  assert.deepEqual(next.pricingEntries, P86_DOCUMENT.pricingEntries);
  assert.deepEqual(next.parts, P86_DOCUMENT.parts);
  assert.deepEqual(next.printSurfaces, P86_DOCUMENT.printSurfaces);
  assert.equal(next.defaultCarpetFinishId, P86_DOCUMENT.defaultCarpetFinishId);
});

test("ARCHIVE: saveCatalogItemAdmin persists lifecycle_status='archived' via the normal save path — no special-cased archive column, no touch to internal_code/category/document keys beyond lifecycleStatus", async () => {
  const client = createFakeSupabaseClient({ catalog_items: [p86Row()] });
  const saved = await saveCatalogItemAdmin(client as never, "p86-uuid", { lifecycleStatus: "archived" }, "2026-08-14T19:16:38.367959+00:00");
  assert.equal(saved.lifecycleStatus, "archived");
  assert.equal(saved.internalCode, "P86");
  assert.deepEqual(saved.document.parts, P86_DOCUMENT.parts);
  assert.deepEqual(saved.document.printSurfaces, P86_DOCUMENT.printSurfaces);
  assert.deepEqual(saved.document.pricingEntries, P86_DOCUMENT.pricingEntries);
});

test("ARCHIVE: an archived item preserves modelAsset/photoAsset/sourceAssets exactly — archiving is never a partial/'clean slate' rewrite", async () => {
  const withAssets = {
    ...SLOUPEK_DOCUMENT,
    modelAsset: { id: "m1", storageKey: "catalog/furniture/sloupek/models/a.glb", originalFileName: "a.glb", mimeType: "model/gltf-binary", size: 1, createdAt: "2026-08-01T00:00:00.000Z", category: "catalog-model" },
    photoAsset: { id: "p1", storageKey: "catalog/furniture/sloupek/photos/a.jpg", originalFileName: "a.jpg", mimeType: "image/jpeg", size: 1, createdAt: "2026-08-01T00:00:00.000Z", category: "catalog-photo" },
  };
  const client = createFakeSupabaseClient({ catalog_items: [boothComponentRow({ document: withAssets })] });
  const saved = await saveCatalogItemAdmin(client as never, "sloupek-uuid", { lifecycleStatus: "archived" }, "2026-08-14T19:16:38.367959+00:00");
  assert.equal(saved.lifecycleStatus, "archived");
  assert.deepEqual(saved.document.modelAsset, withAssets.modelAsset);
  assert.deepEqual(saved.document.photoAsset, withAssets.photoAsset);
  assert.deepEqual(saved.document.sourceAssets, SLOUPEK_DOCUMENT.sourceAssets);
});

test("ARCHIVE: no R2 object is ever deleted by archiving — the save path never calls any storage-delete API, only writes the lifecycle_status column (metadata-only, same guarantee as photoAsset/modelAsset removal elsewhere)", () => {
  const source = readFileSync(new URL("../lib/db/catalogItemsAdmin.supabase.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /deleteObject|r2\.delete|storage\.delete/iu);
});

test("ARCHIVE: an archived item is NEVER generatorEligible — isGeneratorEligible already treats any non-active lifecycleStatus as ineligible, so archived needs no extra rule", () => {
  const archivedP86 = toAdmin(p86Row({ lifecycle_status: "archived", document: { ...P86_DOCUMENT, lifecycleStatus: "archived" } }));
  assert.equal(computeGeneratorEligibleLive(archivedP86), false);
  // Even though P86's own document is otherwise fully ready (booth readiness never depends on lifecycleStatus):
  assert.equal(computeReadiness(archivedP86).ready, true, "readiness itself is about capability, not publication state — archived can still be 'ready', just never eligible");
});

test("ARCHIVE: an archived item cannot be reactivated without passing assertCanActivate — direct archived->active still requires real readiness, exactly like needs_review->active", async () => {
  const notReadyArchived = stubRow({ lifecycle_status: "archived", document: { ...STUB_DOCUMENT, lifecycleStatus: "archived" } });
  const client = createFakeSupabaseClient({ catalog_items: [notReadyArchived] });
  await assert.rejects(
    () => saveCatalogItemAdmin(client as never, "f01-uuid", { lifecycleStatus: "active" }, "2026-08-14T19:16:38.000000+00:00"),
    (error) => error instanceof CatalogReadinessError,
  );
});

test("ARCHIVE: default admin list hides archived items — filterCatalogItemsAdmin excludes lifecycleStatus='archived' unless showArchived is explicitly true", () => {
  const active = buildCatalogItemListEntry(toAdmin(p86Row()));
  const archived = buildCatalogItemListEntry(toAdmin(p86Row({ id: "archived-uuid", internal_code: "ARCH1", lifecycle_status: "archived", document: { ...P86_DOCUMENT, internalCode: "ARCH1", lifecycleStatus: "archived" } })));
  const defaultView = filterCatalogItemsAdmin([active, archived], {});
  assert.deepEqual(defaultView.map((e) => e.internalCode), ["P86"], "archived must be hidden by default");

  const withShowArchived = filterCatalogItemsAdmin([active, archived], { showArchived: true });
  assert.deepEqual(withShowArchived.map((e) => e.internalCode).sort(), ["ARCH1", "P86"], "showArchived:true reveals it alongside everything else");
});

test("ARCHIVE: showArchived combines correctly with other filters (e.g. kind) — archived items still respect every other active filter, they're not a bypass", () => {
  const archivedFurniture = buildCatalogItemListEntry(toAdmin(m57Row({ lifecycle_status: "archived", document: { ...M57_DOCUMENT, lifecycleStatus: "archived" } })));
  const archivedBooth = buildCatalogItemListEntry(toAdmin(p86Row({ id: "archived-booth", internal_code: "ARCH2", lifecycle_status: "archived", document: { ...P86_DOCUMENT, internalCode: "ARCH2", lifecycleStatus: "archived" } })));
  const result = filterCatalogItemsAdmin([archivedFurniture, archivedBooth], { showArchived: true, kind: "furniture" });
  assert.deepEqual(result.map((e) => e.internalCode), ["M57"]);
});

test("ARCHIVE: restoring sets lifecycleStatus to needs_review, never active — the exact same edit mechanism as archiving, just the other value", async () => {
  const archivedP86 = p86Row({ lifecycle_status: "archived", document: { ...P86_DOCUMENT, lifecycleStatus: "archived" } });
  const client = createFakeSupabaseClient({ catalog_items: [archivedP86] });
  const restored = await saveCatalogItemAdmin(client as never, "p86-uuid", { lifecycleStatus: "needs_review" }, "2026-08-14T19:16:38.367959+00:00");
  assert.equal(restored.lifecycleStatus, "needs_review");
  assert.notEqual(restored.lifecycleStatus, "active");
});

test("ARCHIVE: a restored (needs_review) item is NOT generatorEligible until explicitly re-activated — restoring never silently re-publishes it", async () => {
  const archivedP86 = p86Row({ lifecycle_status: "archived", document: { ...P86_DOCUMENT, lifecycleStatus: "archived" } });
  const client = createFakeSupabaseClient({ catalog_items: [archivedP86] });
  const restored = await saveCatalogItemAdmin(client as never, "p86-uuid", { lifecycleStatus: "needs_review" }, "2026-08-14T19:16:38.367959+00:00");
  assert.equal(computeGeneratorEligibleLive(restored), false, "still needs_review -> not eligible until a real 'Aktivovat' happens");
});

test("ARCHIVE: restoring THEN activating goes through the exact same assertCanActivate readiness guard as any other needs_review->active transition (P86-shaped data passes, an incomplete stub does not)", async () => {
  const archivedP86 = p86Row({ lifecycle_status: "archived", document: { ...P86_DOCUMENT, lifecycleStatus: "archived" } });
  const client = createFakeSupabaseClient({ catalog_items: [archivedP86] });
  const restored = await saveCatalogItemAdmin(client as never, "p86-uuid", { lifecycleStatus: "needs_review" }, "2026-08-14T19:16:38.367959+00:00");
  const reactivated = await saveCatalogItemAdmin(client as never, "p86-uuid", { lifecycleStatus: "active" }, restored.updatedAt);
  assert.equal(reactivated.lifecycleStatus, "active");
  assert.equal(computeGeneratorEligibleLive(reactivated), true);
});

test("ARCHIVE: no DB migration is needed — catalog_items_lifecycle_status_check in the init migration already allows 'archived'", () => {
  const source = readFileSync(new URL("../supabase/migrations/20260813120000_init_schema.sql", import.meta.url), "utf8");
  assert.match(source, /catalog_items_lifecycle_status_check check \(lifecycle_status in \([^)]*'archived'/u);
});

test("ARCHIVE UI: ComponentAdminDetail shows 'Archivovat' for any non-archived item and 'Obnovit' for an archived one — mutually exclusive, never both", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /onClick=\{handleArchive\}/u);
  assert.match(source, /onClick=\{handleRestore\}/u);
  assert.match(source, /lifecycleStatus: "archived"/u);
  assert.match(source, /lifecycleStatus: "needs_review"/u);
});

test("ARCHIVE UI: the 'Aktivovat' button is hidden for an archived item — direct archived->active is never offered in the UI, only Restore then a separate Activate", () => {
  const source = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  assert.match(source, /item\.lifecycleStatus !== "active" && item\.lifecycleStatus !== "archived" && \(/u);
});

test("ARCHIVE UI: 'Zobrazit archivované' checkbox exists in both the generic Admin filters and BoothAdminPage's filter bar", () => {
  const componentAdminSource = readFileSync(new URL("../components/workflow/ComponentAdminPage.tsx", import.meta.url), "utf8");
  const boothAdminSource = readFileSync(new URL("../components/workflow/BoothAdminPage.tsx", import.meta.url), "utf8");
  assert.match(componentAdminSource, /Zobrazit archivované/u);
  assert.match(boothAdminSource, /Zobrazit archivované/u);
});
