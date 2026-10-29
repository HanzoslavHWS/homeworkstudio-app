import assert from "node:assert/strict";
import test from "node:test";
import {
  createTechnicalRasterProject,
  effectiveServicePlacements,
  mergeTechnicalRasterImportWithDiff,
  placeTechnicalService,
  requiredPlacementCount,
  withRasterStandLabels,
  type ParsedTechnicalReport,
  type TechnicalImportServiceDiff,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
  type TechnicalService,
} from "../domain/technicalRaster.ts";
import { resolveServiceIdentityKey } from "../domain/technicalRasterReconciliation.ts";
import { resolveLegacyServiceIdentityKey, resolveServicePresentation } from "../domain/technicalRasterServicePresentation.ts";
import { APPROVED_TECHNICAL_MARKER_ROWS } from "../domain/technicalMarkerApprovedTable.ts";
import { projectToRow, rowToProject, type TechnicalRasterProjectRow } from "../lib/db/technicalRasterProjectRepository.supabase.ts";
import type { StoredAsset } from "../domain/assets.ts";

// =========================================================================================
// HOTFIX-02 — internal service identity vs display label. Before the fix several different
// services shared one identity ("Rozvaděč 9-21kW" = "Do 21kW 400V" = electricity|21kw, "Non stop" =
// "Lednicový okruh" = electricity|refrigerated); an incremental re-import pairs old and new rows by
// that identity in report order, so a changed column order moved placements between them. These
// tests pin the old AND the new identifiers and prove an older saved project keeps its placements.
// =========================================================================================

type Row = readonly [label: string, quantity: number];

