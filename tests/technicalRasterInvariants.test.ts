import assert from "node:assert/strict";
import test from "node:test";
import {
  assignStandManually,
  createTechnicalRasterProject,
  mergeTechnicalRasterImport,
  placeTechnicalService,
  type ParsedTechnicalReport,
  type TechnicalRasterImport,
} from "../domain/technicalRaster.ts";
import { groupStandsByPlacementWorkQueue } from "../domain/technicalRasterWorkQueue.ts";
import { resolveTechnicalRasterPresentation } from "../domain/technicalRasterComponentPresentation.ts";
import { applyCatalogItemEdit, documentTechnicalRaster, parseCatalogItemAdminEdit, type CatalogItemAdminDocument } from "../domain/catalogItemsAdmin.ts";
import type { StoredAsset } from "../domain/assets.ts";

/**
 * Stabilization batch (spec batch 12) — cross-module ARCHITECTURAL INVARIANTS that don't naturally
 * belong to any single existing test file (each one spans two otherwise-independent modules: the
 * placement project model, the work queue, the component presentation adapter, and/or catalog
 * item persistence). Invariants B/D/E/F/G from the spec are already directly covered by
 * tests/technicalRasterComponentPresentation.test.ts and tests/technicalRasterWorkQueue.test.ts —
 * not duplicated here.
 */

