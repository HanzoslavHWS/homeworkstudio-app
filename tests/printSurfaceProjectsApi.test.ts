import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { handlePrintSurfaceProjectsList } from "../app/api/print-surfaces/projects/list/route.ts";
import { handlePrintSurfaceProjectGet } from "../app/api/print-surfaces/projects/get/route.ts";
import { handlePrintSurfaceProjectSave } from "../app/api/print-surfaces/projects/save/route.ts";
import { handlePrintSurfaceProjectDelete } from "../app/api/print-surfaces/projects/delete/route.ts";
import { handlePrintSurfaceCatalogGet, handlePrintSurfaceCatalogReplace, type PrintSurfaceCatalogRepositories } from "../app/api/print-surfaces/catalog/route.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import {
  createPrintSurfaceProject,
  type PrintSurfaceProject,
  type PrintSurfaceProjectCreateInput,
  type PrintSurfaceProjectRepository,
  type PrintSurfaceProjectSummary,
} from "../domain/printSurfaceProject.ts";
import type { RealizationCompanyRepository } from "../domain/realizationCompany.ts";
import type { PrintSurfacePresetRepository } from "../domain/printSurfacePreset.ts";
import type { PrintSurfaceProductionDimensionRepository } from "../domain/printSurfaceProductionDimension.ts";

const SECRET = "print-surface-projects-test-session-secret-32ch";
const mutableEnv = process.env as Record<string, string | undefined>;
mutableEnv.APP_SESSION_SECRET = SECRET;

function authenticatedRequest(token: string | undefined, url: string, init: Readonly<{ method?: string; body?: unknown }> = {}) {
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `homeworkstudio_session=${token}`;
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return new NextRequest(url, { method: init.method ?? "GET", headers, body: init.body !== undefined ? JSON.stringify(init.body) : undefined });
}

let sequence = 0;

function fakeProjectRepository(seed: readonly PrintSurfaceProject[] = []): PrintSurfaceProjectRepository {
  const rows = new Map(seed.map((project) => [project.id, project]));
  return {
    async list(): Promise<readonly PrintSurfaceProjectSummary[]> {
      return [...rows.values()].map((project) => ({
        id: project.id, name: project.name, companyName: project.companyName, eventId: project.eventId,
        realizationCompanyId: project.realizationCompanyId, status: project.status, itemCount: project.items.length,
        createdBy: project.createdBy, createdAt: project.createdAt, updatedAt: project.updatedAt,
      }));
    },
    async get(id: string) { return rows.get(id); },
    async create(input: PrintSurfaceProjectCreateInput) {
      const project = createPrintSurfaceProject(input, `ps-${sequence++}`);
      rows.set(project.id, project);
      return project;
    },
    async save(project: PrintSurfaceProject) {
      const updated = { ...project, updatedAt: new Date().toISOString() };
      rows.set(project.id, updated);
      return updated;
    },
    async delete(id: string) { rows.delete(id); },
  };
}

test("LIST: bez přihlášení vrátí 401 a nesahá na repository", async () => {
  const repository = fakeProjectRepository([createPrintSurfaceProject({ name: "X", companyName: "Y" }, "ps-x")]);
  const response = await handlePrintSurfaceProjectsList(authenticatedRequest(undefined, "http://localhost/api/print-surfaces/projects/list"), () => repository);
  assert.equal(response.status, 401);
});

test("LIST: přihlášený požadavek vrátí seznam projektů jako summary (bez images/items)", async () => {
  const token = await createSessionToken(SECRET);
  const project = { ...createPrintSurfaceProject({ name: "Stánek XY", companyName: "ACME" }, "ps-1"), items: [{ id: "a", label: "A", typeId: "panel" as const, note: "", includeInCalculation: false }] };
  const repository = fakeProjectRepository([project]);
  const response = await handlePrintSurfaceProjectsList(authenticatedRequest(token, "http://localhost/api/print-surfaces/projects/list"), () => repository);
  assert.equal(response.status, 200);
  const body = await response.json() as { projects: PrintSurfaceProjectSummary[] };
  assert.equal(body.projects.length, 1);
  assert.equal(body.projects[0]?.itemCount, 1);
  assert.equal("items" in body.projects[0]!, false);
});

test("SAVE (create): vytvoří nový projekt se statusem draft", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeProjectRepository();
  const response = await handlePrintSurfaceProjectSave(
    authenticatedRequest(token, "http://localhost/api/print-surfaces/projects/save", { method: "POST", body: { create: { name: "Nový projekt", companyName: "ACME" } } }),
    () => repository,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { project: PrintSurfaceProject };
  assert.equal(body.project.status, "draft");
  assert.equal(body.project.name, "Nový projekt");
});

