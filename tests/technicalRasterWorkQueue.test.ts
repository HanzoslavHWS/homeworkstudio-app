import assert from "node:assert/strict";
import test from "node:test";
import {
  assignStandManually,
  createTechnicalRasterProject,
  mergeTechnicalRasterImport,
  placeTechnicalService,
  removeTechnicalServicePlacement,
  type ParsedTechnicalReport,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
} from "../domain/technicalRaster.ts";
import {
  computeStandPlacementProgress,
  computeTechnicalRasterPlacementSummary,
  groupStandsByPlacementWorkQueue,
  isStandPlacementComplete,
  resolveNextPlacementTarget,
  standHasPointServices,
} from "../domain/technicalRasterWorkQueue.ts";
import type { StoredAsset } from "../domain/assets.ts";

function makeAsset(id: string): StoredAsset {
  return { id, storageKey: `technical-rasters/p1/source/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-source" };
}

function makeImport(category: string, id: string): TechnicalRasterImport {
  return { id, category, filename: `${category}.pdf`, asset: makeAsset(`import-${id}`), importedAt: "2026-01-01T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: 1, servicesFound: 1, warnings: [] };
}

const alwaysUnresolved = () => ({ status: "unresolved_product" as const });

/** One matched stand ("1A21") with the given services (category/label/quantity triples), each from its own import so distinct categories merge correctly. */
function buildMatchedStand(services: readonly Readonly<{ category: string; externalLabel: string; quantity: number }>[]): Readonly<{ project: TechnicalRasterProject; standId: string }> {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  let importCounter = 0;
  for (const service of services) {
    importCounter += 1;
    const report: ParsedTechnicalReport = {
      category: service.category,
      rows: [{ standNumber: "1A21", services: [{ category: service.category, externalLabel: service.externalLabel, quantity: service.quantity, rawValue: String(service.quantity), sourcePage: 1 }], notes: [] }],
      warnings: [],
    };
    project = mergeTechnicalRasterImport(project, makeImport(service.category, `imp-${importCounter}`), report, alwaysUnresolved);
  }
  const standId = project.stands[0]!.id;
  project = assignStandManually(project, standId, { page: 1, anchorXNormalized: 0.2, anchorYNormalized: 0.3 });
  return { project, standId };
}

test("0 point services -> Bez bodových služeb bucket (never toPlace, never done)", () => {
  const { project } = buildMatchedStand([{ category: "cleaning", externalLabel: "Denní úklid", quantity: 40 }]);
  const queue = groupStandsByPlacementWorkQueue(project.stands);
  assert.equal(queue.noPointServices.length, 1);
  assert.equal(queue.toPlace.length, 0);
  assert.equal(queue.done.length, 0);
});

test("A) stand with a point service, 0 placements -> K umístění (toPlace), never done", () => {
  const { project, standId } = buildMatchedStand([{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 3 }]);
  const stand = project.stands.find((s) => s.id === standId)!;
  assert.equal(isStandPlacementComplete(stand), false);
  const queue = groupStandsByPlacementWorkQueue(project.stands);
  assert.equal(queue.toPlace.length, 1);
  assert.equal(queue.done.length, 0);
});

test("B) 2/3 placed -> still K umístění, progress reads 2/3", () => {
  let { project, standId } = buildMatchedStand([{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 3 }]);
  const serviceId = project.stands[0]!.services[0]!.id;
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.2, yNormalized: 0.2 });
  const stand = project.stands.find((s) => s.id === standId)!;
  assert.deepEqual(computeStandPlacementProgress(stand), { placedCount: 2, totalCount: 3 });
  assert.equal(isStandPlacementComplete(stand), false);
  assert.equal(groupStandsByPlacementWorkQueue(project.stands).toPlace.length, 1);
});

test("C) 3/3 placed -> Hotovo", () => {
  let { project, standId } = buildMatchedStand([{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 3 }]);
  const serviceId = project.stands[0]!.services[0]!.id;
  for (const point of [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }, { x: 0.3, y: 0.3 }]) {
    project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: point.x, yNormalized: point.y });
  }
  const stand = project.stands.find((s) => s.id === standId)!;
  assert.equal(isStandPlacementComplete(stand), true);
  const queue = groupStandsByPlacementWorkQueue(project.stands);
  assert.equal(queue.done.length, 1);
  assert.equal(queue.toPlace.length, 0);
});

test("D) removing one placement from a done stand -> back to K umístění", () => {
  let { project, standId } = buildMatchedStand([{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1 }]);
  const serviceId = project.stands[0]!.services[0]!.id;
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  const placementId = project.stands[0]!.services[0]!.placements![0]!.id;
  assert.equal(isStandPlacementComplete(project.stands[0]!), true);

  project = removeTechnicalServicePlacement(project, standId, serviceId, placementId);
  const stand = project.stands.find((s) => s.id === standId)!;
  assert.equal(isStandPlacementComplete(stand), false, "removing the placement must un-complete the stand purely because it's recomputed from live data");
  assert.equal(groupStandsByPlacementWorkQueue(project.stands).toPlace.length, 1);
});

test("E) informational services (WIFI) never block Hotovo", () => {
  let { project, standId } = buildMatchedStand([
    { category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1 },
    { category: "internet", externalLabel: "WIFI", quantity: 5 },
  ]);
  const electricityServiceId = project.stands[0]!.services.find((s) => s.category === "electricity")!.id;
  project = placeTechnicalService(project, standId, electricityServiceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  const stand = project.stands.find((s) => s.id === standId)!;
  assert.equal(isStandPlacementComplete(stand), true, "the unplaced WIFI(qty=5) service must never block completeness");
});

test("F) cleaning qty=40 (none) never blocks Hotovo", () => {
  let { project, standId } = buildMatchedStand([
    { category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1 },
    { category: "cleaning", externalLabel: "Denní úklid", quantity: 40 },
  ]);
  const electricityServiceId = project.stands[0]!.services.find((s) => s.category === "electricity")!.id;
  project = placeTechnicalService(project, standId, electricityServiceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  const stand = project.stands.find((s) => s.id === standId)!;
  assert.equal(isStandPlacementComplete(stand), true);
  assert.equal(computeStandPlacementProgress(stand).totalCount, 1, "cleaning's own qty=40 must never leak into the point-count denominator");
});

test("G) qty=2 is correctly counted (0/2 -> 1/2 -> 2/2)", () => {
  let { project, standId } = buildMatchedStand([{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 2 }]);
  const serviceId = project.stands[0]!.services[0]!.id;
  assert.deepEqual(computeStandPlacementProgress(project.stands[0]!), { placedCount: 0, totalCount: 2 });
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  assert.deepEqual(computeStandPlacementProgress(project.stands[0]!), { placedCount: 1, totalCount: 2 });
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.2, yNormalized: 0.2 });
  assert.deepEqual(computeStandPlacementProgress(project.stands[0]!), { placedCount: 2, totalCount: 2 });
});

test("H) summary: stand count only counts matched stands WITH point services", () => {
  const { project: p1 } = buildMatchedStand([{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1 }]);
  let project = p1;
  // Add a second matched stand with only an informational service (no point services at all).
  const report: ParsedTechnicalReport = { category: "waste", rows: [{ standNumber: "1A22", services: [{ category: "waste", externalLabel: "Kontejn 1100 l", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("waste", "imp-x"), report, alwaysUnresolved);
  const secondStandId = project.stands.find((s) => s.standNumber === "1A22")!.id;
  project = assignStandManually(project, secondStandId, { page: 1, anchorXNormalized: 0.5, anchorYNormalized: 0.5 });

  const summary = computeTechnicalRasterPlacementSummary(project.stands);
  assert.equal(summary.standCountWithPointServices, 1, "the waste-only stand never counts on either side");
  assert.equal(summary.doneStandCount, 0);
  assert.equal(standHasPointServices(project.stands.find((s) => s.standNumber === "1A22")!), false);
});

test("I) summary: placement point counts aggregate correctly across stands", () => {
  let { project, standId } = buildMatchedStand([{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 3 }]);
  const serviceId = project.stands[0]!.services[0]!.id;
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  const summary = computeTechnicalRasterPlacementSummary(project.stands);
  assert.equal(summary.placedPointCount, 1);
  assert.equal(summary.totalPointCount, 3);
});

// ============================================================================
// Auto-advance (spec section 35)
// ============================================================================

test("auto-advance: service A qty1, service B qty1 -> place A moves target to B, then placing B completes the stand", () => {
  let { project, standId } = buildMatchedStand([
    { category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1 },
    { category: "electricity", externalLabel: "Lednicový okruh", quantity: 1 },
  ]);
  const stand = project.stands[0]!;
  const serviceA = stand.services.find((s) => s.externalLabel === "Do 3kW 230V")!;
  const serviceB = stand.services.find((s) => s.externalLabel === "Lednicový okruh")!;

  const beforeAny = resolveNextPlacementTarget(stand, undefined);
  assert.equal(beforeAny?.serviceId, serviceA.id, "'Umístit chybějící postupně' with no current target starts on the first missing service");

  project = placeTechnicalService(project, standId, serviceA.id, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  const afterA = resolveNextPlacementTarget(project.stands[0]!, serviceA.id);
  assert.equal(afterA?.serviceId, serviceB.id, "A is done -> auto-advance targets B next");

  project = placeTechnicalService(project, standId, serviceB.id, { page: 1, xNormalized: 0.2, yNormalized: 0.2 });
  const afterB = resolveNextPlacementTarget(project.stands[0]!, serviceB.id);
  assert.equal(afterB, undefined, "both done -> no next target, stand is complete");
  assert.equal(isStandPlacementComplete(project.stands[0]!), true);
});

test("auto-advance: qty=2 -> first click stays on the SAME service (1 remaining), second click advances/completes", () => {
  let { project, standId } = buildMatchedStand([{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 2 }]);
  const serviceId = project.stands[0]!.services[0]!.id;

  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  const afterFirst = resolveNextPlacementTarget(project.stands[0]!, serviceId);
  assert.equal(afterFirst?.serviceId, serviceId, "qty=2 with 1 placed -> stay targeting the SAME service");

  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.2, yNormalized: 0.2 });
  const afterSecond = resolveNextPlacementTarget(project.stands[0]!, serviceId);
  assert.equal(afterSecond, undefined, "qty=2 with 2 placed -> no more targets");
});

test("resolveNextPlacementTarget: a stand with no point services at all resolves to undefined", () => {
  const { project } = buildMatchedStand([{ category: "cleaning", externalLabel: "Denní úklid", quantity: 40 }]);
  assert.equal(resolveNextPlacementTarget(project.stands[0]!, undefined), undefined);
});