function asset(id: string): StoredAsset {
  return { id, storageKey: `k/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 1, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-import" };
}

let importCounter = 0;
function reimport(project: TechnicalRasterProject, category: string, services: readonly Row[]): { project: TechnicalRasterProject; diff?: TechnicalImportServiceDiff } {
  importCounter += 1;
  const record: TechnicalRasterImport = { id: `imp-${importCounter}`, category, filename: `${category}.xlsx`, asset: asset(`a${importCounter}`), importedAt: "2026-10-29T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: 1, servicesFound: services.length, warnings: [] };
  const report: ParsedTechnicalReport = { category, rows: [{ standNumber: "4C06", services: services.map(([externalLabel, quantity]) => ({ category, externalLabel, quantity, rawValue: String(quantity), sourcePage: 1 })), notes: [] }], warnings: [] };
  const previous = project.imports.find((existing) => existing.category === category && !existing.supersededByImportId);
  return mergeTechnicalRasterImportWithDiff(project, record, report, () => ({ status: "unresolved_product" as const }), previous?.id);
}

function newProject(): TechnicalRasterProject {
  return withRasterStandLabels(createTechnicalRasterProject({ name: "H4" }, "p"), [
    { id: "l", page: 1, rawText: "4C06", normalizedStandNumber: "4C06", xNormalized: 0.5, yNormalized: 0.5, widthNormalized: 0.02, heightNormalized: 0.01 },
  ]);
}

function service(project: TechnicalRasterProject, label: string): TechnicalService {
  const found = project.stands[0]!.services.find((candidate) => candidate.externalLabel === label);
  assert.ok(found, `${label} exists`);
  return found;
}

function placeAll(project: TechnicalRasterProject, label: string, x: number): TechnicalRasterProject {
  let next = project;
  const target = service(next, label);
  for (let index = effectiveServicePlacements(target).length; index < requiredPlacementCount(target); index += 1) {
    next = placeTechnicalService(next, next.stands[0]!.id, target.id, { page: 1, xNormalized: x + index * 0.01, yNormalized: 0.4 });
  }
  return next;
}

/** Supabase save -> JSON -> reload, exactly what an older saved project goes through. */
function saveAndReload(project: TechnicalRasterProject): TechnicalRasterProject {
  const row = projectToRow(project);
  const stored = JSON.parse(JSON.stringify(row)) as Omit<TechnicalRasterProjectRow, "id" | "created_at" | "updated_at">;
  return rowToProject({ ...stored, id: project.id, created_at: project.createdAt, updated_at: project.updatedAt } as TechnicalRasterProjectRow);
}

test("LEGACY ids: the colliding pairs really shared one identity before HOTFIX-02 (the bug these tests guard)", () => {
  assert.equal(resolveLegacyServiceIdentityKey("electricity", "Rozvaděč 9-21kW"), "electricity|21kw");
  assert.equal(resolveLegacyServiceIdentityKey("electricity", "Do 21kW 400V"), "electricity|21kw");
  assert.equal(resolveLegacyServiceIdentityKey("electricity", "Non stop"), "electricity|refrigerated");
  assert.equal(resolveLegacyServiceIdentityKey("electricity", "Lednicový okruh"), "electricity|refrigerated");
});

test("NEW ids: every colliding pair is now distinct; Internet ≠ Router and Osvětlení ≠ Vrchní přívod stay distinct", () => {
  const pairs: readonly [string, string, string][] = [
    ["electricity", "Do 21kW 400V", "Rozvaděč 9-21kW"],
    ["electricity", "Lednicový okruh", "Non stop"],
    ["electricity", "Osvětlení", "Vrchní přívod"],
    ["internet", "Internet", "Router zapůjčení"],
  ];
  for (const [category, a, b] of pairs) assert.notEqual(resolveServiceIdentityKey(category, a), resolveServiceIdentityKey(category, b), `${a} ≠ ${b}`);
  assert.equal(resolveServiceIdentityKey("electricity", "Rozvaděč 9-21kW"), "electricity|electricity:distribution-board");
  assert.equal(resolveServiceIdentityKey("electricity", "Non stop"), "electricity|electricity:non-stop");
});

test("NEW ids == LEGACY ids for every approved service that never collided (no needless identity churn)", () => {
  const changedOnPurpose = new Set(["Rozvaděč 9-21kW", "Non stop", "Vrchní přívod", "Osvětlení", "+ kW", "Jistič C", "Jistič D", "Bazén - přípojka", "Bazén - objem"]);
  for (const row of APPROVED_TECHNICAL_MARKER_ROWS) {
    const legacy = resolveLegacyServiceIdentityKey(row.category, row.abraName);
    const current = resolveServiceIdentityKey(row.category, row.abraName);
    if (changedOnPurpose.has(row.abraName)) assert.notEqual(current, legacy, `${row.abraName}: deliberately a new id`);
    else assert.equal(current, legacy, `${row.abraName}: id unchanged`);
  }
});

test("REIMPORT with swapped column order: Rozvaděč 9-21kW and Do 21kW 400V keep their OWN placements (was: they swapped)", () => {
  let project = reimport(newProject(), "electricity", [["Rozvaděč 9-21kW", 1], ["Do 21kW 400V", 2]]).project;
  project = placeAll(placeAll(project, "Rozvaděč 9-21kW", 0.1), "Do 21kW 400V", 0.6);
  const before = { board: service(project, "Rozvaděč 9-21kW"), do21: service(project, "Do 21kW 400V") };
  const { project: after, diff } = reimport(project, "electricity", [["Do 21kW 400V", 2], ["Rozvaděč 9-21kW", 1]]);
  assert.deepEqual(service(after, "Rozvaděč 9-21kW"), { ...before.board, sourceImportId: service(after, "Rozvaděč 9-21kW").sourceImportId });
  assert.deepEqual(service(after, "Do 21kW 400V").placements, before.do21.placements);
  assert.equal(service(after, "Do 21kW 400V").id, before.do21.id);
  assert.equal(diff!.unchanged, 2);
});

test("REIMPORT with swapped order: Non stop and Lednicový okruh keep their own placements and labels", () => {
  let project = reimport(newProject(), "electricity", [["Lednicový okruh", 1], ["Non stop", 1]]).project;
  project = placeAll(placeAll(project, "Lednicový okruh", 0.2), "Non stop", 0.7);
  const fridge = service(project, "Lednicový okruh");
  const nonStop = service(project, "Non stop");
  const { project: after } = reimport(project, "electricity", [["Non stop", 1], ["Lednicový okruh", 1]]);
  assert.deepEqual([service(after, "Lednicový okruh").id, service(after, "Lednicový okruh").placements], [fridge.id, fridge.placements]);
  assert.deepEqual([service(after, "Non stop").id, service(after, "Non stop").placements], [nonStop.id, nonStop.placements]);
  assert.deepEqual([resolveServicePresentation(fridge).displayLabel, resolveServicePresentation(nonStop).displayLabel], ["LED", "Non-stop"]);
});

test("OLDER SAVED PROJECT (created before HOTFIX-02, nothing about identities stored) reloads and re-imports without losing a single placement", () => {
  // A project as an older version saved it: plain services, placements, no variant/identity field anywhere.
  let project = reimport(newProject(), "electricity", [["Rozvaděč 9-21kW", 1], ["Do 21kW 400V", 1], ["Lednicový okruh", 2], ["Non stop", 1], ["Osvětlení", 1], ["Vrchní přívod", 1]]).project;
  for (const [label, x] of [["Rozvaděč 9-21kW", 0.1], ["Do 21kW 400V", 0.2], ["Lednicový okruh", 0.3], ["Non stop", 0.5], ["Osvětlení", 0.6], ["Vrchní přívod", 0.7]] as const) project = placeAll(project, label, x);
  const stored = saveAndReload(project);
  assert.ok(!JSON.stringify(projectToRow(stored)).includes("variantId"), "identities are never persisted — nothing to migrate");
  const placementsBefore = new Map(stored.stands[0]!.services.map((item) => [item.externalLabel, item.placements]));

  // New version, same report but a different column order.
  const { project: after, diff } = reimport(stored, "electricity", [["Vrchní přívod", 1], ["Non stop", 1], ["Do 21kW 400V", 1], ["Osvětlení", 1], ["Lednicový okruh", 2], ["Rozvaděč 9-21kW", 1]]);
  for (const [label, placements] of placementsBefore) assert.deepEqual(service(after, label).placements, placements, label);
  assert.deepEqual([diff!.unchanged, diff!.added, diff!.removed], [6, 0, 0]);
});

test("DYNAMIC LABEL: 'Bazén - objem' 3 -> 5 keeps the SAME service and its ONE placement; only the text changes 3 m³ -> 5 m³", () => {
  let project = reimport(newProject(), "water", [["Bazén - objem", 3]]).project;
  assert.equal(requiredPlacementCount(service(project, "Bazén - objem")), 1);
  project = placeAll(project, "Bazén - objem", 0.4);
  const before = service(project, "Bazén - objem");
  assert.equal(resolveServicePresentation(before).displayLabel, "3 m³");
  const { project: after, diff } = reimport(project, "water", [["Bazén - objem", 5]]);
  const now = service(after, "Bazén - objem");
  assert.equal(now.id, before.id);
  assert.deepEqual(now.placements, before.placements, "existing point keeps its exact position");
  assert.equal(resolveServicePresentation(now).displayLabel, "5 m³");
  assert.deepEqual([diff!.quantityIncreased, diff!.changes[0]!.removedPlacementCount], [1, 0]);
  assert.equal(requiredPlacementCount(now), 1, "still one point — nothing new to place");
});

test("POINT RULE: 'Bazén - přípojka' needs one point regardless of quantity; 'Voda, odpad' one per unit", () => {
  const project = reimport(newProject(), "water", [["Bazén - přípojka", 3], ["Voda, odpad", 2]]).project;
  assert.equal(requiredPlacementCount(service(project, "Bazén - přípojka")), 1);
  assert.equal(requiredPlacementCount(service(project, "Voda, odpad")), 2);
});
