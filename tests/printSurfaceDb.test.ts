import test from "node:test";
import assert from "node:assert/strict";
import { SupabaseRealizationCompanyRepository } from "../lib/db/realizationCompanyRepository.supabase.ts";
import { SupabasePrintSurfacePresetRepository } from "../lib/db/printSurfacePresetRepository.supabase.ts";
import { SupabasePrintSurfaceProductionDimensionRepository } from "../lib/db/printSurfaceProductionDimensionRepository.supabase.ts";
import { SupabasePrintSurfaceProjectRepository } from "../lib/db/printSurfaceProjectRepository.supabase.ts";
import { SupabasePrintSurfaceExportRepository } from "../lib/db/printSurfaceExportRepository.supabase.ts";

/**
 * Same testing convention as tests/db.test.ts: a hand-rolled in-memory fake Supabase query
 * builder (no live Postgres/pgTAP infra exists in this repo — see that file), extended here with
 * `.not()` (used by the catalog repositories' "delete everything" replaceAll idiom) and array
 * `.insert()` (bulk inserts). Real repository CLASSES are instantiated against this fake client,
 * exactly like tests/db.test.ts does for SupabaseProjectRepository/SupabaseEventRepository.
 */
type FakeRow = Record<string, unknown>;
type FakeFilter = Readonly<{ kind: "eq"; column: string; value: unknown }> | Readonly<{ kind: "not_null"; column: string }>;

function createFakeSupabaseClient() {
  const tables = new Map<string, FakeRow[]>();

  function getTable(name: string): FakeRow[] {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }

  function from(tableName: string) {
    type Op = "select" | "insert" | "update" | "delete";
    let op: Op = "select";
    let filters: FakeFilter[] = [];
    let payload: FakeRow | FakeRow[] | undefined;
    let singleMode: "none" | "maybeSingle" | "single" = "none";
    let orderBy: { column: string; ascending: boolean } | undefined;

    function rowMatches(row: FakeRow): boolean {
      return filters.every((filter) => (filter.kind === "eq" ? row[filter.column] === filter.value : row[filter.column] !== null && row[filter.column] !== undefined));
    }

    const builder = {
      select(_columns?: string) {
        return builder;
      },
      insert(row: FakeRow | FakeRow[]) {
        op = "insert";
        payload = row;
        return builder;
      },
      update(patch: FakeRow) {
        op = "update";
        payload = patch;
        return builder;
      },
      delete() {
        op = "delete";
        return builder;
      },
      eq(column: string, value: unknown) {
        filters = [...filters, { kind: "eq", column, value }];
        return builder;
      },
      not(column: string, _operator: string, _value: unknown) {
        filters = [...filters, { kind: "not_null", column }];
        return builder;
      },
      order(column: string, opts: { ascending: boolean }) {
        orderBy = { column, ascending: opts.ascending };
        return builder;
      },
      maybeSingle() {
        singleMode = "maybeSingle";
        return execute();
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
        let matched = rows.filter(rowMatches);
        if (orderBy) {
          const { column, ascending } = orderBy;
          matched = [...matched].sort((a, b) => {
            const av = String(a[column] ?? "");
            const bv = String(b[column] ?? "");
            return ascending ? av.localeCompare(bv) : bv.localeCompare(av);
          });
        }
        if (singleMode === "maybeSingle") return { data: matched[0] ?? null, error: null };
        if (singleMode === "single") return matched[0] ? { data: matched[0], error: null } : { data: null, error: { message: "not found" } };
        return { data: matched, error: null };
      }
      if (op === "insert") {
        const incoming = Array.isArray(payload) ? payload : [payload as FakeRow];
        const inserted = incoming.map((row) => {
          const clone: FakeRow = { ...row };
          if (clone.id === undefined) clone.id = crypto.randomUUID();
          if (clone.created_at === undefined) clone.created_at = new Date().toISOString();
          if (clone.updated_at === undefined) clone.updated_at = new Date().toISOString();
          rows.push(clone);
          return clone;
        });
        if (singleMode === "single") return { data: inserted[0], error: null };
        return { data: inserted, error: null };
      }
      if (op === "update") {
        const matched = rows.filter(rowMatches);
        for (const row of matched) {
          Object.assign(row, payload);
          row.updated_at = new Date().toISOString();
        }
        if (singleMode === "single") return matched[0] ? { data: matched[0], error: null } : { data: null, error: { message: "not found" } };
        return { data: matched, error: null };
      }
      if (op === "delete") {
        const remaining = rows.filter((row) => !rowMatches(row));
        tables.set(tableName, remaining);
        return { data: null, error: null };
      }
      return { data: null, error: { message: `unsupported op ${op}` } };
    }

    return builder;
  }

  return { from };
}

