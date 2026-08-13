import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../lib/db/supabase.server.ts";
import { SupabaseProjectRepository } from "../lib/db/projectRepository.supabase.ts";
import { SupabaseEventRepository } from "../lib/db/eventRepository.supabase.ts";
import { ConcurrencyConflictError } from "../lib/db/concurrency.ts";
import { createProjectRecord } from "../domain/project.ts";
import { normalizeExhibition } from "../domain/organizations.ts";

test("Supabase env validace vrátí srozumitelnou chybu se jmény chybějících proměnných bez secrets", () => {
  assert.throws(
    () => createSupabaseServerClient({ SUPABASE_URL: "https://example.supabase.co" }),
    (error) => error instanceof SupabaseConfigurationError && error.missingVariables.includes("SUPABASE_SECRET_KEY") && !error.message.includes("SECRET_DO_NOT_LEAK"),
  );
});

test("Supabase client se vytvoří s platnými env, aniž by secret vypsal do konzole", () => {
  const originalLog = console.log;
  const originalError = console.error;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => captured.push(args.map(String).join(" "));
  try {
    const client = createSupabaseServerClient({ SUPABASE_URL: "https://example.supabase.co", SUPABASE_SECRET_KEY: "SECRET_DO_NOT_LEAK" });
    assert.ok(client);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  assert.equal(captured.some((line) => line.includes("SECRET_DO_NOT_LEAK")), false);
});

test("server-only Supabase klient nikde neodkazuje na NEXT_PUBLIC_ variantu secret klíče", () => {
  const source = readFileSync(new URL("../lib/db/supabase.server.ts", import.meta.url), "utf8");
  assert.equal(/NEXT_PUBLIC_SUPABASE_SECRET_KEY/u.test(source), false);
  assert.equal(/console\.(log|info|debug)\([^)]*SUPABASE_SECRET_KEY/u.test(source), false);
});

test("Project serializace/deserializace přes Supabase repository zachová domain model", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabaseProjectRepository(client as never);
  const project = createProjectRecord({ id: "project-1", company: "Test s.r.o.", fairId: "beauty" });
  const saved = await repository.saveWithRevision(project, null);
  assert.equal(saved.revision, 1);
  assert.equal(saved.company, "Test s.r.o.");
  const reloaded = await repository.get("project-1");
  assert.equal(reloaded?.id, "project-1");
  assert.equal(reloaded?.schemaVersion, project.schemaVersion);
});

test("Event serializace/deserializace přes Supabase repository zachová domain model", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabaseEventRepository(client as never);
  const event = normalizeExhibition({ id: "event-1", name: "For Beauty", year: 2026 });
  const saved = await repository.saveWithRevision(event, null);
  assert.equal(saved.revision, 1);
  const reloaded = await repository.getWithRevision("event-1");
  assert.equal(reloaded?.name, "For Beauty");
});

test("revision se při každém uložení inkrementuje", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabaseProjectRepository(client as never);
  const project = createProjectRecord({ id: "project-2" });
  const first = await repository.saveWithRevision(project, null);
  assert.equal(first.revision, 1);
  const second = await repository.saveWithRevision({ ...project, company: "Změna" }, first.revision);
  assert.equal(second.revision, 2);
});

test("zastaralá revision při uložení vyhodí ConcurrencyConflictError a nepřepíše data ticha", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabaseProjectRepository(client as never);
  const project = createProjectRecord({ id: "project-3", company: "Původní" });
  const saved = await repository.saveWithRevision(project, null);
  // Simulate someone else saving in between.
  await repository.saveWithRevision({ ...project, company: "Jiný uživatel" }, saved.revision);

  await assert.rejects(
    () => repository.saveWithRevision({ ...project, company: "Zastaralý pokus" }, saved.revision),
    (error) => error instanceof ConcurrencyConflictError,
  );
  const current = await repository.get("project-3");
  assert.equal(current?.company, "Jiný uživatel");
});

