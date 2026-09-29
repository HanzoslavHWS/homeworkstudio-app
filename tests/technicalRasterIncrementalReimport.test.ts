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
  type RasterStandLabel,
  type TechnicalImportServiceDiff,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
  type TechnicalService,
} from "../domain/technicalRaster.ts";
import { groupStandsByPlacementWorkQueue } from "../domain/technicalRasterWorkQueue.ts";
import { resolveServiceIdentityKey } from "../domain/technicalRasterReconciliation.ts";
import type { StoredAsset } from "../domain/assets.ts";

// =========================================================================================
// Incremental re-import of a technical-service report. Root cause of the old behavior: a re-import
// (replaceImportId) deleted every service of the previous import — placements included — and created
// every row again with a new random id. Now services are paired by stable identity
// (stand + resolveServiceIdentityKey) and only the real difference is applied.
// =========================================================================================

type Row = Readonly<{ stand: string; services: readonly (readonly [label: string, quantity: number])[] }>;

const STANDS = ["3A20", "3A21", "3A22"];
const LABELS: readonly RasterStandLabel[] = STANDS.map((standNumber, index) => ({ id: `label-${standNumber}`, page: 1, rawText: standNumber, normalizedStandNumber: standNumber, xNormalized: 0.1 + index * 0.2, yNormalized: 0.5, widthNormalized: 0.02, heightNormalized: 0.01 }));

