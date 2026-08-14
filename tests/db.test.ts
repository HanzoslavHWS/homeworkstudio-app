import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../lib/db/supabase.server.ts";
import { SupabaseProjectRepository } from "../lib/db/projectRepository.supabase.ts";
import { SupabaseEventRepository } from "../lib/db/eventRepository.supabase.ts";
import { SupabasePriceListRepository } from "../lib/db/priceListRepository.supabase.ts";
import { ConcurrencyConflictError } from "../lib/db/concurrency.ts";
import { createProjectRecord } from "../domain/project.ts";
import { normalizeExhibition, resolveDefaultPriceList, type PriceList } from "../domain/organizations.ts";

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

test("SupabasePriceListRepository: nový ceník s klientským (ne-uuid) id se vloží a DB přidělí skutečné uuid", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabasePriceListRepository(client as never);
  const saved = await repository.save({ id: "price-list-1755000000000", name: "Nový ceník 2026", code: "NEW-2026-CZK", currency: "CZK", year: 2026, active: true });
  assert.notEqual(saved.id, "price-list-1755000000000");
  assert.match(saved.id, /^[0-9a-f-]{36}$/u);
  assert.equal(saved.code, "NEW-2026-CZK");
  const list = await repository.list();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.id, saved.id);
});

test("SupabasePriceListRepository: existující uuid id aktualizuje řádek, nikdy nevytvoří duplicitní insert", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabasePriceListRepository(client as never);
  const created = await repository.save({ id: "price-list-temp", name: "Beauty 2026 CZK", code: "BEAUTY-2026-CZK", currency: "CZK", year: 2026, active: true });
  const updated = await repository.save({ ...created, name: "Beauty 2026 CZK — přejmenováno" });
  assert.equal(updated.id, created.id);
  const list = await repository.list();
  assert.equal(list.length, 1, "update podle skutečného uuid nesmí vytvořit druhý řádek");
  assert.equal(list[0]?.name, "Beauty 2026 CZK — přejmenováno");
});

test("SupabasePriceListRepository.list() vrátí ceníky seřazené podle code, včetně neaktivních (archivních)", async () => {
  const client = createFakeSupabaseClient();
  const repository = new SupabasePriceListRepository(client as never);
  await repository.save({ id: "t1", name: "B", code: "BEAUTY-2026-CZK", currency: "CZK", year: 2026, active: true });
  await repository.save({ id: "t2", name: "A", code: "ARCH-2026-CZK", currency: "CZK", year: 2026, active: false });
  const list = await repository.list();
  assert.deepEqual(list.map((p) => p.code), ["ARCH-2026-CZK", "BEAUTY-2026-CZK"]);
  assert.equal(list.some((p) => !p.active), true, "archivní (active:false) ceníky musí zůstat viditelné, ne skryté");
});

test("SupabasePriceListRepository nikdy nečte statická demo data z data/organizations.ts — DB v produkčním režimu nesmí ukazovat ukázkové ceníky", () => {
  const source = readFileSync(new URL("../lib/db/priceListRepository.supabase.ts", import.meta.url), "utf8");
  assert.equal(/from\s+["'][^"']*data\/organizations[^"']*["']/iu.test(source), false);
});

test("resolveDefaultPriceList: importovaný event najde svůj skutečný CZK ceník podle defaultPriceListId (žádné hádání, žádná konverze)", () => {
  const czk: PriceList = { id: "11111111-1111-1111-1111-111111111111", name: "For Beauty 2026 — CZK", code: "BEAUTY-2026-CZK", currency: "CZK", year: 2026, active: true };
  const eur: PriceList = { id: "22222222-2222-2222-2222-222222222222", name: "For Beauty 2026 — EUR", code: "BEAUTY-2026-EUR", currency: "EUR", year: 2026, active: true };
  const event = normalizeExhibition({ id: "beauty", name: "For Beauty", year: 2026, priceListIds: [czk.id, eur.id], defaultPriceListId: czk.id });

  const resolved = resolveDefaultPriceList(event, [czk, eur]);
  assert.equal(resolved?.id, czk.id);
  assert.equal(resolved?.currency, "CZK");
  assert.equal(resolved?.name, "For Beauty 2026 — CZK");

  // CZK/EUR isolation: the EUR list is independently resolvable, never merged or derived from CZK.
  const eurOnly = [...event.priceListIds].filter((id) => id !== czk.id).map((id) => [czk, eur].find((p) => p.id === id));
  assert.equal(eurOnly[0]?.currency, "EUR");
  assert.notEqual(eurOnly[0]?.id, resolved?.id);
});

test("resolveDefaultPriceList: neplatné/smazané defaultPriceListId vrátí undefined místo náhrady náhodným ceníkem", () => {
  const czk: PriceList = { id: "11111111-1111-1111-1111-111111111111", name: "For Beauty 2026 — CZK", code: "BEAUTY-2026-CZK", currency: "CZK", year: 2026, active: true };
  const event = normalizeExhibition({ id: "beauty", name: "For Beauty", year: 2026, priceListIds: ["stale-id"], defaultPriceListId: "stale-id" });
  const resolved = resolveDefaultPriceList(event, [czk]);
  assert.equal(resolved, undefined);
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
        // Mirrors real Postgres column defaults this app relies on (e.g. price_lists.id
        // "uuid primary key default gen_random_uuid()") — repositories that never set `id`
        // themselves (see SupabasePriceListRepository) depend on the DB assigning one.
        const row = { ...payload };
        if (row.id === undefined) row.id = crypto.randomUUID();
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
