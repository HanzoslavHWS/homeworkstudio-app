/**
 * Catalog revision batch: card types (PRODUCT/SERVICE/BOOTH/INTERNAL_COMPONENT), separate ABF
 * code, archive/restore, BOOTH package contents and the KODY.xlsm import.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server.js";
import {
  applyCatalogItemEdit,
  buildCatalogItemDuplicateDocument,
  buildCatalogItemListEntry,
  filterCatalogItemsAdmin,
  InvalidCatalogItemAdminEditError,
  itemTypeOf,
  parseBulkLifecycleRequest,
  parseCatalogItemAdminCreateInput,
  parseCatalogItemAdminEdit,
  planBulkLifecycle,
  resolveRestoreStatus,
  resolveTypeAndKindEdit,
  type CatalogItemAdmin,
} from "../domain/catalogItemsAdmin.ts";
import {
  CATALOG_ITEM_KINDS_BY_TYPE,
  defaultItemTypeForKind,
  DuplicateAbfCodeError,
  isKindCompatibleWithItemType,
  normalizeAbfCode,
} from "../domain/catalogItemTypes.ts";
import {
  assertValidPackageContents,
  InvalidCatalogPackageError,
  parseCatalogPackageItemsInput,
  pricePackage,
} from "../domain/catalogPackages.ts";
import {
  buildAbfImportInsert,
  buildAbfImportUpdatePatch,
  classifyAbfCodeItemType,
  KodyFormatError,
  parseKodyPricelist,
  planAbfImport,
  type AbfImportExistingItem,
} from "../domain/catalogAbfImport.ts";
import { selectGeneratorBooths, selectSavedProjectBooths, resolveGeneratorBooth, isArchivedButUsableBooth } from "../domain/generatorBooths.ts";
import { selectGeneratorBoothComponents } from "../domain/generatorBoothComponents.ts";
import { CATALOG_ITEM_KINDS, CATALOG_ITEM_TYPES, type CatalogItemKind } from "../domain/models.ts";
import { boothTypes } from "../data/booths.ts";
import { placeComponent } from "../data/components.ts";
import {
  bulkLifecycleCatalogItemsAdmin,
  createCatalogItemAdmin,
  duplicateCatalogItemAdmin,
  readCatalogItemsAdmin,
  saveCatalogItemAdmin,
  saveCatalogPackageItems,
} from "../lib/db/catalogItemsAdmin.supabase.ts";
import { applyAbfImport, previewAbfImport } from "../lib/db/catalogAbfImport.supabase.ts";
import { readKodyRowsFromBuffer } from "../lib/import/kodyReader.server.ts";
import { handleAbfImport } from "../app/api/catalog-admin/abf-import/route.ts";
import { handleCatalogAdminItemsCreate } from "../app/api/catalog-admin/items/create/route.ts";
import { handleCatalogAdminItemsSave } from "../app/api/catalog-admin/items/save/route.ts";
import { handleCatalogAdminPackageSave } from "../app/api/catalog-admin/items/package/route.ts";
import { handleCatalogAdminItemsLifecycle } from "../app/api/catalog-admin/items/lifecycle/route.ts";
import { createSessionToken } from "../lib/auth/session.ts";

const SECRET = "catalog-revision-test-session-secret-32";
(process.env as Record<string, string | undefined>).APP_SESSION_SECRET = SECRET;

// ---------------------------------------------------------------------------------------
// Fake Supabase client: select/insert/update/upsert/delete + eq/limit/single/maybeSingle.
// Optional `missingColumns` simulates a DB before the 20261001120000 migration.
// ---------------------------------------------------------------------------------------
type FakeRow = Record<string, unknown>;

function createFakeClient(seed: Readonly<Record<string, readonly FakeRow[]>> = {}, options: Readonly<{ missingColumns?: readonly string[] }> = {}) {
  const tables = new Map<string, FakeRow[]>(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  const table = (name: string) => {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  };
  let nextId = 1;
  let clock = 0;
  const stamp = () => `2026-10-01T00:00:${String(++clock).padStart(2, "0")}.000Z`;
  const calls: string[] = [];

  function from(tableName: string) {
    let op: "select" | "insert" | "update" | "upsert" | "delete" = "select";
    let columns = "";
    let payload: FakeRow | FakeRow[] | undefined;
    let upsertConflict: string[] = [];
    let filters: [string, unknown][] = [];
    let single: "none" | "single" | "maybe" = "none";
    const missing = (cols: string) => (options.missingColumns ?? []).some((column) => cols.split(/\s*,\s*/u).includes(column));
    const writesMissing = (row: FakeRow) => (options.missingColumns ?? []).some((column) => column in row);

    const builder = {
      select(cols = "*") { columns = cols; return builder; },
      insert(row: FakeRow | FakeRow[]) { op = "insert"; payload = row; return builder; },
      update(patch: FakeRow) { op = "update"; payload = patch; return builder; },
      upsert(rows: FakeRow[], opts: { onConflict: string }) { op = "upsert"; payload = rows; upsertConflict = opts.onConflict.split(","); return builder; },
      delete() { op = "delete"; return builder; },
      eq(column: string, value: unknown) { filters.push([column, value]); return builder; },
      limit(_count: number) { return builder; },
      single() { single = "single"; return run(); },
      maybeSingle() { single = "maybe"; return run(); },
      then(resolve: (value: { data: unknown; error: unknown }) => unknown, reject?: (reason: unknown) => unknown) { return run().then(resolve, reject); },
    };

    async function run(): Promise<{ data: unknown; error: unknown }> {
      calls.push(`${op}:${tableName}`);
      const rows = table(tableName);
      const matches = (row: FakeRow) => filters.every(([column, value]) => row[column] === value);
      if (tableName === "catalog_items" && columns && missing(columns)) return { data: null, error: { code: "42703", message: "column does not exist" } };
      if (op === "select") {
        const matched = rows.filter(matches);
        if (single === "maybe") return { data: matched[0] ?? null, error: null };
        if (single === "single") return { data: matched[0] ?? null, error: matched[0] ? null : { code: "PGRST116" } };
        return { data: matched, error: null };
      }
      if (op === "insert") {
        const list = Array.isArray(payload) ? payload : [payload!];
        if (list.some(writesMissing)) return { data: null, error: { code: "42703", message: "column does not exist" } };
        for (const row of list) {
          for (const unique of ["internal_code", "abf_code"]) {
            if (row[unique] && rows.some((existing) => existing[unique] === row[unique])) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint "catalog_items_${unique}_key"` } };
          }
        }
        const inserted = list.map((row) => ({ created_at: stamp(), updated_at: stamp(), ...row, id: row.id ?? `fake-${nextId++}` }));
        rows.push(...inserted);
        return { data: single === "none" ? inserted : inserted[0], error: null };
      }
      if (op === "update") {
        if (writesMissing(payload as FakeRow)) return { data: null, error: { code: "42703", message: "column does not exist" } };
        const matched = rows.filter(matches);
        for (const row of matched) Object.assign(row, payload, { updated_at: stamp() });
        return { data: matched, error: null };
      }
      if (op === "upsert") {
        for (const row of payload as FakeRow[]) {
          const existing = rows.find((candidate) => upsertConflict.every((column) => candidate[column] === row[column]));
          if (existing) Object.assign(existing, row);
          else rows.push({ id: `pkg-${nextId++}`, ...row });
        }
        return { data: null, error: null };
      }
      if (op === "delete") {
        const keep = rows.filter((row) => !matches(row));
        tables.set(tableName, keep);
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    return builder;
  }
  return { from, tables, calls };
}

// ---------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------
const P86_DOCUMENT = boothTypes.find((booth) => booth.internalCode === "P86")! as unknown as FakeRow;

function row(overrides: FakeRow): FakeRow {
  return {
    id: "row-id",
    internal_code: null,
    abf_code: null,
    item_type: null,
    kind: "furniture",
    lifecycle_status: "needs_review",
    display_name: "Položka",
    official_name: null,
    category: "Nábytek",
    unit: "ks",
    document: { displayName: "Položka", name: "Položka" },
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

const p86Row = (overrides: FakeRow = {}) =>
  row({ id: "p86-uuid", internal_code: "P86", abf_code: "P86", item_type: "BOOTH", kind: "booth", lifecycle_status: "active", display_name: "Kóje 2 × 2 m (P86)", category: "Canonical", document: { ...P86_DOCUMENT, lifecycleStatus: "active" }, ...overrides });
const m57Row = (overrides: FakeRow = {}) =>
  row({ id: "m57-uuid", internal_code: "M57", abf_code: "M57", item_type: "PRODUCT", kind: "furniture", lifecycle_status: "active", display_name: "Židle kovová čalouněná", category: "chairs", document: { id: "chair-basic", displayName: "Židle kovová čalouněná", name: "Židle kovová čalouněná", modelAsset: { id: "a", storageKey: "catalog/m57.glb" }, technicalRaster: { enabled: false } }, ...overrides });
const sloupekRow = (overrides: FakeRow = {}) =>
  row({ id: "sloupek-uuid", internal_code: null, abf_code: null, item_type: "INTERNAL_COMPONENT", kind: "booth_component", lifecycle_status: "active", display_name: "Sloupek 2500", category: "Sloupky", document: { displayName: "Sloupek 2500", name: "Sloupek 2500" }, ...overrides });
const pultRow = (overrides: FakeRow = {}) =>
  row({ id: "pult-uuid", internal_code: "M23", abf_code: "M23", item_type: "PRODUCT", kind: "furniture", display_name: "Zvyšovací pult", category: "Octanorm", ...overrides });

function toAdmin(fake: FakeRow): CatalogItemAdmin {
  return {
    id: fake.id as string,
    internalCode: fake.internal_code as string | null,
    abfCode: fake.abf_code as string | null,
    itemType: (fake.item_type as CatalogItemAdmin["itemType"]) ?? undefined,
    kind: fake.kind as CatalogItemKind,
    lifecycleStatus: fake.lifecycle_status as CatalogItemAdmin["lifecycleStatus"],
    displayName: fake.display_name as string,
    officialName: fake.official_name as string | null,
    category: fake.category as string | null,
    unit: fake.unit as string | null,
    document: fake.document as FakeRow,
    createdAt: fake.created_at as string,
    updatedAt: fake.updated_at as string,
  };
}

function request(url: string, init: Readonly<{ token?: string; body?: unknown; form?: FormData }> = {}) {
  const headers: Record<string, string> = {};
  if (init.token) headers.Cookie = `homeworkstudio_session=${init.token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest(url, { method: "POST", headers, body: init.form ?? (init.body !== undefined ? JSON.stringify(init.body) : undefined) });
}

// =========================================================================================
// CARD TYPES
// =========================================================================================

test("types: every kind maps to exactly one default type, and that type admits the kind (migration backfill mirror)", () => {
  for (const kind of CATALOG_ITEM_KINDS) {
    const type = defaultItemTypeForKind(kind);
    assert.ok(isKindCompatibleWithItemType(kind, type), `${kind} -> ${type} must be compatible`);
  }
  for (const type of CATALOG_ITEM_TYPES) assert.ok(CATALOG_ITEM_KINDS_BY_TYPE[type].length > 0);
  assert.equal(defaultItemTypeForKind("booth"), "BOOTH");
  assert.equal(defaultItemTypeForKind("booth_component"), "INTERNAL_COMPONENT");
  assert.equal(defaultItemTypeForKind("service"), "SERVICE");
  assert.equal(defaultItemTypeForKind("furniture"), "PRODUCT");
});

test("types: itemTypeOf falls back to the kind mapping for rows read before the migration", () => {
  assert.equal(itemTypeOf({ kind: "booth_component" }), "INTERNAL_COMPONENT");
  assert.equal(itemTypeOf({ kind: "furniture", itemType: "SERVICE" }), "SERVICE");
});

test("migration: purely additive — no delete/drop of data, backfill only ABF-shaped internal codes, never GRAPHICS-*", () => {
  const sql = readFileSync(path.resolve("supabase/migrations/20261001120000_catalog_item_types_abf_codes_packages.sql"), "utf8").toLowerCase();
  assert.equal(/\bdelete\s+from\b/u.test(sql), false);
  assert.equal(/\bdrop\s+(table|column)\b/u.test(sql), false);
  assert.match(sql, /internal_code ~ '\^\[a-z\]\[0-9a-z\]\{2\}\$'/u);
  assert.equal(new RegExp("^[A-Z][0-9A-Z]{2}$").test("GRAPHICS-FASCIA"), false);
  assert.ok(sql.includes("on delete restrict"));
  assert.ok(sql.includes("catalog_items_prevent_referenced_delete"));
});

// =========================================================================================
// ARCHIVE — not offered for new projects, still working in old ones
// =========================================================================================

test("archive: an archived booth is NOT offered in the generator picker for new projects", () => {
  const items = [toAdmin(p86Row({ lifecycle_status: "archived" }))];
  assert.deepEqual(selectGeneratorBooths(items), []);
});

test("archive: an archived booth_component is NOT offered in the individual-booth component picker", () => {
  const ready = { displayName: "Sloupek 2500", category: "Sloupky", widthMm: 40, depthMm: 40, heightMm: 2500, modelAsset: { id: "glb", storageKey: "s.glb" }, sourceAssets: [{ id: "skp", kind: "sketchup", asset: { storageKey: "s.skp" } }] };
  const active = toAdmin(sloupekRow({ document: ready }));
  const archived = toAdmin(sloupekRow({ id: "sloupek-2", lifecycle_status: "archived", document: ready }));
  assert.deepEqual(selectGeneratorBoothComponents([active, archived]).map((component) => component.id), ["sloupek-uuid"]);
});

test("archive: an archived booth still RESOLVES for an older saved project (legacy 'koje-2x2' boothId) — but is not in the picker", () => {
  const items = [toAdmin(p86Row({ lifecycle_status: "archived" }))];
  assert.equal(isArchivedButUsableBooth(items[0]!), true);
  const saved = selectSavedProjectBooths(items);
  const resolved = resolveGeneratorBooth(saved, "koje-2x2");
  assert.ok(resolved, "saved project must still resolve its archived booth");
  assert.equal(resolved!.internalCode, "P86");
  assert.equal(resolved!.lifecycleStatus, "archived");
  assert.equal(resolveGeneratorBooth(selectGeneratorBooths(items), "koje-2x2"), undefined, "the new-project picker list never contains it");
});

test("archive: an archived furniture definition never changes an already placed instance (scene objects are snapshots)", () => {
  const definition = { id: "chair-basic", internalCode: "M57", type: "chair", name: "Židle", category: "chairs", widthMm: 535, depthMm: 592, resizable: false, productionProfiles: {}, rotation: { defaultMode: "snap", snapStep: 90, quickAngles: [0], allowFreeRotation: false, locked: false }, systemLocked: false, userLocked: false, visible: true, sceneLabel: "Židle", lifecycleStatus: "active" } as const;
  const placed = placeComponent(definition as never, "instance-1", 100, 200);
  const archivedDefinition = { ...definition, lifecycleStatus: "archived" };
  assert.equal(archivedDefinition.lifecycleStatus, "archived");
  assert.equal(placed.definitionId, "chair-basic");
  assert.equal(placed.widthMm, 535);
  assert.equal(placed.xMm, 100);
});

test("archive: admin list hides archived by default, 'Jen archivované' shows only them", () => {
  const entries = [toAdmin(m57Row()), toAdmin(pultRow({ lifecycle_status: "archived" }))].map(buildCatalogItemListEntry);
  assert.deepEqual(filterCatalogItemsAdmin(entries, {}).map((entry) => entry.id), ["m57-uuid"]);
  assert.deepEqual(filterCatalogItemsAdmin(entries, { onlyArchived: true }).map((entry) => entry.id), ["pult-uuid"]);
  assert.equal(filterCatalogItemsAdmin(entries, { showArchived: true }).length, 2);
  assert.deepEqual(filterCatalogItemsAdmin(entries, { itemType: "PRODUCT", query: "M23", showArchived: true }).map((entry) => entry.id), ["pult-uuid"]);
});

test("archive: archiving remembers the previous status; restore returns an active+ready item to active", async () => {
  const client = createFakeClient({ catalog_items: [p86Row()] });
  const archived = await saveCatalogItemAdmin(client as never, "p86-uuid", { lifecycleStatus: "archived" }, null);
  assert.equal(archived.lifecycleStatus, "archived");
  assert.equal(archived.document.archivedFromStatus, "active");
  assert.equal(archived.document.constructionParts !== undefined, true, "document content untouched");
  const restored = await saveCatalogItemAdmin(client as never, "p86-uuid", { restoreFromArchive: true }, null);
  assert.equal(restored.lifecycleStatus, "active");
  assert.equal(restored.document.archivedFromStatus, undefined);
});

test("archive: restoring a previously-active item that no longer passes readiness lands on needs_review, never silently active", () => {
  assert.equal(resolveRestoreStatus({ kind: "furniture", document: { archivedFromStatus: "active", displayName: "X", category: "Nábytek" } }), "needs_review");
  assert.equal(resolveRestoreStatus({ kind: "furniture", document: {} }), "needs_review");
  assert.equal(resolveRestoreStatus({ kind: "furniture", document: { archivedFromStatus: "draft" } }), "draft");
});

test("archive: bulk archive skips ACTIVE items unless includeActive, archives the rest, never deletes", async () => {
  const client = createFakeClient({ catalog_items: [m57Row(), pultRow(), p86Row()] });
  const result = await bulkLifecycleCatalogItemsAdmin(client as never, { ids: ["m57-uuid", "pult-uuid", "p86-uuid"], action: "archive" });
  assert.deepEqual(result.outcomes.map((outcome) => `${outcome.id}:${outcome.result}`), ["m57-uuid:skipped", "pult-uuid:archived", "p86-uuid:skipped"]);
  assert.equal(client.tables.get("catalog_items")!.length, 3);
  assert.ok(!client.calls.some((call) => call.startsWith("delete:catalog_items")));
  const withActive = await bulkLifecycleCatalogItemsAdmin(client as never, { ids: ["m57-uuid"], action: "archive", includeActive: true });
  assert.equal(withActive.outcomes[0]!.result, "archived");
  const restored = await bulkLifecycleCatalogItemsAdmin(client as never, { ids: ["pult-uuid"], action: "restore" });
  assert.equal(restored.items[0]!.lifecycleStatus, "needs_review");
});

test("archive: bulk request parsing rejects empty/invalid input; planBulkLifecycle is a no-op for already-archived", () => {
  assert.throws(() => parseBulkLifecycleRequest({ ids: [], action: "archive" }), InvalidCatalogItemAdminEditError);
  assert.throws(() => parseBulkLifecycleRequest({ ids: ["a"], action: "delete" }), InvalidCatalogItemAdminEditError);
  assert.deepEqual(parseBulkLifecycleRequest({ ids: ["a", "a"], action: "restore" }).ids, ["a"]);
  assert.equal(planBulkLifecycle({ id: "x", lifecycleStatus: "archived", kind: "furniture", document: {} }, { action: "archive" }).skip, true);
});

test("POST /api/catalog-admin/items/lifecycle: unauthenticated -> 401; invalid body -> 400", async () => {
  assert.equal((await handleCatalogAdminItemsLifecycle(request("http://localhost/api/catalog-admin/items/lifecycle", { body: { ids: ["a"], action: "archive" } }))).status, 401);
  const token = await createSessionToken(SECRET);
  assert.equal((await handleCatalogAdminItemsLifecycle(request("http://localhost/api/catalog-admin/items/lifecycle", { token, body: { ids: [], action: "archive" } }))).status, 400);
});

// =========================================================================================
// CODES — internal vs ABF, manual creation, INTERNAL_COMPONENT without ABF
// =========================================================================================

test("codes: ABF code is normalized upper-case; codes with whitespace are rejected", () => {
  assert.equal(normalizeAbfCode(" m8a "), "M8A");
  assert.equal(normalizeAbfCode("M 57"), null);
  assert.equal(normalizeAbfCode(""), undefined);
  assert.throws(() => parseCatalogItemAdminEdit({ abfCode: "M 57" }), InvalidCatalogItemAdminEditError);
  assert.deepEqual(parseCatalogItemAdminEdit({ abfCode: null }), { abfCode: null });
});

test("manual create: INTERNAL_COMPONENT without any ABF code is valid (abf_code stays null)", async () => {
  const input = parseCatalogItemAdminCreateInput({ itemType: "INTERNAL_COMPONENT", displayName: "Panel 950", internalCode: "INT-PANEL-950", category: "Panely / stěny" });
  assert.equal(input.kind, "booth_component");
  assert.equal(input.abfCode, undefined);
  const client = createFakeClient({ catalog_items: [] });
  const created = await createCatalogItemAdmin(client as never, input);
  assert.equal(created.itemType, "INTERNAL_COMPONENT");
  assert.equal(created.internalCode, "INT-PANEL-950");
  assert.equal(created.abfCode, null);
  assert.equal(created.lifecycleStatus, "needs_review");
  const stored = client.tables.get("catalog_items")![0]!;
  assert.equal("abf_code" in stored, false);
  assert.equal(stored.item_type, "INTERNAL_COMPONENT");
});

test("manual create: a PRODUCT with an ABF code keeps internal and ABF code as two separate values", async () => {
  const client = createFakeClient({ catalog_items: [] });
  const created = await createCatalogItemAdmin(client as never, parseCatalogItemAdminCreateInput({ itemType: "PRODUCT", displayName: "Stůl", category: "Nábytek", internalCode: "HWS-STUL-1", abfCode: "m50", note: "ruční karta" }));
  assert.equal(created.internalCode, "HWS-STUL-1");
  assert.equal(created.abfCode, "M50");
  assert.equal(created.kind, "furniture");
  assert.equal(created.document.note, "ruční karta");
});

test("manual create: requires a type (or legacy kind); rejects an incompatible kind; duplicate ABF code -> DuplicateAbfCodeError", async () => {
  assert.throws(() => parseCatalogItemAdminCreateInput({ displayName: "X", category: "Nábytek" }));
  assert.throws(() => parseCatalogItemAdminCreateInput({ itemType: "SERVICE", kind: "booth", displayName: "X", category: "services" }));
  assert.equal(parseCatalogItemAdminCreateInput({ kind: "booth_component", displayName: "X", category: "Sloupky" }).itemType, "INTERNAL_COMPONENT");
  const client = createFakeClient({ catalog_items: [m57Row()] });
  await assert.rejects(() => createCatalogItemAdmin(client as never, parseCatalogItemAdminCreateInput({ itemType: "PRODUCT", displayName: "Židle 2", category: "chairs", abfCode: "M57" })), DuplicateAbfCodeError);
});

test("POST /api/catalog-admin/items/create: duplicate ABF code -> 409", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsCreate(
    request("http://localhost/api/catalog-admin/items/create", { token, body: { create: { itemType: "PRODUCT", displayName: "X", category: "Nábytek", abfCode: "M57" } } }),
    async () => { throw new DuplicateAbfCodeError("M57"); },
  );
  assert.equal(response.status, 409);
});

test("edit: ABF code can change freely (unique), an existing internal code can never be rewritten, a missing one can be filled", async () => {
  const client = createFakeClient({ catalog_items: [m57Row(), sloupekRow({ lifecycle_status: "needs_review" })] });
  const changed = await saveCatalogItemAdmin(client as never, "m57-uuid", { abfCode: "M57X" }, null);
  assert.equal(changed.abfCode, "M57X");
  assert.equal(changed.internalCode, "M57", "internal identity untouched by an ABF change");
  await assert.rejects(() => saveCatalogItemAdmin(client as never, "m57-uuid", { fillInternalCode: "OTHER" }, null), InvalidCatalogItemAdminEditError);
  await assert.rejects(() => saveCatalogItemAdmin(client as never, "sloupek-uuid", { abfCode: "M57X" }, null), DuplicateAbfCodeError);
  const filled = await saveCatalogItemAdmin(client as never, "sloupek-uuid", { fillInternalCode: "INT-SLOUPEK-2500" }, null);
  assert.equal(filled.internalCode, "INT-SLOUPEK-2500");
});

test("edit: type/kind change is rejected for an ACTIVE item (generator uses it) and moves kind to the type default otherwise", () => {
  assert.throws(() => resolveTypeAndKindEdit({ kind: "furniture", lifecycleStatus: "active" }, { itemType: "SERVICE" }), InvalidCatalogItemAdminEditError);
  assert.deepEqual(resolveTypeAndKindEdit({ kind: "other", lifecycleStatus: "needs_review" }, { itemType: "SERVICE" }), { itemType: "SERVICE", kind: "service" });
  assert.deepEqual(resolveTypeAndKindEdit({ kind: "other", lifecycleStatus: "needs_review", itemType: "PRODUCT" }, { kind: "furniture" }), { itemType: "PRODUCT", kind: "furniture" });
  assert.throws(() => resolveTypeAndKindEdit({ kind: "other", lifecycleStatus: "needs_review" }, { itemType: "BOOTH", kind: "service" }), InvalidCatalogItemAdminEditError);
});

test("edit: confirming the type clears the import's 'K zařazení' flag; note/serviceTechnical are stored in the document", () => {
  const next = applyCatalogItemEdit({ itemTypeNeedsReview: true, keep: 1 }, { confirmItemType: true, note: "x", serviceTechnical: { powerKw: 2, parameters: [{ key: "Napětí", value: "230 V" }] } });
  assert.equal(next.itemTypeNeedsReview, undefined);
  assert.equal(next.keep, 1);
  assert.equal(next.note, "x");
  assert.deepEqual(next.serviceTechnical, { powerKw: 2, parameters: [{ key: "Napětí", value: "230 V" }] });
  const parsed = parseCatalogItemAdminEdit({ serviceTechnical: { powerKw: -1, parameters: [{ key: "<b>", value: "x" }, { key: "Jistič", value: "C16" }] } });
  assert.deepEqual(parsed.serviceTechnical, { parameters: [{ key: "Jistič", value: "C16" }] });
});

test("POST /api/catalog-admin/items/save: invalid ABF code -> 400 (never silently dropped)", async () => {
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminItemsSave(request("http://localhost/api/catalog-admin/items/save", { token, body: { id: "x", edit: { abfCode: "A B" } } }), async () => { throw new Error("must not be called"); });
  assert.equal(response.status, 400);
});

test("duplicate: new needs_review card without internal/ABF code, provenance or prices; package contents copied", async () => {
  const client = createFakeClient({
    catalog_items: [p86Row({ document: { ...P86_DOCUMENT, reviewedAt: "2026-08-01", sourceSystem: "excel-v6.6", pricingEntries: [{ id: "p", itemId: "koje-2x2", currency: "CZK", salePrice: 3640 }] } }), m57Row()],
    catalog_item_package_items: [{ id: "l1", package_item_id: "p86-uuid", child_item_id: "m57-uuid", quantity: 2, included_in_package: true, sort_order: 0, note: null }],
  });
  const copy = await duplicateCatalogItemAdmin(client as never, "p86-uuid");
  assert.equal(copy.internalCode, null);
  assert.equal(copy.abfCode, null);
  assert.equal(copy.lifecycleStatus, "needs_review");
  assert.equal(copy.itemType, "BOOTH");
  assert.equal(copy.displayName, "Kóje 2 × 2 m (P86) (kopie)");
  assert.equal(copy.document.reviewedAt, undefined);
  assert.equal(copy.document.sourceSystem, undefined);
  assert.equal(copy.document.pricingEntries, undefined);
  assert.deepEqual(copy.packageItems!.map((line) => [line.childItemId, line.quantity, line.includedInPackage]), [["m57-uuid", 2, true]]);
  assert.equal(buildCatalogItemDuplicateDocument({ displayName: "A", document: { id: "x", widthMm: 1 } }, "B").id, undefined);
});

test("pre-migration DB: reads fall back to the legacy columns and derive itemType from kind", async () => {
  const legacy = { ...m57Row() };
  delete legacy.abf_code;
  delete legacy.item_type;
  const client = createFakeClient({ catalog_items: [legacy] }, { missingColumns: ["abf_code", "item_type"] });
  const [item] = await readCatalogItemsAdmin(client as never);
  assert.equal(item!.itemType, "PRODUCT");
  assert.equal(item!.abfCode, null);
  const saved = await saveCatalogItemAdmin(client as never, "m57-uuid", { displayName: "Židle (typo)" }, null);
  assert.equal(saved.displayName, "Židle (typo)");
});

// =========================================================================================
// BOOTH PACKAGES — booth -> item -> quantity -> included_in_package
// =========================================================================================

test("package: a BOOTH can contain other catalog items (incl. a base typovka) with quantities", async () => {
  const eBooth = row({ id: "e-uuid", item_type: "BOOTH", kind: "booth", display_name: "Stánek E", category: "Typovky" });
  const client = createFakeClient({ catalog_items: [eBooth, p86Row(), m57Row(), pultRow()] });
  const lines = await saveCatalogPackageItems(client as never, "e-uuid", [
    { childItemId: "p86-uuid", quantity: 1, includedInPackage: true },
    { childItemId: "pult-uuid", quantity: 1, includedInPackage: true },
    { childItemId: "m57-uuid", quantity: 2, includedInPackage: true, note: "2× židle" },
  ]);
  assert.deepEqual(lines.map((line) => [line.childItemId, line.quantity, line.includedInPackage]), [["p86-uuid", 1, true], ["pult-uuid", 1, true], ["m57-uuid", 2, true]]);
  const [reloaded] = (await readCatalogItemsAdmin(client as never)).filter((item) => item.id === "e-uuid");
  assert.equal(reloaded!.packageItems!.length, 3);
  // Re-save with fewer lines removes the stale one, never other packages' links.
  const trimmed = await saveCatalogPackageItems(client as never, "e-uuid", [{ childItemId: "m57-uuid", quantity: 3, includedInPackage: false }]);
  assert.deepEqual(trimmed.map((line) => [line.childItemId, line.quantity, line.includedInPackage]), [["m57-uuid", 3, false]]);
});

test("package: only a BOOTH card can own contents; self, duplicates, unknown items and cycles are rejected", async () => {
  const client = createFakeClient({ catalog_items: [m57Row(), pultRow()] });
  await assert.rejects(() => saveCatalogPackageItems(client as never, "m57-uuid", [{ childItemId: "pult-uuid", quantity: 1, includedInPackage: true }]), InvalidCatalogPackageError);
  const known = new Set(["a", "b", "c"]);
  assert.throws(() => assertValidPackageContents("a", [{ childItemId: "a", quantity: 1, includedInPackage: true }], known, []), InvalidCatalogPackageError);
  assert.throws(() => assertValidPackageContents("a", [{ childItemId: "b", quantity: 1, includedInPackage: true }, { childItemId: "b", quantity: 1, includedInPackage: true }], known, []), InvalidCatalogPackageError);
  assert.throws(() => assertValidPackageContents("a", [{ childItemId: "zzz", quantity: 1, includedInPackage: true }], known, []), InvalidCatalogPackageError);
  assert.throws(() => assertValidPackageContents("a", [{ childItemId: "b", quantity: 1, includedInPackage: true }], known, [{ packageItemId: "b", childItemId: "a" }]), /cyklus/u);
  assert.throws(() => parseCatalogPackageItemsInput([{ childItemId: "b", quantity: 0 }]), InvalidCatalogPackageError);
  assert.equal(parseCatalogPackageItemsInput([{ childItemId: "b", quantity: 2 }])[0]!.includedInPackage, true, "default: part of the package price");
});

test("package pricing: included items are counted but NEVER charged again; optional extras are priced from the price list", () => {
  const unitPrices: Record<string, { priceMode: "fixed" | "individual" | "included"; salePrice?: number }> = {
    chair: { priceMode: "fixed", salePrice: 300 },
    counter: { priceMode: "fixed", salePrice: 650 },
    lamp: { priceMode: "individual" },
  };
  const result = pricePackage(
    7500,
    [
      { childItemId: "chair", quantity: 2, includedInPackage: true },
      { childItemId: "counter", quantity: 1, includedInPackage: true },
      { childItemId: "chair", quantity: 1, includedInPackage: false },
    ],
    (id) => unitPrices[id],
  );
  assert.deepEqual(result.lines.map((line) => [line.status, line.quantity, line.totalNet]), [["included", 2, 0], ["included", 1, 0], ["priced", 1, 300]]);
  assert.equal(result.totalNet, 7800, "package price + only the non-included extra chair");
  assert.equal(result.needsQuote, false);
  const withIndividual = pricePackage(7500, [{ childItemId: "lamp", quantity: 1, includedInPackage: false }], (id) => unitPrices[id]);
  assert.equal(withIndividual.needsQuote, true);
  assert.equal(withIndividual.totalNet, 7500);
});

test("POST /api/catalog-admin/items/package: malformed lines -> 400; unauthenticated -> 401", async () => {
  assert.equal((await handleCatalogAdminPackageSave(request("http://localhost/api/catalog-admin/items/package", { body: { packageItemId: "a", items: [] } }))).status, 401);
  const token = await createSessionToken(SECRET);
  const response = await handleCatalogAdminPackageSave(request("http://localhost/api/catalog-admin/items/package", { token, body: { packageItemId: "a", items: [{ childItemId: "b", quantity: -1 }] } }), async () => { throw new Error("must not be called"); });
  assert.equal(response.status, 400);
});

// =========================================================================================
// KODY.xlsm IMPORT
// =========================================================================================

const KODY_GRID = [
  ["kategorie", "položka", "ks", "Kč / ks", "item", "€ / pcs", "NÁKLAD Kč / ks"],
  ["T04", "Typový stánek octanorm - T4", null, 4400, "Basic schell scheme octanorm - T4", 191, 2860],
  [null, null, null, null, null, null, null],
  ["M57", "Židle čalouněná", null, 300, "Upholstered chair", 13, 170],
  [null, "Dveře křídlové, uzamykatelné", null, 1800, "Hinged door", 78, 1300],
  ["M56", "Židle bílá", null, 650, "White chair", 28, 470],
  ["L40", "Přípojka el. energie - 40kW", null, "ZVOL VELETRH", "Electricity supply connection - 40kW", "ZVOL VELETRH"],
  ["M01", "Koberec šedý 1 m²", null, 190, "Grey carpet/1m²", 9, 130],
];

function existing(fake: FakeRow): AbfImportExistingItem {
  const admin = toAdmin(fake);
  return { ...admin, abfCode: admin.abfCode ?? null, itemType: itemTypeOf(admin) };
}

test("KODY parse: header validated; blank spacer rows ignored; codes normalized; EN name + unit captured", () => {
  const rows = parseKodyPricelist(KODY_GRID);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows.map((entry) => entry.abfCode), ["T04", "M57", null, "M56", "L40", "M01"]);
  assert.equal(rows[0]!.nameEn, "Basic schell scheme octanorm - T4");
  assert.equal(rows[5]!.unit, "m²");
  assert.throws(() => parseKodyPricelist([["x", "y"]]), KodyFormatError);
});

test("KODY import: a row WITH an ABF code creates a needs_review card with internal_code = abf_code (two separate fields)", () => {
  const plan = planAbfImport(parseKodyPricelist(KODY_GRID), [], "KODY.xlsm");
  const created = plan.rows.find((entry) => entry.action === "create" && entry.abfCode === "M56");
  assert.ok(created && created.action === "create");
  const insert = buildAbfImportInsert(created, "KODY.xlsm", "2026-10-01T00:00:00.000Z");
  assert.equal(insert.internal_code, "M56");
  assert.equal(insert.abf_code, "M56");
  assert.equal(insert.lifecycle_status, "needs_review");
  assert.equal(insert.display_name, "Židle bílá");
  assert.equal(insert.category, null, "category is never invented");
  assert.equal(insert.item_type, "PRODUCT");
  assert.equal(insert.document.itemTypeNeedsReview, true, "M-series type is ambiguous -> flagged for manual classification");
  assert.equal(created.classification.confident, false);
});

test("KODY import: a row WITHOUT an ABF code is ignored — never created, never drafted, only counted", async () => {
  const plan = planAbfImport(parseKodyPricelist(KODY_GRID), [], "KODY.xlsm");
  assert.equal(plan.summary.skippedWithoutAbfCode, 1);
  assert.deepEqual(plan.skippedWithoutAbfCode, [{ sourceRow: 5, nameCz: "Dveře křídlové, uzamykatelné" }]);
  assert.equal(plan.rows.some((entry) => entry.row.nameCz === "Dveře křídlové, uzamykatelné"), false);
  const client = createFakeClient({ catalog_items: [] });
  await applyAbfImport(client as never, parseKodyPricelist(KODY_GRID), "KODY.xlsm", "fp");
  const names = client.tables.get("catalog_items")!.map((stored) => stored.display_name);
  assert.equal(names.includes("Dveře křídlové, uzamykatelné"), false);
  assert.equal(names.length, 5);
});

test("KODY import: classification — T/P -> BOOTH, L/I/W/U -> SERVICE (confident), others PRODUCT + 'k zařazení'", () => {
  assert.deepEqual([classifyAbfCodeItemType("T04").itemType, classifyAbfCodeItemType("T04").confident], ["BOOTH", true]);
  assert.deepEqual([classifyAbfCodeItemType("P87").itemType, classifyAbfCodeItemType("L55").itemType, classifyAbfCodeItemType("I20").itemType], ["BOOTH", "SERVICE", "SERVICE"]);
  assert.deepEqual([classifyAbfCodeItemType("M90").itemType, classifyAbfCodeItemType("M90").kind, classifyAbfCodeItemType("S15").confident], ["PRODUCT", "other", false]);
});

test("KODY import: an existing ABF code is UPDATED, never duplicated — and only import-managed fields change", async () => {
  const m57 = m57Row({ document: { id: "chair-basic", displayName: "Židle kovová čalouněná", name: "Židle kovová čalouněná", modelAsset: { id: "a", storageKey: "catalog/m57.glb" }, technicalRaster: { enabled: false }, reviewedAt: "2026-08-01" } });
  const client = createFakeClient({ catalog_items: [m57] });
  const first = await applyAbfImport(client as never, parseKodyPricelist(KODY_GRID), "KODY.xlsm", "fp", {}, () => "2026-10-01T10:00:00.000Z");
  assert.equal(first.updated, 1);
  const rows = client.tables.get("catalog_items")!;
  assert.equal(rows.filter((stored) => stored.abf_code === "M57").length, 1, "no duplicate by abf_code");
  const stored = rows.find((candidate) => candidate.id === "m57-uuid")!;
  assert.equal(stored.display_name, "Židle kovová čalouněná", "our curated display name is kept");
  assert.equal(stored.official_name, "Židle čalouněná", "ABF name lands in official_name");
  assert.equal(stored.category, "chairs");
  assert.equal(stored.kind, "furniture");
  assert.equal(stored.lifecycle_status, "active");
  const document = stored.document as FakeRow;
  assert.deepEqual(document.modelAsset, { id: "a", storageKey: "catalog/m57.glb" }, "3D link kept");
  assert.deepEqual(document.technicalRaster, { enabled: false }, "technical parameters kept");
  assert.equal(document.reviewedAt, "2026-08-01");
  assert.equal((document.abfImport as FakeRow).abfNameEn, "Upholstered chair");

  const second = await applyAbfImport(client as never, parseKodyPricelist(KODY_GRID), "KODY.xlsm", "fp", {}, () => "2026-10-02T10:00:00.000Z");
  assert.equal(second.created, 0, "re-import never creates anything again");
  assert.equal(second.updated, 0);
  assert.equal(second.plan.summary.unchanged, 5);
  assert.equal(client.tables.get("catalog_items")!.length, 5);
});

test("KODY import: legacy card whose internal_code is the ABF code (no abf_code yet) is linked, not duplicated", () => {
  const legacy = existing(row({ id: "t04-uuid", internal_code: "T04", abf_code: null, kind: "booth", item_type: "BOOTH", display_name: "Typový stánek octanorm - T4", unit: null }));
  const plan = planAbfImport(parseKodyPricelist(KODY_GRID), [legacy], "KODY.xlsm");
  const t04 = plan.rows.find((entry) => entry.abfCode === "T04")!;
  assert.equal(t04.action, "update");
  assert.equal(t04.action === "update" && t04.linkedVia, "internal_code");
  assert.ok(t04.action === "update" && t04.changes.some((change) => change.field === "abf_code" && change.to === "T04"));
  const patch = buildAbfImportUpdatePatch(t04 as never, legacy.document, "KODY.xlsm", "now");
  assert.deepEqual(Object.keys(patch).sort(), ["abf_code", "document", "official_name"]);
});

test("KODY import: a code-less card with the SAME NAME is a conflict (no duplicate, no silent link) until the admin confirms the link", () => {
  const l40 = existing(row({ id: "l40-uuid", kind: "service", item_type: "SERVICE", display_name: "Přípojka el. energie - 40kW", internal_code: null, abf_code: null }));
  const plan = planAbfImport(parseKodyPricelist(KODY_GRID), [l40], "KODY.xlsm");
  const conflict = plan.rows.find((entry) => entry.abfCode === "L40")!;
  assert.equal(conflict.action, "conflict");
  assert.equal(conflict.action === "conflict" && conflict.reason, "possible_duplicate_by_name");
  assert.equal(plan.rows.some((entry) => entry.action === "create" && entry.abfCode === "L40"), false);
  const confirmed = planAbfImport(parseKodyPricelist(KODY_GRID), [l40], "KODY.xlsm", { L40: "l40-uuid" });
  const linked = confirmed.rows.find((entry) => entry.abfCode === "L40")!;
  assert.equal(linked.action === "update" && linked.linkedVia, "confirmed_link");
  const forged = planAbfImport(parseKodyPricelist(KODY_GRID), [l40], "KODY.xlsm", { L40: "some-other-id" });
  assert.equal(forged.rows.find((entry) => entry.abfCode === "L40")!.action, "conflict", "a confirmation for a different item never links");
});

test("KODY import: duplicate codes inside the file and an internal code owned by a card with another ABF code are conflicts", () => {
  const grid = [...KODY_GRID, ["M56", "Židle bílá (2)", null, 1]];
  const owner = existing(row({ id: "x", internal_code: "M01", abf_code: "M01-OLD", display_name: "Koberec" }));
  const plan = planAbfImport(parseKodyPricelist(grid), [owner], "KODY.xlsm");
  assert.deepEqual(plan.duplicateCodes, ["M56"]);
  assert.equal(plan.rows.filter((entry) => entry.abfCode === "M56").every((entry) => entry.action === "conflict"), true);
  const m01 = plan.rows.find((entry) => entry.abfCode === "M01")!;
  assert.equal(m01.action === "conflict" && m01.reason, "internal_code_taken");
});

test("KODY import: never archives — cards missing from the file are only listed", async () => {
  const notInFile = row({ id: "m10-uuid", internal_code: "M10", abf_code: "M10", display_name: "Stropní podhled" });
  const client = createFakeClient({ catalog_items: [notInFile] });
  const { plan } = await previewAbfImport(client as never, parseKodyPricelist(KODY_GRID), "KODY.xlsm");
  assert.deepEqual(plan.notInFile.map((entry) => entry.abfCode), ["M10"]);
  await applyAbfImport(client as never, parseKodyPricelist(KODY_GRID), "KODY.xlsm", "fp");
  assert.equal(client.tables.get("catalog_items")!.find((stored) => stored.id === "m10-uuid")!.lifecycle_status, "needs_review");
  assert.equal(client.tables.get("import_batches")!.length, 1, "audit row recorded");
});

test("KODY import: preview is read-only (never inserts/updates anything)", async () => {
  const client = createFakeClient({ catalog_items: [m57Row()] });
  await previewAbfImport(client as never, parseKodyPricelist(KODY_GRID), "KODY.xlsm");
  assert.equal(client.calls.some((call) => !call.startsWith("select:")), false);
});

test("POST /api/catalog-admin/abf-import: 401 without session; preview mode never calls apply; missing file -> 400", async () => {
  const handlers = {
    readRows: async () => parseKodyPricelist(KODY_GRID),
    preview: async () => ({ ok: "preview" }),
    apply: async () => { throw new Error("apply must not run in preview mode"); },
  };
  const form = () => {
    const data = new FormData();
    data.append("file", new File([new Uint8Array([1, 2, 3])], "KODY.xlsm"));
    return data;
  };
  assert.equal((await handleAbfImport(request("http://localhost/api/catalog-admin/abf-import", { form: form() }), handlers)).status, 401);
  const token = await createSessionToken(SECRET);
  const preview = await handleAbfImport(request("http://localhost/api/catalog-admin/abf-import", { token, form: form() }), handlers);
  assert.equal(preview.status, 200);
  assert.deepEqual(await preview.json(), { preview: { ok: "preview" } });
  assert.equal((await handleAbfImport(request("http://localhost/api/catalog-admin/abf-import", { token, form: new FormData() }), handlers)).status, 400);
});

const REAL_KODY = path.resolve("_IMPORT", "KODY.xlsm");
test("KODY import: the real _IMPORT/KODY.xlsm parses (VML form controls tolerated) — 84 rows with ABF code, 34 without", { skip: !existsSync(REAL_KODY) && "_IMPORT/KODY.xlsm not present (gitignored)" }, async () => {
  const rows = await readKodyRowsFromBuffer(readFileSync(REAL_KODY));
  const plan = planAbfImport(rows, [], "KODY.xlsm");
  assert.equal(plan.summary.withAbfCode, 84);
  assert.equal(plan.summary.skippedWithoutAbfCode, 34);
  assert.equal(plan.summary.duplicateCodes, 0);
  assert.equal(plan.summary.conflicts, 0);
});
