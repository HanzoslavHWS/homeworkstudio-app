import assert from "node:assert/strict";
import test from "node:test";
import { createSupabaseEventIdResolver, isEventForeignKeyViolation, UNKNOWN_EVENT_MESSAGE } from "../lib/db/eventIdValidation.server.ts";

// ============================================================================
// Corrective batch — event-ID consistency audit, sections 8/9. `createSupabaseEventIdResolver`
// only ever queries the SMALL, targeted candidate set actually relevant to one request (the input
// id and its documented legacy alias, if any) — never a full-table scan — so these tests assert
// against a fake Supabase query builder that records exactly which ids were requested.
// ============================================================================

type FakeEventsTable = { id: string }[];

function fakeSupabaseClient(existingEventIds: readonly string[]) {
  const queried: string[][] = [];
  return {
    client: {
      from(table: string) {
        assert.equal(table, "events");
        return {
          select() {
            return this;
          },
          in(_column: string, values: readonly string[]) {
            queried.push([...values]);
            const rows: FakeEventsTable = values.filter((id) => existingEventIds.includes(id)).map((id) => ({ id }));
            return Promise.resolve({ data: rows, error: null });
          },
        };
      },
    } as unknown as import("@supabase/supabase-js").SupabaseClient,
    queried,
  };
}

test("createSupabaseEventIdResolver: an already-canonical id present in the DB resolves unchanged", async () => {
  const { client } = fakeSupabaseClient(["beauty", "arch"]);
  const resolve = createSupabaseEventIdResolver(client);
  const result = await resolve("beauty");
  assert.deepEqual(result, { ok: true, eventId: "beauty" });
});

test("createSupabaseEventIdResolver: a legacy alias id resolves to the real DB id when the alias TARGET actually exists", async () => {
  const { client, queried } = fakeSupabaseClient(["beauty", "arch"]);
  const resolve = createSupabaseEventIdResolver(client);
  const result = await resolve("for-beauty-autumn-2026");
  assert.deepEqual(result, { ok: true, eventId: "beauty" });
  assert.deepEqual(queried[0]?.sort(), ["beauty", "for-beauty-autumn-2026"].sort(), "queries only the input id + its documented alias target, never a full table scan");
});

test("createSupabaseEventIdResolver: a truly unknown id fails clearly, in Czech, never leaking Postgres internals", async () => {
  const { client } = fakeSupabaseClient(["beauty", "arch"]);
  const resolve = createSupabaseEventIdResolver(client);
  const result = await resolve("totally-unknown-id");
  assert.deepEqual(result, { ok: false, message: UNKNOWN_EVENT_MESSAGE });
});

test("createSupabaseEventIdResolver: an alias whose target does NOT exist in the DB still fails — never trusts the alias table alone", async () => {
  const { client } = fakeSupabaseClient(["arch"]); // "beauty" itself missing this time
  const resolve = createSupabaseEventIdResolver(client);
  const result = await resolve("for-beauty-autumn-2026");
  assert.deepEqual(result, { ok: false, message: UNKNOWN_EVENT_MESSAGE });
});

test("createSupabaseEventIdResolver: empty/undefined eventId resolves ok with no event, never queries the DB at all", async () => {
  const { client, queried } = fakeSupabaseClient(["beauty"]);
  const resolve = createSupabaseEventIdResolver(client);
  assert.deepEqual(await resolve(undefined), { ok: true, eventId: undefined });
  assert.deepEqual(await resolve(null), { ok: true, eventId: undefined });
  assert.deepEqual(await resolve(""), { ok: true, eventId: undefined });
  assert.equal(queried.length, 0, "a project with no fair must never trigger a DB round trip");
});

test("createSupabaseEventIdResolver: propagates a genuine Supabase query error rather than swallowing it", async () => {
  const client = {
    from() {
      return { select() { return this; }, in() { return Promise.resolve({ data: null, error: new Error("network down") }); } };
    },
  } as unknown as import("@supabase/supabase-js").SupabaseClient;
  const resolve = createSupabaseEventIdResolver(client);
  await assert.rejects(() => resolve("beauty"), /network down/u);
});

// ============================================================================
// isEventForeignKeyViolation — defense-in-depth classifier for a raw Postgres FK error that slips
// past the pre-insert resolver above.
// ============================================================================

test("isEventForeignKeyViolation: the EXACT real production error shape is classified correctly", () => {
  const realError = {
    code: "23503",
    details: 'Key (event_id)=(for-beauty-autumn-2026) is not present in table "events".',
    hint: null,
    message: 'insert or update on table "technical_raster_projects" violates foreign key constraint "technical_raster_projects_event_id_fkey"',
  };
  assert.equal(isEventForeignKeyViolation(realError), true);
});

test("isEventForeignKeyViolation: a DIFFERENT foreign-key violation (unrelated column) is never misclassified as an event-reference problem", () => {
  const unrelatedFk = { code: "23503", details: 'Key (catalog_item_id)=(abc) is not present in table "catalog_items".', message: "violates foreign key constraint" };
  assert.equal(isEventForeignKeyViolation(unrelatedFk), false);
});

test("isEventForeignKeyViolation: a non-FK error (wrong code) is never classified as an event reference problem", () => {
  assert.equal(isEventForeignKeyViolation({ code: "23505", message: "duplicate key event_id" }), false);
});

test("isEventForeignKeyViolation: null/undefined/non-object/plain Error inputs never throw, always return false unless they genuinely match", () => {
  assert.equal(isEventForeignKeyViolation(null), false);
  assert.equal(isEventForeignKeyViolation(undefined), false);
  assert.equal(isEventForeignKeyViolation("a string"), false);
  assert.equal(isEventForeignKeyViolation(new Error("some generic failure")), false);
});