test("SAVE (create): prázdný název je odmítnut s 400, nikdy nevytvoří projekt bez názvu", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeProjectRepository();
  const response = await handlePrintSurfaceProjectSave(
    authenticatedRequest(token, "http://localhost/api/print-surfaces/projects/save", { method: "POST", body: { create: { name: "   ", companyName: "ACME" } } }),
    () => repository,
  );
  assert.equal(response.status, 400);
  assert.deepEqual(await repository.list(), []);
});

test("SAVE (update): existující projekt s id se aktualizuje, ne vytvoří druhý", async () => {
  const token = await createSessionToken(SECRET);
  const existing = createPrintSurfaceProject({ name: "Původní", companyName: "ACME" }, "ps-existing");
  const repository = fakeProjectRepository([existing]);
  const response = await handlePrintSurfaceProjectSave(
    authenticatedRequest(token, "http://localhost/api/print-surfaces/projects/save", { method: "POST", body: { project: { ...existing, name: "Přejmenováno" } } }),
    () => repository,
  );
  assert.equal(response.status, 200);
  const body = await response.json() as { project: PrintSurfaceProject };
  assert.equal(body.project.name, "Přejmenováno");
  assert.equal((await repository.list()).length, 1);
});

test("GET: neexistující projekt vrátí 404", async () => {
  const token = await createSessionToken(SECRET);
  const repository = fakeProjectRepository();
  const response = await handlePrintSurfaceProjectGet(authenticatedRequest(token, "http://localhost/api/print-surfaces/projects/get?id=missing"), () => repository);
  assert.equal(response.status, 404);
});

test("DELETE: odstraní projekt z repository", async () => {
  const token = await createSessionToken(SECRET);
  const project = createPrintSurfaceProject({ name: "Ke smazání", companyName: "ACME" }, "ps-delete");
  const repository = fakeProjectRepository([project]);
  const response = await handlePrintSurfaceProjectDelete(
    authenticatedRequest(token, "http://localhost/api/print-surfaces/projects/delete", { method: "POST", body: { id: "ps-delete" } }),
    () => repository,
  );
  assert.equal(response.status, 200);
  assert.equal(await repository.get("ps-delete"), undefined);
});

function fakeCatalogRepositories(): PrintSurfaceCatalogRepositories {
  let companies: Parameters<RealizationCompanyRepository["replaceAll"]>[0] = [];
  let presets: Parameters<PrintSurfacePresetRepository["replaceAll"]>[0] = [];
  let productionDimensions: Parameters<PrintSurfaceProductionDimensionRepository["replaceAll"]>[0] = [];
  return {
    companies: { async list() { return companies; }, async replaceAll(next) { companies = next; } },
    presets: { async list() { return presets; }, async replaceAll(next) { presets = next; } },
    productionDimensions: { async list() { return productionDimensions; }, async replaceAll(next) { productionDimensions = next; } },
  };
}

test("CATALOG POST: nahradí jen zaslanou entitu, ostatní zůstanou beze změny", async () => {
  const token = await createSessionToken(SECRET);
  const repositories = fakeCatalogRepositories();
  await repositories.presets.replaceAll([{ id: "Panel_S_100", typeId: "panel", name: "Panel", isActive: true }]);

  const response = await handlePrintSurfaceCatalogReplace(
    authenticatedRequest(token, "http://localhost/api/print-surfaces/catalog", { method: "POST", body: { companies: [{ id: "creativ-expo", name: "Creativ Expo", isActive: true }] } }),
    () => repositories,
  );
  assert.equal(response.status, 200);

  const getResponse = await handlePrintSurfaceCatalogGet(authenticatedRequest(token, "http://localhost/api/print-surfaces/catalog"), () => repositories);
  const body = await getResponse.json() as { companies: unknown[]; presets: unknown[] };
  assert.equal(body.companies.length, 1);
  assert.equal(body.presets.length, 1, "presets odeslané v předchozím requestu nesmí zmizet, když POST pošle jen companies");
});

test("CATALOG GET: bez přihlášení vrátí 401", async () => {
  const repositories = fakeCatalogRepositories();
  const response = await handlePrintSurfaceCatalogGet(authenticatedRequest(undefined, "http://localhost/api/print-surfaces/catalog"), () => repositories);
  assert.equal(response.status, 401);
});