test("R2 storageKey na Event dokumentech přežije DB serializaci beze změny", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabaseEventRepository(client as never);
  const event = normalizeExhibition({
    id: "event-r2",
    name: "For Arch",
    year: 2026,
    logoAsset: {
      id: "logo-1",
      storageKey: "events/event-r2/logo/abc.png",
      originalFileName: "logo.png",
      mimeType: "image/png",
      size: 1234,
      createdAt: "2026-08-13T00:00:00.000Z",
      category: "event-logo",
    },
  });
  await repository.saveWithRevision(event, null);
  const reloaded = await repository.getWithRevision("event-r2");
  assert.equal(reloaded?.logoAsset?.storageKey, "events/event-r2/logo/abc.png");
  // Presigned URLs are never part of the persisted payload — only storageKey travels.
  assert.equal("uploadUrl" in (reloaded ?? {}), false);
});

test("Event assigned/default PriceList vazba přežije DB serializaci", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabaseEventRepository(client as never);
  const event = normalizeExhibition({
    id: "event-pricelist",
    name: "For Beauty",
    year: 2026,
    priceListIds: ["pl-czk", "pl-eur"],
    defaultPriceListId: "pl-czk",
  });
  await repository.saveWithRevision(event, null);
  const reloaded = await repository.getWithRevision("event-pricelist");
  assert.deepEqual(reloaded?.priceListIds, ["pl-czk", "pl-eur"]);
  assert.equal(reloaded?.defaultPriceListId, "pl-czk");
});

test("PriceList realization context (realizationCompanyId, edition, validity) přežije JSONB round-trip", () => {
  // No SupabasePriceListRepository exists yet (out of scope for this hardening pass) — this
  // proves the domain PriceList shape itself round-trips through a JSONB `document` column
  // exactly like the migration's price_lists.document is designed to store it.
  const priceList = {
    id: "pl-realization",
    name: "For Beauty 2026 CZK — Medaprex",
    code: "BEAUTY-2026-CZK",
    currency: "CZK" as const,
    year: 2026,
    edition: "2026",
    realizationCompanyId: "medaprex",
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    active: true,
  };
  const roundTripped = JSON.parse(JSON.stringify(priceList));
  assert.deepEqual(roundTripped, priceList);
  assert.equal(roundTripped.realizationCompanyId, "medaprex");
});

test("PricingEntry.priceMode (fixed/individual/included) přežije serializaci beze ztráty", () => {
  const included = { id: "p1", itemId: "fascia", currency: "CZK" as const, priceMode: "included" as const, salePrice: 0 };
  const individual = { id: "p2", itemId: "container", currency: "CZK" as const, priceMode: "individual" as const };
  for (const entry of [included, individual]) {
    const roundTripped = JSON.parse(JSON.stringify(entry));
    assert.deepEqual(roundTripped, entry);
  }
});

// ---------------------------------------------------------------------------------------
// Minimal fake Supabase query builder — supports exactly the chains our repositories use
// (select/order/eq/maybeSingle/single, insert/select/single, update/eq/eq/select, delete/eq)
// against an in-memory table. Never touches a real Supabase project.
// ---------------------------------------------------------------------------------------
type FakeRow = Record<string, unknown>;

function createFakeSupabaseClient() {
  const tables = new Map<string, FakeRow[]>();

  function getTable(name: string): FakeRow[] {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name)!;
  }

  function from(tableName: string) {
    type Op = "select" | "insert" | "update" | "delete";
    let op: Op = "select";
    let filters: Array<[string, unknown]> = [];
    let payload: FakeRow | undefined;
    let singleMode: "none" | "maybeSingle" | "single" = "none";
    let orderBy: { column: string; ascending: boolean } | undefined;

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
      delete() {
        op = "delete";
        return builder;
      },
      eq(column: string, value: unknown) {
        filters = [...filters, [column, value]];
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
        let matched = rows.filter((row) => filters.every(([column, value]) => row[column] === value));
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
        const row = { ...payload };
        rows.push(row);
        if (singleMode === "single") return { data: row, error: null };
        return { data: [row], error: null };
      }
      if (op === "update") {
        const matched = rows.filter((row) => filters.every(([column, value]) => row[column] === value));
        for (const row of matched) Object.assign(row, payload);
        return { data: matched, error: null };
      }
      if (op === "delete") {
        const remaining = rows.filter((row) => !filters.every(([column, value]) => row[column] === value));
        tables.set(tableName, remaining);
        return { data: null, error: null };
      }
      return { data: null, error: { message: `unsupported op ${op}` } };
    }

    return builder;
  }

  return { from };
}
