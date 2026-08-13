import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { handleProjectsList } from "../app/api/projects/list/route.ts";
import { handleProjectsSave } from "../app/api/projects/save/route.ts";
import { handleProjectsDelete } from "../app/api/projects/delete/route.ts";
import { handleEventsList } from "../app/api/events/list/route.ts";
import { handleEventsSave } from "../app/api/events/save/route.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import { ConcurrencyConflictError } from "../lib/db/concurrency.ts";
import { createProjectRecord } from "../domain/project.ts";
import { normalizeExhibition } from "../domain/organizations.ts";
import type { ProjectRecord } from "../domain/project.ts";
import type { Exhibition } from "../domain/organizations.ts";
import type { PersistedProjectRecord, PersistedExhibition, RemoteProjectRepository, RemoteEventRepository } from "../domain/remotePersistence.ts";
import { resolvePersistenceProbe } from "../lib/db/persistenceMode.client.ts";
import { RemoteApiUnavailableError } from "../lib/db/projectRepository.remoteApi.client.ts";

const SECRET = "api-route-test-session-secret-32ch";

const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.APP_SESSION_SECRET = SECRET;

function authenticatedRequest(token: string | undefined, url: string, init: Readonly<{ method?: string; body?: unknown }> = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `homeworkstudio_session=${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest(url, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}

function fakeProjectRepository(seed: readonly PersistedProjectRecord[] = []): RemoteProjectRepository {
  const rows = new Map(seed.map((project) => [project.id, project]));
  return {
    async list() { return [...rows.values()]; },
    async get(id) { return rows.get(id); },
    async getWithRevision(id) { return rows.get(id); },
    async save(project) { return this.saveWithRevision(project, rows.get(project.id)?.revision ?? null); },
    async saveWithRevision(project: ProjectRecord, expectedRevision: number | null) {
      const current = rows.get(project.id);
      if (expectedRevision === null) {
        if (current) throw new ConcurrencyConflictError("project", project.id);
        const persisted = { ...project, revision: 1 };
        rows.set(project.id, persisted);
        return persisted;
      }
      if (!current || current.revision !== expectedRevision) throw new ConcurrencyConflictError("project", project.id);
      const persisted = { ...project, revision: expectedRevision + 1 };
      rows.set(project.id, persisted);
      return persisted;
    },
    async delete(id) { rows.delete(id); },
  };
}

function fakeEventRepository(seed: readonly PersistedExhibition[] = []): RemoteEventRepository {
  const rows = new Map(seed.map((event) => [event.id, event]));
  return {
    async list() { return [...rows.values()]; },
    async getWithRevision(id) { return rows.get(id); },
    async save(event) { return this.saveWithRevision(event, rows.get(event.id)?.revision ?? null); },
    async saveWithRevision(event: Exhibition, expectedRevision: number | null) {
      const current = rows.get(event.id);
      if (expectedRevision === null) {
        if (current) throw new ConcurrencyConflictError("event", event.id);
        const persisted = { ...event, revision: 1 };
        rows.set(event.id, persisted);
        return persisted;
      }
      if (!current || current.revision !== expectedRevision) throw new ConcurrencyConflictError("event", event.id);
      const persisted = { ...event, revision: expectedRevision + 1 };
      rows.set(event.id, persisted);
      return persisted;
    },
  };
}

test("neautentizovaný požadavek na /api/projects/list je odmítnut s 401", async () => {
  const response = await handleProjectsList(authenticatedRequest(undefined, "http://localhost/api/projects/list"), () => fakeProjectRepository());
  assert.equal(response.status, 401);
});

test("neautentizovaný požadavek na /api/events/list je odmítnut s 401", async () => {
  const response = await handleEventsList(authenticatedRequest(undefined, "http://localhost/api/events/list"), () => fakeEventRepository());
  assert.equal(response.status, 401);
});

test("autentizovaný /api/projects/list vrátí projekty z repository", async () => {
  const token = await createSessionToken(SECRET);
  const seeded = { ...createProjectRecord({ id: "p1" }), revision: 1 };
  const response = await handleProjectsList(authenticatedRequest(token, "http://localhost/api/projects/list"), () => fakeProjectRepository([seeded]));
  assert.equal(response.status, 200);
  const body = await response.json() as { projects: ProjectRecord[] };
  assert.equal(body.projects.length, 1);
  assert.equal(body.projects[0]?.id, "p1");
});

test("autentizovaný /api/events/list vrátí eventy z repository", async () => {
  const token = await createSessionToken(SECRET);
  const seeded = { ...normalizeExhibition({ id: "e1", name: "Test" }), revision: 1 };
  const response = await handleEventsList(authenticatedRequest(token, "http://localhost/api/events/list"), () => fakeEventRepository([seeded]));
  assert.equal(response.status, 200);
  const body = await response.json() as { events: Exhibition[] };
  assert.equal(body.events.length, 1);
  assert.equal(body.events[0]?.id, "e1");
});

test("DB project create/read/update/delete přes API route (mockované repository, žádný live DB zápis)", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeProjectRepository();
  const factory = () => repository;
  const project = createProjectRecord({ id: "p-crud", company: "Test s.r.o." });

  const created = await handleProjectsSave(authenticatedRequest(token, "http://localhost/api/projects/save", { method: "POST", body: { project, expectedRevision: null } }), factory);
  assert.equal(created.status, 200);
  const createdBody = await created.json() as { project: PersistedProjectRecord };
  assert.equal(createdBody.project.revision, 1);

  const listed = await handleProjectsList(authenticatedRequest(token, "http://localhost/api/projects/list"), factory);
  const listedBody = await listed.json() as { projects: ProjectRecord[] };
  assert.equal(listedBody.projects.length, 1);

  const updated = await handleProjectsSave(authenticatedRequest(token, "http://localhost/api/projects/save", { method: "POST", body: { project: { ...project, company: "Změna" }, expectedRevision: 1 } }), factory);
  const updatedBody = await updated.json() as { project: PersistedProjectRecord };
  assert.equal(updatedBody.project.revision, 2);
  assert.equal(updatedBody.project.company, "Změna");

  const deleted = await handleProjectsDelete(authenticatedRequest(token, "http://localhost/api/projects/delete", { method: "POST", body: { id: "p-crud" } }), factory);
  assert.equal(deleted.status, 200);
  const afterDelete = await handleProjectsList(authenticatedRequest(token, "http://localhost/api/projects/list"), factory);
  assert.equal(((await afterDelete.json()) as { projects: ProjectRecord[] }).projects.length, 0);
});

test("DB event create/read/update přes API route (mockované repository)", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeEventRepository();
  const factory = () => repository;
  const event = normalizeExhibition({ id: "e-crud", name: "Test Event" });

  const created = await handleEventsSave(authenticatedRequest(token, "http://localhost/api/events/save", { method: "POST", body: { event, expectedRevision: null } }), factory);
  assert.equal(created.status, 200);
  const createdBody = await created.json() as { event: PersistedExhibition };
  assert.equal(createdBody.event.revision, 1);

  const updated = await handleEventsSave(authenticatedRequest(token, "http://localhost/api/events/save", { method: "POST", body: { event: { ...event, name: "Přejmenováno" }, expectedRevision: 1 } }), factory);
  const updatedBody = await updated.json() as { event: PersistedExhibition };
  assert.equal(updatedBody.event.revision, 2);
  assert.equal(updatedBody.event.name, "Přejmenováno");
});

test("zastaralá revision při /api/projects/save vrátí 409 se srozumitelnou zprávou", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeProjectRepository();
  const factory = () => repository;
  const project = createProjectRecord({ id: "p-conflict" });
  await handleProjectsSave(authenticatedRequest(token, "http://localhost/api/projects/save", { method: "POST", body: { project, expectedRevision: null } }), factory);
  await handleProjectsSave(authenticatedRequest(token, "http://localhost/api/projects/save", { method: "POST", body: { project, expectedRevision: 1 } }), factory);

  const stale = await handleProjectsSave(authenticatedRequest(token, "http://localhost/api/projects/save", { method: "POST", body: { project, expectedRevision: 1 } }), factory);
  assert.equal(stale.status, 409);
  const body = await stale.json() as { error: string };
  assert.match(body.error, /Data byla mezitím změněna jinde/u);
});

test("zastaralá revision při /api/events/save vrátí 409 se srozumitelnou zprávou", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeEventRepository();
  const factory = () => repository;
  const event = normalizeExhibition({ id: "e-conflict", name: "X" });
  await handleEventsSave(authenticatedRequest(token, "http://localhost/api/events/save", { method: "POST", body: { event, expectedRevision: null } }), factory);
  await handleEventsSave(authenticatedRequest(token, "http://localhost/api/events/save", { method: "POST", body: { event, expectedRevision: 1 } }), factory);

  const stale = await handleEventsSave(authenticatedRequest(token, "http://localhost/api/events/save", { method: "POST", body: { event, expectedRevision: 1 } }), factory);
  assert.equal(stale.status, 409);
  const body = await stale.json() as { error: string };
  assert.match(body.error, /Data byla mezitím změněna jinde/u);
});

test("resolvePersistenceProbe: 503 (Supabase nenakonfigurováno) ve vývoji vede na local-fallback s viditelným varováním", async () => {
  const original = process.env.NODE_ENV;
  mutableEnv.NODE_ENV = "development";
  try {
    const probe = await resolvePersistenceProbe(() => { throw new RemoteApiUnavailableError(503, "Supabase není nakonfigurováno."); });
    assert.equal(probe.mode, "local-fallback");
  } finally {
    mutableEnv.NODE_ENV = original;
  }
});

test("resolvePersistenceProbe: 503 v produkci NIKDY nepovede na local-fallback (žádné tiché localStorage jako cloud)", async () => {
  const original = process.env.NODE_ENV;
  mutableEnv.NODE_ENV = "production";
  try {
    const probe = await resolvePersistenceProbe(() => { throw new RemoteApiUnavailableError(503, "Supabase není nakonfigurováno."); });
    assert.equal(probe.mode, "unavailable");
  } finally {
    mutableEnv.NODE_ENV = original;
  }
});

test("resolvePersistenceProbe: jiná chyba než 503 (DB nakonfigurovaná, ale rozbitá) nikdy nepadne na local-fallback, ani ve vývoji", async () => {
  const original = process.env.NODE_ENV;
  mutableEnv.NODE_ENV = "development";
  try {
    const probe = await resolvePersistenceProbe(() => { throw new RemoteApiUnavailableError(502, "DB error."); });
    assert.equal(probe.mode, "unavailable");
  } finally {
    mutableEnv.NODE_ENV = original;
  }
});

test("resolvePersistenceProbe: úspěšný probe vrátí mode 'db' a přenese hodnotu bez druhého fetch", async () => {
  let calls = 0;
  const probe = await resolvePersistenceProbe(async () => { calls += 1; return ["a", "b"]; });
  assert.equal(probe.mode, "db");
  assert.equal(calls, 1);
  if (probe.mode === "db") assert.deepEqual(probe.value, ["a", "b"]);
});