function asset(id: string): StoredAsset {
  return { id, storageKey: `k/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 1, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-import" };
}

let importCounter = 0;
function reimport(project: TechnicalRasterProject, category: string, rows: readonly Row[]): { project: TechnicalRasterProject; diff?: TechnicalImportServiceDiff; importId: string } {
  importCounter += 1;
  const record: TechnicalRasterImport = { id: `imp-${category}-${importCounter}`, category, filename: `${category}.pdf`, asset: asset(`a${importCounter}`), importedAt: "2026-09-29T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: rows.length, servicesFound: 0, warnings: [] };
  const report: ParsedTechnicalReport = {
    category,
    rows: rows.map((row) => ({ standNumber: row.stand, services: row.services.map(([externalLabel, quantity]) => ({ category, externalLabel, quantity, rawValue: String(quantity), sourcePage: 1 })), notes: [] })),
    warnings: [],
  };
  const previous = project.imports.find((existing) => existing.category === category && !existing.supersededByImportId);
  const result = mergeTechnicalRasterImportWithDiff(project, record, report, () => ({ status: "unresolved_product" as const }), previous?.id);
  return { ...result, importId: record.id };
}

function newProject(): TechnicalRasterProject {
  return withRasterStandLabels(createTechnicalRasterProject({ name: "H3" }, "p"), LABELS);
}

function service(project: TechnicalRasterProject, stand: string, label: string): TechnicalService {
  const found = project.stands.find((candidate) => candidate.standNumber === stand)?.services.find((candidate) => candidate.externalLabel === label);
  assert.ok(found, `${stand} ${label} exists`);
  return found;
}

function findService(project: TechnicalRasterProject, stand: string, label: string): TechnicalService | undefined {
  return project.stands.find((candidate) => candidate.standNumber === stand)?.services.find((candidate) => candidate.externalLabel === label);
}

/** Places every required point of a service, at distinct recognizable coordinates. */
function placeAll(project: TechnicalRasterProject, stand: string, label: string, x = 0.3): TechnicalRasterProject {
  const standId = project.stands.find((candidate) => candidate.standNumber === stand)!.id;
  let next = project;
  const target = service(next, stand, label);
  for (let index = effectiveServicePlacements(target).length; index < requiredPlacementCount(target); index += 1) {
    next = placeTechnicalService(next, standId, target.id, { page: 1, xNormalized: x + index * 0.01, yNormalized: 0.4 });
  }
  return next;
}

function toPlaceStandNumbers(project: TechnicalRasterProject): string[] {
  const matched = project.stands.filter((stand) => stand.placement.status === "matched_auto" || stand.placement.status === "matched_manual");
  return groupStandsByPlacementWorkQueue(matched).toPlace.map((stand) => stand.standNumber).sort();
}

const EL_3KW = "Do 3kW 230V";
const EL_2KW = "Do 2kW 230V";

// =========================================================================================

test("A) identical report re-imported: same service ids, same placements, nothing back in K UMÍSTĚNÍ", () => {
  let project = reimport(newProject(), "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }, { stand: "3A21", services: [[EL_2KW, 2]] }]).project;
  project = placeAll(placeAll(project, "3A20", EL_3KW), "3A21", EL_2KW, 0.6);
  const before = [service(project, "3A20", EL_3KW), service(project, "3A21", EL_2KW)];
  assert.deepEqual(toPlaceStandNumbers(project), []);

  const { project: after, diff } = reimport(project, "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }, { stand: "3A21", services: [[EL_2KW, 2]] }]);
  const afterServices = [service(after, "3A20", EL_3KW), service(after, "3A21", EL_2KW)];
  assert.deepEqual(afterServices.map((item) => item.id), before.map((item) => item.id), "service ids stable");
  assert.deepEqual(afterServices.map((item) => item.placements), before.map((item) => item.placements), "placements identical (ids + coordinates)");
  assert.deepEqual(toPlaceStandNumbers(after), [], "nothing returned to K UMÍSTĚNÍ");
  assert.deepEqual({ ...diff, changes: diff!.changes.length }, { unchanged: 2, added: 0, removed: 0, quantityIncreased: 0, quantityDecreased: 0, changes: 0 });
  assert.equal(afterServices[0]!.sourceImportId, after.imports.at(-1)!.id, "the kept service now belongs to the new import");
  assert.ok(after.imports.at(-2)!.supersededByImportId, "old import kept in history as superseded");
});

test("B) added service: existing placements kept, only the new service is unplaced", () => {
  let project = reimport(newProject(), "internet", [{ stand: "3A20", services: [["Internet", 1]] }]).project;
  project = placeAll(project, "3A20", "Internet");
  const internetBefore = service(project, "3A20", "Internet");

  const { project: after, diff } = reimport(project, "internet", [{ stand: "3A20", services: [["Internet", 1], ["Pevná IP", 1]] }]);
  assert.deepEqual(service(after, "3A20", "Internet"), { ...internetBefore, sourceImportId: service(after, "3A20", "Internet").sourceImportId });
  assert.equal(effectiveServicePlacements(service(after, "3A20", "Pevná IP")).length, 0);
  assert.deepEqual(toPlaceStandNumbers(after), ["3A20"]);
  assert.deepEqual([diff!.unchanged, diff!.added], [1, 1]);
  assert.equal(diff!.changes[0]!.kind, "added");
  assert.equal(diff!.changes[0]!.externalLabel, "Pevná IP");
});

test("C) removed service: only its marker disappears, every other placement stays", () => {
  let project = reimport(newProject(), "internet", [{ stand: "3A20", services: [["Internet", 1], ["Router zapůjčení", 1]] }]).project;
  project = placeAll(placeAll(project, "3A20", "Internet"), "3A20", "Router zapůjčení", 0.5);
  const internetPlacements = service(project, "3A20", "Internet").placements;

  const { project: after, diff } = reimport(project, "internet", [{ stand: "3A20", services: [["Internet", 1]] }]);
  assert.equal(findService(after, "3A20", "Router zapůjčení"), undefined, "router service (and its marker) gone");
  assert.deepEqual(service(after, "3A20", "Internet").placements, internetPlacements);
  assert.deepEqual([diff!.removed, diff!.changes[0]!.removedPlacementCount], [1, 1]);
});

test("D) quantity 1 -> 2: the original marker stays exactly, exactly ONE new point is needed", () => {
  let project = reimport(newProject(), "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }]).project;
  project = placeAll(project, "3A20", EL_3KW);
  const original = service(project, "3A20", EL_3KW);

  const { project: after, diff } = reimport(project, "electricity", [{ stand: "3A20", services: [[EL_3KW, 2]] }]);
  const updated = service(after, "3A20", EL_3KW);
  assert.equal(updated.id, original.id);
  assert.deepEqual(updated.placements, original.placements, "original point untouched");
  assert.equal(requiredPlacementCount(updated) - effectiveServicePlacements(updated).length, 1, "exactly one new unplaced piece");
  assert.deepEqual(toPlaceStandNumbers(after), ["3A20"]);
  assert.deepEqual([diff!.quantityIncreased, diff!.changes[0]!.previousQuantity, diff!.changes[0]!.quantity], [1, 1, 2]);
});

test("E) quantity 2 -> 1: the FIRST placement stays, only the surplus one is removed (deterministic)", () => {
  let project = reimport(newProject(), "electricity", [{ stand: "3A20", services: [[EL_3KW, 2]] }]).project;
  project = placeAll(project, "3A20", EL_3KW);
  const [first] = service(project, "3A20", EL_3KW).placements!;

  const { project: after, diff } = reimport(project, "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }]);
  assert.deepEqual(service(after, "3A20", EL_3KW).placements, [first]);
  assert.deepEqual([diff!.quantityDecreased, diff!.changes[0]!.removedPlacementCount], [1, 1]);
  assert.deepEqual(toPlaceStandNumbers(after), []);
});

test("E2) onePerRecord service (WiFi 5 -> 3): quantity changes, its single marker is kept", () => {
  let project = reimport(newProject(), "internet", [{ stand: "3A20", services: [["WIFI", 5]] }]).project;
  project = placeAll(project, "3A20", "WIFI");
  const placements = service(project, "3A20", "WIFI").placements;
  const { project: after } = reimport(project, "internet", [{ stand: "3A20", services: [["WIFI", 3]] }]);
  assert.deepEqual(service(after, "3A20", "WIFI").placements, placements);
});

test("F) a change on one stand never affects another stand's placements", () => {
  let project = reimport(newProject(), "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }, { stand: "3A21", services: [[EL_3KW, 1]] }, { stand: "3A22", services: [[EL_3KW, 1]] }]).project;
  for (const stand of STANDS) project = placeAll(project, stand, EL_3KW);
  const untouched = ["3A21", "3A22"].map((stand) => service(project, stand, EL_3KW));

  const { project: after } = reimport(project, "electricity", [{ stand: "3A20", services: [[EL_3KW, 3]] }, { stand: "3A21", services: [[EL_3KW, 1]] }, { stand: "3A22", services: [[EL_3KW, 1]] }]);
  assert.deepEqual(["3A21", "3A22"].map((stand) => service(after, stand, EL_3KW)).map((item) => [item.id, item.placements]), untouched.map((item) => [item.id, item.placements]));
  assert.deepEqual(toPlaceStandNumbers(after), ["3A20"]);
});

test("F2) a stand missing from the new report loses only this category's services; the stand and its other categories stay", () => {
  let project = reimport(newProject(), "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }, { stand: "3A21", services: [[EL_3KW, 1]] }]).project;
  project = reimport(project, "internet", [{ stand: "3A21", services: [["Internet", 1]] }]).project;
  project = placeAll(placeAll(project, "3A21", EL_3KW), "3A21", "Internet", 0.7);
  const internet = service(project, "3A21", "Internet");
  const { project: after, diff } = reimport(project, "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }]);
  assert.equal(findService(after, "3A21", EL_3KW), undefined);
  assert.deepEqual(service(after, "3A21", "Internet"), internet, "other category untouched");
  assert.equal(after.stands.find((stand) => stand.standNumber === "3A21")!.placement.status, "matched_auto", "stand matching untouched");
  assert.equal(diff!.removed, 1);
});

test("G) several service types on one stand never swap identities (plain internet / fixed IP / router / WiFi)", () => {
  const rows: readonly Row[] = [{ stand: "3A20", services: [["Internet", 1], ["Pevná IP", 1], ["Router zapůjčení", 1], ["WIFI", 2]] }];
  let project = reimport(newProject(), "internet", rows).project;
  project = placeAll(project, "3A20", "Internet", 0.1);
  project = placeAll(project, "3A20", "Pevná IP", 0.2);
  project = placeAll(project, "3A20", "Router zapůjčení", 0.3);
  project = placeAll(project, "3A20", "WIFI", 0.4);
  const before = rows[0]!.services.map(([label]) => service(project, "3A20", label));
  // Same services, different order in the new report.
  const { project: after, diff } = reimport(project, "internet", [{ stand: "3A20", services: [["WIFI", 2], ["Router zapůjčení", 1], ["Pevná IP", 1], ["Internet", 1]] }]);
  for (const previous of before) {
    const now = service(after, "3A20", previous.externalLabel);
    assert.equal(now.id, previous.id, previous.externalLabel);
    assert.deepEqual(now.placements, previous.placements, previous.externalLabel);
  }
  assert.equal(diff!.unchanged, 4);
  assert.deepEqual(new Set(before.map((item) => resolveServiceIdentityKey(item.category, item.externalLabel))).size, 4, "four distinct identities");
});

test("G2) water and electricity imports never touch each other", () => {
  let project = reimport(newProject(), "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }]).project;
  project = reimport(project, "water", [{ stand: "3A20", services: [["voda, odpad", 1]] }]).project;
  project = placeAll(placeAll(project, "3A20", EL_3KW), "3A20", "voda, odpad", 0.8);
  const water = service(project, "3A20", "voda, odpad");
  const { project: after } = reimport(project, "electricity", [{ stand: "3A20", services: [[EL_2KW, 1]] }]);
  assert.deepEqual(service(after, "3A20", "voda, odpad"), water);
});

test("H) service type change (2 kW -> 3 kW) = removed + added; the placement is NOT carried over", () => {
  let project = reimport(newProject(), "electricity", [{ stand: "3A20", services: [[EL_2KW, 1]] }]).project;
  project = placeAll(project, "3A20", EL_2KW);
  const old = service(project, "3A20", EL_2KW);
  const { project: after, diff } = reimport(project, "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }]);
  const created = service(after, "3A20", EL_3KW);
  assert.equal(findService(after, "3A20", EL_2KW), undefined);
  assert.notEqual(created.id, old.id);
  assert.equal(effectiveServicePlacements(created).length, 0);
  assert.deepEqual([diff!.added, diff!.removed], [1, 1]);
});

test("H2) same identity, reworded label: kept (label refreshed) — a different unrecognized electricity label is NOT the same service", () => {
  let project = reimport(newProject(), "electricity", [{ stand: "3A20", services: [["Do 3 kW 230V", 1], ["Jistič 3x16A", 1]] }]).project;
  project = placeAll(placeAll(project, "3A20", "Do 3 kW 230V"), "3A20", "Jistič 3x16A", 0.6);
  const kw = service(project, "3A20", "Do 3 kW 230V");
  const { project: after, diff } = reimport(project, "electricity", [{ stand: "3A20", services: [["Do 3kW 230V", 1], ["Jistič 3x32A", 1]] }]);
  const refreshed = service(after, "3A20", "Do 3kW 230V");
  assert.equal(refreshed.id, kw.id);
  assert.deepEqual(refreshed.placements, kw.placements);
  assert.equal(effectiveServicePlacements(service(after, "3A20", "Jistič 3x32A")).length, 0, "different breaker = new unplaced service");
  assert.deepEqual([diff!.unchanged, diff!.added, diff!.removed], [1, 1, 1]);
});

test("I) determinism: re-importing the same report repeatedly never changes ids/placements/order or creates duplicates", () => {
  const rows: readonly Row[] = [{ stand: "3A20", services: [[EL_3KW, 2], [EL_2KW, 1]] }, { stand: "3A21", services: [[EL_3KW, 1]] }];
  let project = reimport(newProject(), "electricity", rows).project;
  project = placeAll(placeAll(project, "3A20", EL_3KW), "3A21", EL_3KW, 0.6);
  const snapshot = (value: TechnicalRasterProject) => value.stands.map((stand) => [stand.id, stand.standNumber, stand.services.map((item) => [item.id, item.externalLabel, item.quantity, item.placements ?? []])]);
  const baseline = snapshot(project);
  for (let run = 0; run < 3; run += 1) {
    project = reimport(project, "electricity", rows).project;
    assert.deepEqual(snapshot(project), baseline, `run ${run + 1}`);
  }
  assert.equal(project.imports.filter((record) => !record.supersededByImportId).length, 1, "one active import");
});

test("I2) duplicate rows with the same identity on one stand pair in stable order (first old <-> first new)", () => {
  let project = reimport(newProject(), "electricity", [{ stand: "3A20", services: [[EL_3KW, 1], [EL_3KW, 1]] }]).project;
  const [firstOld, secondOld] = project.stands[0]!.services;
  const standId = project.stands[0]!.id;
  project = placeTechnicalService(project, standId, firstOld!.id, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  const { project: after, diff } = reimport(project, "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }]);
  assert.deepEqual(after.stands[0]!.services.map((item) => item.id), [firstOld!.id], "first kept, second removed");
  assert.equal(effectiveServicePlacements(after.stands[0]!.services[0]!).length, 1);
  assert.equal(diff!.removed, 1);
  assert.notEqual(secondOld!.id, firstOld!.id);
});

test("SPEC EXAMPLE: 3A20 electricity + internet + router all placed -> new internet report 'Internet 2×' (router gone)", () => {
  let project = reimport(newProject(), "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }]).project;
  project = reimport(project, "internet", [{ stand: "3A20", services: [["Internet", 1], ["Router zapůjčení", 1]] }]).project;
  project = placeAll(placeAll(placeAll(project, "3A20", EL_3KW, 0.1), "3A20", "Internet", 0.2), "3A20", "Router zapůjčení", 0.3);
  const electricity = service(project, "3A20", EL_3KW);
  const internetPlacement = service(project, "3A20", "Internet").placements![0];

  const { project: after, diff } = reimport(project, "internet", [{ stand: "3A20", services: [["Internet", 2]] }]);
  assert.deepEqual(service(after, "3A20", EL_3KW), electricity, "electricity marker kept");
  const internet = service(after, "3A20", "Internet");
  assert.deepEqual(internet.placements, [internetPlacement], "internet piece 1 kept");
  assert.equal(requiredPlacementCount(internet) - effectiveServicePlacements(internet).length, 1, "internet piece 2 -> K UMÍSTĚNÍ");
  assert.equal(findService(after, "3A20", "Router zapůjčení"), undefined, "router removed, marker gone");
  assert.deepEqual([diff!.unchanged, diff!.quantityIncreased, diff!.removed], [0, 1, 1]);
});

test("FIRST import of a category is unchanged behavior: no diff, everything unplaced", () => {
  const { project, diff } = reimport(newProject(), "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }]);
  assert.equal(diff, undefined);
  assert.equal(project.imports[0]!.serviceDiff, undefined);
  assert.deepEqual(toPlaceStandNumbers(project), ["3A20"]);
});

test("The diff is stored on the new import record (history can show it after reload)", () => {
  const project = reimport(newProject(), "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }]).project;
  const { project: after, diff } = reimport(project, "electricity", [{ stand: "3A20", services: [[EL_3KW, 1]] }, { stand: "3A21", services: [[EL_2KW, 1]] }]);
  assert.deepEqual(after.imports.at(-1)!.serviceDiff, diff);
  assert.equal(diff!.added, 1);
});
