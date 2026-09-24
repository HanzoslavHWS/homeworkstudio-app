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
  type TechnicalStand,
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

test("CORRECTIVE BATCH (real production): 0 point services -> Bez bodových služeb bucket (never toPlace, never done) — the real remaining example is a stand with ZERO services at all (a catalog-only stand), since every recognized category is now placeable", () => {
  const { project: base } = buildMatchedStand([{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1 }]);
  const catalogOnlyStand: TechnicalStand = {
    id: "stand-catalog-only",
    standNumber: "1A22",
    services: [],
    notes: [],
    placement: { status: "matched_manual", rasterPage: 1, anchorXNormalized: 0.5, anchorYNormalized: 0.5, matchMethod: "manual" },
    sourceImportIds: [],
    hasCatalogBuildRecord: true,
  };
  const project: TechnicalRasterProject = { ...base, stands: [catalogOnlyStand] };
  const queue = groupStandsByPlacementWorkQueue(project.stands);
  assert.equal(queue.noPointServices.length, 1);
  assert.equal(queue.toPlace.length, 0);
  assert.equal(queue.done.length, 0);
});

test("CORRECTIVE BATCH (real production): cleaning qty=40 IS now a point service — a stand with only cleaning goes to K umístění (toPlace), never 'Bez bodových služeb'", () => {
  const { project } = buildMatchedStand([{ category: "cleaning", externalLabel: "Denní úklid", quantity: 40 }]);
  const queue = groupStandsByPlacementWorkQueue(project.stands);
  assert.equal(queue.toPlace.length, 1, "cleaning is now placeable — an unplaced cleaning record needs its own marker");
  assert.equal(queue.noPointServices.length, 0);
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

test("PRODUCTION BATCH (real production): E) WiFi is onePerRecord — an unplaced WIFI(qty=5) blocks Hotovo until exactly ONE point is placed, never all 5", () => {
  let { project, standId } = buildMatchedStand([
    { category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1 },
    { category: "internet", externalLabel: "WIFI", quantity: 5 },
  ]);
  const electricityServiceId = project.stands[0]!.services.find((s) => s.category === "electricity")!.id;
  const wifiServiceId = project.stands[0]!.services.find((s) => s.category === "internet")!.id;
  project = placeTechnicalService(project, standId, electricityServiceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  const afterElectricityOnly = project.stands.find((s) => s.id === standId)!;
  assert.equal(isStandPlacementComplete(afterElectricityOnly), false, "the required single WiFi point is still unplaced — must NOT read as complete");

  project = placeTechnicalService(project, standId, wifiServiceId, { page: 1, xNormalized: 0.1, yNormalized: 0.2 });
  const stand = project.stands.find((s) => s.id === standId)!;
  assert.equal(isStandPlacementComplete(stand), true, "once electricity + exactly ONE WiFi point are placed, the stand IS complete — never 5");
  assert.equal(stand.services.find((s) => s.category === "internet")!.quantity, 5, "the raw imported quantity is preserved for diagnostics, only the REQUIRED placement count changes");

  // A second WiFi placement attempt is refused (no-op) — requiredPlacementCount is 1, not 5.
  const beforeSecondAttempt = project;
  project = placeTechnicalService(project, standId, wifiServiceId, { page: 1, xNormalized: 0.3, yNormalized: 0.3 });
  assert.deepEqual(project, beforeSecondAttempt, "a second WiFi placement must be refused once the single required point already exists");
});

test("CORRECTIVE BATCH (real production): F) cleaning qty=40 (onePerRecord) needs exactly ONE placement to reach Hotovo, never blocks on the raw quantity", () => {
  let { project, standId } = buildMatchedStand([
    { category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1 },
    { category: "cleaning", externalLabel: "Denní úklid", quantity: 40 },
  ]);
  const electricityServiceId = project.stands[0]!.services.find((s) => s.category === "electricity")!.id;
  const cleaningServiceId = project.stands[0]!.services.find((s) => s.category === "cleaning")!.id;
  project = placeTechnicalService(project, standId, electricityServiceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  const afterElectricityOnly = project.stands.find((s) => s.id === standId)!;
  assert.equal(isStandPlacementComplete(afterElectricityOnly), false, "cleaning's own required 1 marker is still unplaced");

  project = placeTechnicalService(project, standId, cleaningServiceId, { page: 1, xNormalized: 0.2, yNormalized: 0.2 });
  const stand = project.stands.find((s) => s.id === standId)!;
  assert.equal(isStandPlacementComplete(stand), true, "exactly ONE cleaning marker (never 40) completes the stand");
  assert.equal(computeStandPlacementProgress(stand).totalCount, 2, "electricity(1) + cleaning(1, onePerRecord) = 2 — cleaning's own qty=40 must never leak into the point-count denominator");
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

test("CORRECTIVE BATCH (real production): H) summary: stand count only counts matched stands WITH point services — waste is now itself a point service, so the remaining real 'no point services' example is a catalog-only stand with ZERO services", () => {
  const { project: p1 } = buildMatchedStand([{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1 }]);
  const catalogOnlyStand: TechnicalStand = {
    id: "stand-catalog-only",
    standNumber: "1A22",
    services: [],
    notes: [],
    placement: { status: "matched_manual", rasterPage: 1, anchorXNormalized: 0.5, anchorYNormalized: 0.5, matchMethod: "manual" },
    sourceImportIds: [],
    hasCatalogBuildRecord: true,
  };
  const project: TechnicalRasterProject = { ...p1, stands: [...p1.stands, catalogOnlyStand] };

  const summary = computeTechnicalRasterPlacementSummary(project.stands);
  assert.equal(summary.standCountWithPointServices, 1, "the services-less catalog-only stand never counts on either side");
  assert.equal(summary.doneStandCount, 0);
  assert.equal(standHasPointServices(catalogOnlyStand), false);
});

test("CORRECTIVE BATCH (real production): waste is now itself a point service — a matched waste-only stand DOES count toward standCountWithPointServices", () => {
  const { project: p1 } = buildMatchedStand([{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1 }]);
  let project = p1;
  const report: ParsedTechnicalReport = { category: "waste", rows: [{ standNumber: "1A22", services: [{ category: "waste", externalLabel: "Kontejn 1100 l", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("waste", "imp-x"), report, alwaysUnresolved);
  const secondStandId = project.stands.find((s) => s.standNumber === "1A22")!.id;
  project = assignStandManually(project, secondStandId, { page: 1, anchorXNormalized: 0.5, anchorYNormalized: 0.5 });

  const summary = computeTechnicalRasterPlacementSummary(project.stands);
  assert.equal(summary.standCountWithPointServices, 2, "both the electricity stand AND the (now placeable) waste stand count");
  assert.equal(standHasPointServices(project.stands.find((s) => s.standNumber === "1A22")!), true);
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

test("CORRECTIVE BATCH (real production): resolveNextPlacementTarget: a stand with no point services at all (zero services) resolves to undefined", () => {
  const catalogOnlyStand: TechnicalStand = {
    id: "stand-catalog-only",
    standNumber: "1A22",
    services: [],
    notes: [],
    placement: { status: "matched_manual", rasterPage: 1, anchorXNormalized: 0.5, anchorYNormalized: 0.5, matchMethod: "manual" },
    sourceImportIds: [],
    hasCatalogBuildRecord: true,
  };
  assert.equal(resolveNextPlacementTarget(catalogOnlyStand, undefined), undefined);
});

test("CORRECTIVE BATCH (real production): resolveNextPlacementTarget: cleaning qty=40 IS now a real point service — targets it like any other missing point", () => {
  const { project } = buildMatchedStand([{ category: "cleaning", externalLabel: "Denní úklid", quantity: 40 }]);
  const target = resolveNextPlacementTarget(project.stands[0]!, undefined);
  assert.equal(target?.serviceId, project.stands[0]!.services[0]!.id);
});
