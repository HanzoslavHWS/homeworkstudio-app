import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { handleTechnicalRasterProjectSave } from "../app/api/technical-rasters/projects/save/route.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import { UNKNOWN_EVENT_MESSAGE, type EventIdResolver } from "../lib/db/eventIdValidation.server.ts";
import { createDefaultRasterSettings } from "../domain/technicalRaster.ts";
import type {
  TechnicalRasterProject,
  TechnicalRasterProjectCreateInput,
  TechnicalRasterProjectRepository,
  TechnicalRasterProjectSummary,
} from "../domain/technicalRaster.ts";

/**
 * Corrective batch — event-ID consistency audit, section 6: the real production failure
 * ("Key (event_id)=(for-beauty-autumn-2026) is not present in table 'events'") happened on THIS
 * exact route. These tests exercise the full request -> resolver -> repository path with a mocked
 * repository (never a live DB write) and an injectable event-id resolver (never a live Supabase
 * query), mirroring tests/dbApi.test.ts's own established pattern for the sibling booth-project route.
 */
const SECRET = "technical-raster-api-test-session-secret-32ch";
const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.APP_SESSION_SECRET = SECRET;

function authenticatedRequest(token: string | undefined, url: string, init: Readonly<{ method?: string; body?: unknown }> = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `homeworkstudio_session=${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest(url, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}

function fakeRepository(): TechnicalRasterProjectRepository {
  const rows = new Map<string, TechnicalRasterProject>();
  return {
    async list(): Promise<readonly TechnicalRasterProjectSummary[]> {
      return [...rows.values()].map((project) => ({
        id: project.id, name: project.name, eventId: project.eventId, hall: project.hall,
        hasRaster: false, standCount: 0, unassignedCount: 0, ambiguousCount: 0,
        createdBy: project.createdBy, createdAt: project.createdAt, updatedAt: project.updatedAt,
      }));
    },
    async get(id: string) { return rows.get(id); },
    async create(input: TechnicalRasterProjectCreateInput) {
      const project: TechnicalRasterProject = {
        id: `p-${rows.size + 1}`, name: input.name, eventId: input.eventId, hall: input.hall,
        rasterLayers: [], rasterSettings: createDefaultRasterSettings(),
        rasterStandLabels: [], imports: [], stands: [], createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      };
      rows.set(project.id, project);
      return project;
    },
    async save(project: TechnicalRasterProject) {
      const updated = { ...project, updatedAt: "2026-01-02T00:00:00.000Z" };
      rows.set(project.id, updated);
      return updated;
    },
    async delete(id: string) { rows.delete(id); },
  };
}

/** Mirrors tests/dbApi.test.ts's own fakeEventIdResolverFactory — resolves an id if it's directly known, or via the exact production alias map, never a live Supabase call. */
function fakeEventIdResolverFactory(knownIds: readonly string[] = []): () => EventIdResolver {
  const aliases: Record<string, string> = { "for-beauty-autumn-2026": "beauty", "for-decor-2026": "decor" };
  return () => async (eventId) => {
    const trimmed = eventId?.trim();
    if (!trimmed) return { ok: true, eventId: undefined };
    if (knownIds.includes(trimmed)) return { ok: true, eventId: trimmed };
    const alias = aliases[trimmed];
    if (alias && knownIds.includes(alias)) return { ok: true, eventId: alias };
    return { ok: false, message: UNKNOWN_EVENT_MESSAGE };
  };
}

test("technical raster save: creating a project with an already-canonical eventId ('beauty') succeeds", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeRepository();
  const response = await handleTechnicalRasterProjectSave(
    authenticatedRequest(token, "http://localhost/api/technical-rasters/projects/save", { method: "POST", body: { create: { name: "Hala 1", eventId: "beauty" } } }),
    () => repository,
    fakeEventIdResolverFactory(["beauty", "decor"]),
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { project: TechnicalRasterProject };
  assert.equal(body.project.eventId, "beauty");
});

test("technical raster save: THE REAL PRODUCTION FAILURE, reproduced and fixed — creating a project with the legacy 'for-beauty-autumn-2026' id is canonicalized to 'beauty' BEFORE the repository ever sees it", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeRepository();
  const response = await handleTechnicalRasterProjectSave(
    authenticatedRequest(token, "http://localhost/api/technical-rasters/projects/save", { method: "POST", body: { create: { name: "Hala 1", eventId: "for-beauty-autumn-2026" } } }),
    () => repository,
    fakeEventIdResolverFactory(["beauty", "decor"]),
  );
  assert.equal(response.status, 200, "must succeed — never the raw 502/FK-violation failure the real production bug produced");
  const body = await response.json() as { project: TechnicalRasterProject };
  assert.equal(body.project.eventId, "beauty", "the persisted project must reference the REAL canonical id, never the legacy one");
});

test("technical raster save: 'for-decor-2026' -> 'decor', the second confirmed legacy alias", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeRepository();
  const response = await handleTechnicalRasterProjectSave(
    authenticatedRequest(token, "http://localhost/api/technical-rasters/projects/save", { method: "POST", body: { create: { name: "Hala 2", eventId: "for-decor-2026" } } }),
    () => repository,
    fakeEventIdResolverFactory(["beauty", "decor"]),
  );
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { project: TechnicalRasterProject }).project.eventId, "decor");
});

test("technical raster save: a genuinely unknown eventId fails FAST with a clear Czech message and a 400 — never a raw FK violation, never the generic 'database unavailable' wording", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeRepository();
  const response = await handleTechnicalRasterProjectSave(
    authenticatedRequest(token, "http://localhost/api/technical-rasters/projects/save", { method: "POST", body: { create: { name: "Hala 1", eventId: "international-2026" } } }),
    () => repository,
    fakeEventIdResolverFactory(["beauty", "decor"]),
  );
  assert.equal(response.status, 400);
  const body = await response.json() as { error: string };
  assert.equal(body.error, UNKNOWN_EVENT_MESSAGE);
  assert.equal((await repository.list()).length, 0, "the repository must never be reached for an unresolvable event id");
});

test("technical raster save: no eventId at all (a project with no fair) succeeds, exactly as before this batch", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeRepository();
  const response = await handleTechnicalRasterProjectSave(
    authenticatedRequest(token, "http://localhost/api/technical-rasters/projects/save", { method: "POST", body: { create: { name: "Hala 1" } } }),
    () => repository,
    fakeEventIdResolverFactory(["beauty"]),
  );
  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { project: TechnicalRasterProject }).project.eventId, undefined);
});

test("technical raster save: updating an EXISTING project's eventId is validated too, not just creation", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeRepository();
  const created = await handleTechnicalRasterProjectSave(
    authenticatedRequest(token, "http://localhost/api/technical-rasters/projects/save", { method: "POST", body: { create: { name: "Hala 1" } } }),
    () => repository,
    fakeEventIdResolverFactory(["beauty"]),
  );
  const project = ((await created.json()) as { project: TechnicalRasterProject }).project;

  const badUpdate = await handleTechnicalRasterProjectSave(
    authenticatedRequest(token, "http://localhost/api/technical-rasters/projects/save", { method: "POST", body: { project: { ...project, eventId: "not-a-real-event" } } }),
    () => repository,
    fakeEventIdResolverFactory(["beauty"]),
  );
  assert.equal(badUpdate.status, 400);
  assert.equal(((await badUpdate.json()) as { error: string }).error, UNKNOWN_EVENT_MESSAGE);

  const goodUpdate = await handleTechnicalRasterProjectSave(
    authenticatedRequest(token, "http://localhost/api/technical-rasters/projects/save", { method: "POST", body: { project: { ...project, eventId: "beauty" } } }),
    () => repository,
    fakeEventIdResolverFactory(["beauty"]),
  );
  assert.equal(goodUpdate.status, 200);
});

test("technical raster save: a raw FK violation reaching the DB despite the pre-check (defense-in-depth) is STILL classified as an unknown-event error, never the generic 502 message", async () => {
  const token = await createSessionToken(SECRET);
  const throwingRepository: TechnicalRasterProjectRepository = {
    async list() { return []; },
    async get() { return undefined; },
    async create() {
      throw { code: "23503", details: 'Key (event_id)=(for-beauty-autumn-2026) is not present in table "events".', message: 'insert or update on table "technical_raster_projects" violates foreign key constraint "technical_raster_projects_event_id_fkey"' };
    },
    async save() { throw new Error("not used in this test"); },
    async delete() {},
  };
  // The resolver here "incorrectly" passes the id through (simulating some future bypass) so the
  // repository itself is what raises the raw Postgres error — this pins the SECOND safety net.
  const passthroughResolver: () => EventIdResolver = () => async (eventId) => ({ ok: true, eventId: eventId ?? undefined });
  const response = await handleTechnicalRasterProjectSave(
    authenticatedRequest(token, "http://localhost/api/technical-rasters/projects/save", { method: "POST", body: { create: { name: "Hala 1", eventId: "for-beauty-autumn-2026" } } }),
    () => throwingRepository,
    passthroughResolver,
  );
  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, UNKNOWN_EVENT_MESSAGE, "must never fall through to the generic 'nepodařilo se uložit do databáze' message for THIS specific failure class");
});

test("technical raster save: an unrelated generic DB error still produces the existing generic 502 message, unchanged", async () => {
  const token = await createSessionToken(SECRET);
  const throwingRepository: TechnicalRasterProjectRepository = {
    async list() { return []; },
    async get() { return undefined; },
    async create() { throw new Error("connection reset"); },
    async save() { throw new Error("not used"); },
    async delete() {},
  };
  const response = await handleTechnicalRasterProjectSave(
    authenticatedRequest(token, "http://localhost/api/technical-rasters/projects/save", { method: "POST", body: { create: { name: "Hala 1" } } }),
    () => throwingRepository,
    fakeEventIdResolverFactory([]),
  );
  assert.equal(response.status, 502);
  assert.equal(((await response.json()) as { error: string }).error, "Projekt technického rastru se nepodařilo uložit do databáze.");
});