test("SupabaseRealizationCompanyRepository: replaceAll je plná atomická náhrada, list() vrátí seřazeně podle jména", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabaseRealizationCompanyRepository(client as never);
  await repository.replaceAll([
    { id: "gendai", name: "Gendai", isActive: true },
    { id: "creativ-expo", name: "Creativ Expo", isActive: true },
  ]);
  const list = await repository.list();
  assert.deepEqual(list.map((c) => c.name), ["Creativ Expo", "Gendai"]);

  // a second import fully replaces the first — no leftover rows from the previous import
  await repository.replaceAll([{ id: "macik", name: "Macík", isActive: true }]);
  const replaced = await repository.list();
  assert.deepEqual(replaced.map((c) => c.id), ["macik"]);
});

test("SupabasePrintSurfacePresetRepository: parentId/parentName přežijí DB round-trip", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabasePrintSurfacePresetRepository(client as never);
  await repository.replaceAll([
    { id: "Pult_100x50_v_Celo", typeId: "counter_front", name: "Čelo", isActive: true, parentId: "Pult_100x50_v", parentName: "Pult 1 x 0,5 x 1,1 m" },
    { id: "Panel_S_100", typeId: "panel", name: "Panel stěnový 1 x 2,5 m", isActive: true },
  ]);
  const list = await repository.list();
  const celo = list.find((p) => p.id === "Pult_100x50_v_Celo");
  assert.equal(celo?.parentId, "Pult_100x50_v");
  assert.equal(celo?.parentName, "Pult 1 x 0,5 x 1,1 m");
  const panel = list.find((p) => p.id === "Panel_S_100");
  assert.equal(panel?.parentId, undefined);
});

test("SupabasePrintSurfaceProductionDimensionRepository: available a unavailable stavy přežijí DB round-trip (nikdy 0x0)", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabasePrintSurfaceProductionDimensionRepository(client as never);
  await repository.replaceAll([
    { realizationCompanyId: "creativ-expo", presetId: "Panel_S_100", status: "available", widthMm: 950, heightMm: 2340 },
    { realizationCompanyId: "macik", presetId: "Pult_Vit_100x50_Celo", status: "unavailable" },
  ]);
  const list = await repository.list();
  const available = list.find((d) => d.presetId === "Panel_S_100");
  assert.equal(available?.status, "available");
  assert.equal(available?.status === "available" && available.widthMm, 950);
  const unavailable = list.find((d) => d.presetId === "Pult_Vit_100x50_Celo");
  assert.equal(unavailable?.status, "unavailable");
  assert.equal("widthMm" in (unavailable ?? {}), false);
});