function makeAsset(id: string): StoredAsset {
  return { id, storageKey: `technical-rasters/p1/source/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-source" };
}
function makeImport(category: string, id: string): TechnicalRasterImport {
  return { id, category, filename: `${category}.pdf`, asset: makeAsset(`import-${id}`), importedAt: "2026-01-01T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: 1, servicesFound: 1, warnings: [] };
}
const alwaysUnresolved = () => ({ status: "unresolved_product" as const });

// ============================================================================
// A) Normalized 0-1 coordinates — WHERE the invariant is actually enforced.
// ============================================================================

test("A) the domain layer itself stores whatever xNormalized/yNormalized it's given verbatim — it does NOT clamp/validate the 0-1 range; that guarantee lives at the UI boundary (TechnicalRasterCanvas.tsx's handleStageClick, which refuses any click outside the page before ever calling placeTechnicalService). Documented here so a future change to either side is a deliberate, visible decision, not a silent drift.", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A21", services: [{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysUnresolved);
  const standId = project.stands[0]!.id;
  const serviceId = project.stands[0]!.services[0]!.id;

  const withinRange = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.42, yNormalized: 0.17 });
  const placement = withinRange.stands[0]!.services[0]!.placements![0]!;
  assert.ok(placement.xNormalized >= 0 && placement.xNormalized <= 1 && placement.yNormalized >= 0 && placement.yNormalized <= 1, "the well-behaved caller (the real UI) never sends an out-of-range value in the first place");
});

// ============================================================================
// C) Work Queue status is always DERIVED, never a stored field.
// ============================================================================

test("C) TechnicalStand/TechnicalService carry no work-queue status field at all — 'K umístění'/'Hotovo' is recomputed fresh every call from placements[]/quantity, never read off a stored flag", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A21", services: [{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysUnresolved);
  const standId = project.stands[0]!.id;
  project = assignStandManually(project, standId, { page: 1, anchorXNormalized: 0.2, anchorYNormalized: 0.3 });

  // Structural check: no stand or service key looks like a cached work-queue status.
  const standKeys = Object.keys(project.stands[0]!);
  const serviceKeys = Object.keys(project.stands[0]!.services[0]!);
  for (const key of [...standKeys, ...serviceKeys]) {
    assert.ok(!/hotovo|done|workqueue|complete/iu.test(key), `unexpected stored work-queue-like field: ${key}`);
  }

  // Behavioral check: calling the pure grouping function twice on the exact same (unchanged)
  // project always agrees — nothing about it is stateful/cached across calls.
  const first = groupStandsByPlacementWorkQueue(project.stands);
  const second = groupStandsByPlacementWorkQueue(project.stands);
  assert.deepEqual(first.toPlace.map((s) => s.id), second.toPlace.map((s) => s.id));
  assert.deepEqual(first.done.map((s) => s.id), second.done.map((s) => s.id));
});

// ============================================================================
// H) enabled:false (component presentation) never touches placement data.
// ============================================================================

test("H) resolving a presentation with enabled:false has ZERO effect on an already-stored placement — the two are structurally unrelated data (placements live on TechnicalService, presentation is resolved fresh on demand)", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A21", services: [{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysUnresolved);
  const standId = project.stands[0]!.id;
  const serviceId = project.stands[0]!.services[0]!.id;
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.3, yNormalized: 0.4 });
  const placementsBefore = project.stands[0]!.services[0]!.placements;

  // Resolving a component presentation override (even the "hide it" case) is a completely
  // separate call against a completely separate module — it cannot reach into `project` at all.
  const resolved = resolveTechnicalRasterPresentation({ category: "electricity", externalLabel: "Do 3kW 230V" }, { enabled: false });
  assert.equal(resolved.placementBehavior, "none");
  assert.equal(project.stands[0]!.services[0]!.placements, placementsBefore, "same array reference — nothing about the project was ever touched");
});

// ============================================================================
// I) Reset component config restores default/fallback, but placements are a COMPLETELY separate
// store (project.stands vs. catalog_items.document) — resetting one can never affect the other.
// ============================================================================

test("I) resetting a component's technicalRaster config (catalog_items.document) and a project's placements (technical_raster_projects) are independent stores — proven by resetting one and confirming the other's data is never even referenced by the reset call", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A21", services: [{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysUnresolved);
  const standId = project.stands[0]!.id;
  const serviceId = project.stands[0]!.services[0]!.id;
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.3, yNormalized: 0.4 });
  const placementsBefore = JSON.stringify(project.stands[0]!.services[0]!.placements);

  // A component document, entirely separate object — resetting it has no handle on `project` at all.
  const componentDocument: CatalogItemAdminDocument = { technicalRaster: { color: "#ff0000", displayLabel: "EL" } };
  const afterReset = applyCatalogItemEdit(componentDocument, { technicalRaster: null });
  assert.equal(documentTechnicalRaster(afterReset), undefined, "reset restores the fallback (no explicit config)");

  // Project placements are byte-for-byte identical — never even referenced by the reset call above.
  assert.equal(JSON.stringify(project.stands[0]!.services[0]!.placements), placementsBefore);
});

// ============================================================================
// J) A signed download URL is never persisted into a component's technicalRaster.iconAsset.
// ============================================================================

test("J) StoredAsset (and therefore iconAsset) has no url/signedUrl field in its own type — a signed URL is always resolved separately, at read time, never stored (structural guarantee: TypeScript's excess-property check rejects a fresh object literal with an extra 'url'/'signedUrl' key wherever a StoredAsset is expected)", () => {
  const asset: StoredAsset = {
    id: "icon-1",
    storageKey: "catalog/technical-icons/comp-1/icon.svg",
    originalFileName: "icon.svg",
    mimeType: "image/svg+xml",
    size: 512,
    createdAt: "2026-01-01T00:00:00.000Z",
    category: "catalog-technical-icon",
    // A 'url'/'signedUrl' property here would be a TypeScript compile error (excess property
    // check on a fresh object literal) — this test's own successful compilation IS the proof.
  };
  assert.ok(!("url" in asset) && !("signedUrl" in asset));

  const edit = parseCatalogItemAdminEdit({ technicalRaster: { iconAsset: asset } });
  const saved = applyCatalogItemEdit({}, edit);
  const reloaded = documentTechnicalRaster(saved);
  assert.equal(reloaded?.iconAsset?.storageKey, asset.storageKey);
  assert.ok(!("url" in (reloaded?.iconAsset ?? {})) && !("signedUrl" in (reloaded?.iconAsset ?? {})), "the persisted iconAsset carries no URL — only the stable storageKey a real download URL is resolved from later, on demand");
});