test("SupabasePrintSurfaceProjectRepository: create/get/save/list/delete zachovají image a items v document", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabasePrintSurfaceProjectRepository(client as never);

  const created = await repository.create({ name: "Stánek XY 2026", companyName: "ACME", eventId: undefined, realizationCompanyId: undefined, createdBy: undefined });
  assert.equal(created.status, "draft");
  assert.equal(created.items.length, 0);
  assert.equal(created.createdBy, undefined);

  const view = { id: "view-1", label: "Pohled 1", order: 0, image: { asset: { id: "asset-1", storageKey: "print-surfaces/x/image/a.jpg", originalFileName: "a.jpg", mimeType: "image/jpeg", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" as const }, widthPx: 800, heightPx: 600 } };
  const withItem = {
    ...created,
    views: [view],
    items: [{ id: "item-a", label: "A", typeId: "panel" as const, note: "", presetId: undefined, includeInCalculation: false }],
    placements: [{ id: "placement-a", itemId: "item-a", imageId: "view-1", xNormalized: 0.5, yNormalized: 0.5 }],
  };
  const saved = await repository.save(withItem);
  assert.equal(saved.items.length, 1);
  assert.equal(saved.views[0]?.image.widthPx, 800);

  const reloaded = await repository.get(created.id);
  assert.equal(reloaded?.items[0]?.label, "A");
  assert.equal(reloaded?.views[0]?.image.asset.storageKey, "print-surfaces/x/image/a.jpg");

  const list = await repository.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.itemCount, 1);
  assert.equal(list[0]?.name, "Stánek XY 2026");

  await repository.delete(created.id);
  assert.equal(await repository.get(created.id), undefined);
  assert.deepEqual(await repository.list(), []);
});

test("SupabasePrintSurfaceProjectRepository: createdBy je zachováno (reserved column) beze změny", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabasePrintSurfaceProjectRepository(client as never);
  const created = await repository.create({ name: "Test", companyName: "ACME", createdBy: undefined });
  assert.equal(created.createdBy, undefined);
});

test("SupabasePrintSurfaceProjectRepository: starý (pre-V3) řádek s jedním `image` polem místo views[] se při čtení bezpečně zmigruje", async () => {
  const client = createFakeSupabaseClient();
  // Simulates a row saved before V3 — inserted directly, bypassing the repository's own create()
  // (which always writes the current views[] shape), to prove reads of already-persisted legacy
  // data still work.
  await client.from("print_surface_projects").insert({
    id: "legacy-project",
    name: "Starý projekt",
    company_name: "ACME",
    event_id: null,
    realization_company_id: null,
    status: "draft",
    created_by: null,
    sent_at: null,
    sent_by: null,
    document: {
      image: { asset: { id: "asset-legacy", storageKey: "print-surfaces/legacy/image/a.jpg", originalFileName: "a.jpg", mimeType: "image/jpeg", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "print-surface-image" }, widthPx: 800, heightPx: 600 },
      items: [{ id: "item-1", label: "A", typeId: "panel", xNormalized: 0.5, yNormalized: 0.5, note: "" }],
    },
  });

  const repository = new SupabasePrintSurfaceProjectRepository(client as never);
  const loaded = await repository.get("legacy-project");
  assert.equal(loaded?.views.length, 1);
  assert.equal(loaded?.views[0]?.label, "Pohled 1");
  assert.equal(loaded?.items[0]?.includeInCalculation, false);
  assert.equal(loaded?.placements[0]?.itemId, loaded?.items[0]?.id);
  assert.equal(loaded?.placements[0]?.imageId, loaded?.views[0]?.id);

  const list = await repository.list();
  assert.equal(list.find((p) => p.id === "legacy-project")?.itemCount, 1);
});

test("SupabasePrintSurfaceExportRepository: create + list vrací záznamy pro daný projekt, seřazené od nejnovějšího", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabasePrintSurfaceExportRepository(client as never);
  await repository.create({ projectId: "project-1", exportType: "pdf_overview", createdBy: undefined });
  const list = await repository.list("project-1");
  assert.equal(list.length, 1);
  assert.equal(list[0]?.exportType, "pdf_overview");
  assert.equal(list[0]?.projectId, "project-1");

  const otherProjectList = await repository.list("project-2");
  assert.deepEqual(otherProjectList, []);
});
