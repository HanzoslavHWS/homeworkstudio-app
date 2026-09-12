import assert from "node:assert/strict";
import test from "node:test";
import {
  assignStandManually,
  clearStandAssignment,
  createDefaultRasterSettings,
  createTechnicalRasterProject,
  effectiveHiddenLayerIds,
  effectiveWhiteFillOpacity,
  mergeTechnicalRasterImport,
  nextUnassignedStand,
  rematchStands,
  summarizeTechnicalRasterProject,
  withLayerVisibility,
  withRasterLayers,
  withRasterStandLabels,
  withRasterViewMode,
  withSourceRasterAsset,
  withWorkModeHiddenLayers,
  withWhiteFillOpacity,
  withoutTechnicalRasterProject,
  placeTechnicalService,
  moveTechnicalServicePlacement,
  removeTechnicalServicePlacement,
  effectiveServicePlacements,
  effectiveShowRealizations,
  effectiveIncludeRealizationsInExport,
  setStandRealizationCompany,
  withShowRealizations,
  withIncludeRealizationsInExport,
  mergeSupplementalCatalogImport,
  buildPrimaryReportMentions,
  DEFAULT_WHITE_FILL_OPACITY,
  type ParsedTechnicalReport,
  type RasterSettings,
  type RasterStandLabel,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
  type TechnicalRasterProjectSummary,
} from "../domain/technicalRaster.ts";
import type { StoredAsset } from "../domain/assets.ts";
import { resolveRealizationDisplayState } from "../domain/technicalRasterRealization.ts";
import { groupStandsByPlacementWorkQueue, computeTechnicalRasterPlacementSummary } from "../domain/technicalRasterWorkQueue.ts";

function makeAsset(id: string): StoredAsset {
  return { id, storageKey: `technical-rasters/p1/source/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-source" };
}

function makeLabel(standNumber: string, id: string): RasterStandLabel {
  return { id, rawText: standNumber, normalizedStandNumber: standNumber, page: 1, xNormalized: 0.2, yNormalized: 0.3, widthNormalized: 0.03, heightNormalized: 0.015 };
}

function makeImport(category: string, id: string): TechnicalRasterImport {
  return { id, category, filename: `${category}.pdf`, asset: makeAsset(`import-${id}`), importedAt: "2026-01-01T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: 1, servicesFound: 1, warnings: [] };
}

const alwaysResolved = () => ({ status: "unresolved_product" as const });

test("createTechnicalRasterProject: starts empty, draft-like, no raster/imports/stands", () => {
  const project = createTechnicalRasterProject({ name: "FOR DECOR 2026 — Hala 1" }, "p1", "2026-01-01T00:00:00.000Z");
  assert.equal(project.name, "FOR DECOR 2026 — Hala 1");
  assert.equal(project.sourceRasterAsset, undefined);
  assert.deepEqual(project.stands, []);
  assert.deepEqual(project.imports, []);
  assert.deepEqual(project.rasterSettings, createDefaultRasterSettings());
});

test("withSourceRasterAsset never touches anything else on the project", () => {
  const project = createTechnicalRasterProject({ name: "X" }, "p1");
  const withAsset = withSourceRasterAsset(project, makeAsset("raster-1"));
  assert.equal(withAsset.sourceRasterAsset?.id, "raster-1");
  assert.deepEqual(withAsset.stands, []);
});

test("withRasterLayers seeds visibility defaults without clobbering an already-set preference", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  project = withRasterLayers(project, [{ id: "STANDS", name: "STÁNKY", defaultVisible: true }]);
  assert.equal(project.rasterSettings.layerVisibility.STANDS, true);
  project = withLayerVisibility(project, "STANDS", false);
  // re-applying the SAME layer list must not reset the user's explicit choice back to defaultVisible.
  project = withRasterLayers(project, [{ id: "STANDS", name: "STÁNKY", defaultVisible: true }]);
  assert.equal(project.rasterSettings.layerVisibility.STANDS, false);
});

test("effectiveHiddenLayerIds: original mode only hides explicitly-off layers; work mode ALSO hides workModeHiddenLayerIds", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  project = withRasterViewMode(project, "original"); // viewMode defaults to "work" (spec section 19) — start from "original" to test that mode explicitly.
  project = withRasterLayers(project, [{ id: "FILL", name: "VÝPLNĚ", defaultVisible: true }, { id: "OUTLINE", name: "OBRYSY", defaultVisible: true }]);
  project = withWorkModeHiddenLayers(project, ["FILL"]);
  assert.deepEqual([...effectiveHiddenLayerIds(project)], []);
  project = withRasterViewMode(project, "work");
  assert.deepEqual([...effectiveHiddenLayerIds(project)], ["FILL"]);
});

test("createDefaultRasterSettings defaults viewMode to 'work' (spec section 19: technical workflow default)", () => {
  const project = createTechnicalRasterProject({ name: "X" }, "p1");
  assert.equal(project.rasterSettings.viewMode, "work");
});

test("withRasterStandLabels re-runs matching for non-manual stands", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A21", services: [{ category: "electricity", externalLabel: "Do 2 kW", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  assert.equal(project.stands[0]?.placement.status, "unassigned");

  project = withRasterStandLabels(project, [makeLabel("1A21", "label-1")]);
  assert.equal(project.stands[0]?.placement.status, "matched_auto");
  assert.equal(project.stands[0]?.placement.matchedLabelId, "label-1");
});

test("manual assignment is NEVER overwritten by a later withRasterStandLabels/rematch call", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A21", services: [], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  const standId = project.stands[0]!.id;
  project = assignStandManually(project, standId, { page: 1, anchorXNormalized: 0.5, anchorYNormalized: 0.5 });
  assert.equal(project.stands[0]?.placement.status, "matched_manual");

  // even though the raster now ALSO has an exact-match label for this stand, manual wins.
  project = withRasterStandLabels(project, [makeLabel("1A21", "label-1")]);
  assert.equal(project.stands[0]?.placement.status, "matched_manual");
  assert.equal(project.stands[0]?.placement.matchMethod, "manual");
});

test("clearStandAssignment returns to unassigned (or re-matches if the raster still has an exact match) — never destroys services/notes", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A21", services: [{ category: "electricity", externalLabel: "Do 2 kW", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  const standId = project.stands[0]!.id;
  project = assignStandManually(project, standId, { page: 1, anchorXNormalized: 0.5, anchorYNormalized: 0.5 });
  project = clearStandAssignment(project, standId);
  assert.equal(project.stands[0]?.placement.status, "unassigned");
  assert.equal(project.stands[0]?.services.length, 1, "services must survive an assignment reset");
});

test("nextUnassignedStand: natural-sort order, wraps around, skips matched stands", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [{ standNumber: "1A10", services: [], notes: [] }, { standNumber: "1A02", services: [], notes: [] }, { standNumber: "1A03", services: [], notes: [] }],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  const first = nextUnassignedStand(project);
  assert.equal(first?.standNumber, "1A02");
  const second = nextUnassignedStand(project, first!.id);
  assert.equal(second?.standNumber, "1A03");
  const third = nextUnassignedStand(project, second!.id);
  assert.equal(third?.standNumber, "1A10");
  const wrapped = nextUnassignedStand(project, third!.id);
  assert.equal(wrapped?.standNumber, "1A02");
});

test("mergeTechnicalRasterImport: stands from DIFFERENT categories merge into ONE shared buffer by stand number (spec section 15)", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const electricityReport: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1B04", companyName: "KLIA PRAHA s.r.o.", services: [{ category: "electricity", externalLabel: "Do 2 kW", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  const wasteReport: ParsedTechnicalReport = { category: "waste", rows: [{ standNumber: "1B04", services: [{ category: "waste", externalLabel: "Kontejner 1100 l", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [{ text: "doobjednáno telefonicky", sourcePage: 1 }] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), electricityReport, alwaysResolved);
  project = mergeTechnicalRasterImport(project, makeImport("waste", "imp-2"), wasteReport, alwaysResolved);

  assert.equal(project.stands.length, 1);
  const stand = project.stands[0]!;
  assert.equal(stand.standNumber, "1B04");
  assert.equal(stand.companyName, "KLIA PRAHA s.r.o.");
  assert.equal(stand.services.length, 2);
  assert.deepEqual(stand.services.map((service) => service.category).sort(), ["electricity", "waste"]);
  assert.equal(stand.notes.length, 1);
  assert.equal(stand.sourceImportIds.length, 2);
});

test("mergeTechnicalRasterImport: quantity > 1 and multiple services in the SAME category both survive (never 1 stand = 1 service)", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = {
    category: "internet",
    rows: [{ standNumber: "1A05", services: [
      { category: "internet", externalLabel: "Další WIFI přípojka", quantity: 2, rawValue: "2", sourcePage: 1 },
      { category: "internet", externalLabel: "Pevná IP", quantity: 1, rawValue: "1", sourcePage: 1 },
    ], notes: [] }],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("internet", "imp-1"), report, alwaysResolved);
  assert.equal(project.stands[0]?.services.length, 2);
  assert.equal(project.stands[0]?.services.find((service) => service.externalLabel === "Další WIFI přípojka")?.quantity, 2);
});

test("mergeTechnicalRasterImport with replaceImportId: supersedes the OLD import (kept in history) and removes ITS services/notes, keeping the new ones (spec section 24)", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const firstReport: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A01", services: [{ category: "electricity", externalLabel: "Do 2 kW", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-old"), firstReport, alwaysResolved);
  assert.equal(project.stands[0]?.services.length, 1);

  const secondReport: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A01", services: [{ category: "electricity", externalLabel: "Do 5 kW", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-new"), secondReport, alwaysResolved, "imp-old");

  assert.equal(project.imports.length, 2, "the OLD import row is kept forever for history, never deleted");
  assert.equal(project.imports.find((entry) => entry.id === "imp-old")?.supersededByImportId, "imp-new");
  assert.equal(project.stands.length, 1, "still one stand, never duplicated");
  assert.equal(project.stands[0]?.services.length, 1);
  assert.equal(project.stands[0]?.services[0]?.externalLabel, "Do 5 kW", "the OLD service was removed, only the NEW one remains");
  assert.equal(project.stands[0]?.sourceImportIds.includes("imp-old"), false);
});

test("summarizeTechnicalRasterProject: counts unassigned/ambiguous correctly, never ships full stands[]", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A01", services: [], notes: [] }, { standNumber: "1A02", services: [], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  project = withRasterStandLabels(project, [makeLabel("1A01", "l1"), makeLabel("1A01", "l2")]); // ambiguous
  const summary = summarizeTechnicalRasterProject(project);
  assert.equal(summary.standCount, 2);
  assert.equal(summary.ambiguousCount, 1);
  assert.equal(summary.unassignedCount, 1);
  assert.equal("stands" in summary, false);
});

// =========================================================================================
// Multi-page (spec batch 2.5 section 9) — placement must carry the label's OWN page, never
// assume page 1.
// =========================================================================================
test("multi-page: a stand matched against a page-2 label gets rasterPage=2, never defaults to page 1", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "2A01", services: [], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  const page2Label: RasterStandLabel = { id: "l-p2", rawText: "2A01", normalizedStandNumber: "2A01", page: 2, xNormalized: 0.1, yNormalized: 0.1, widthNormalized: 0.02, heightNormalized: 0.01 };
  project = withRasterStandLabels(project, [makeLabel("1A01", "l-p1"), page2Label]);
  const stand = project.stands.find((s) => s.standNumber === "2A01")!;
  assert.equal(stand.placement.status, "matched_auto");
  assert.equal(stand.placement.rasterPage, 2);
});

test("multi-page: the SAME stand number on two DIFFERENT pages is ambiguous — page alone never disambiguates a duplicate", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A01", services: [], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  const labelPage1: RasterStandLabel = { id: "l1", rawText: "1A01", normalizedStandNumber: "1A01", page: 1, xNormalized: 0.1, yNormalized: 0.1, widthNormalized: 0.02, heightNormalized: 0.01 };
  const labelPage2: RasterStandLabel = { id: "l2", rawText: "1A01", normalizedStandNumber: "1A01", page: 2, xNormalized: 0.1, yNormalized: 0.1, widthNormalized: 0.02, heightNormalized: 0.01 };
  project = withRasterStandLabels(project, [labelPage1, labelPage2]);
  assert.equal(project.stands[0]?.placement.status, "ambiguous");
});

test("ambiguous placement carries candidateCount (spec batch 3 UI section 9: 'Nejednoznačné — nalezeno Nx') — purely informational, never used to auto-pick a candidate", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A01", services: [], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  project = withRasterStandLabels(project, [makeLabel("1A01", "l1"), makeLabel("1A01", "l2"), makeLabel("1A01", "l3")]);
  const stand = project.stands[0]!;
  assert.equal(stand.placement.status, "ambiguous");
  assert.equal(stand.placement.candidateCount, 3, "3 raster labels matched this stand number");
  assert.equal(stand.placement.matchedLabelId, undefined, "still never auto-picks one of the candidates");
});

// =========================================================================================
// Zoom invariance (spec batch 2.5 section 11) — assignStandManually stores EXACTLY the
// normalized coordinates it's given; it must never apply any zoom/scale-dependent transform of
// its own (zoom is a pure view/CSS concern, resolved entirely before this function is called).
// =========================================================================================
test("zoom invariance: assignStandManually stores the given normalized anchor verbatim, at any 'zoom' the caller claims", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A01", services: [], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  const standId = project.stands[0]!.id;
  // the SAME logical click position, expressed identically regardless of whatever CSS zoom level
  // a real viewer happened to be at when the click was normalized upstream.
  const anchor = { page: 1, anchorXNormalized: 0.33333, anchorYNormalized: 0.66667 };
  for (const zoomLabel of ["50%", "100%", "200%", "400%"]) {
    const assigned = assignStandManually(project, standId, anchor);
    assert.equal(assigned.stands[0]?.placement.anchorXNormalized, anchor.anchorXNormalized, `at simulated zoom ${zoomLabel}`);
    assert.equal(assigned.stands[0]?.placement.anchorYNormalized, anchor.anchorYNormalized, `at simulated zoom ${zoomLabel}`);
  }
});

// =========================================================================================
// Exact-match invariants, consolidated at the project level (spec batch 2.5 section 15) — the
// low-level engine itself is unit-tested in tests/technicalRasterMatching.test.ts; this proves
// the SAME three outcomes flow correctly through mergeTechnicalRasterImport + withRasterStandLabels.
// =========================================================================================
test("exact-match invariants: 1 candidate -> matched_auto, 0 -> unassigned, 2 -> ambiguous, manual is never overwritten by rematch", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [
      { standNumber: "1A01", services: [], notes: [] }, // will get exactly 1 label -> matched_auto
      { standNumber: "1B99", services: [], notes: [] }, // will get 0 labels -> unassigned
      { standNumber: "1C01", services: [], notes: [] }, // will get 2 labels -> ambiguous
    ],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  project = withRasterStandLabels(project, [makeLabel("1A01", "l1"), makeLabel("1C01", "l2"), makeLabel("1C01", "l3")]);

  assert.equal(project.stands.find((s) => s.standNumber === "1A01")?.placement.status, "matched_auto");
  assert.equal(project.stands.find((s) => s.standNumber === "1B99")?.placement.status, "unassigned");
  assert.equal(project.stands.find((s) => s.standNumber === "1C01")?.placement.status, "ambiguous");
});

test("exact-match invariants: after a manual unassign (clearStandAssignment), rematch MAY re-match it automatically if the raster still has an unambiguous label — current, intended behavior, not changed here", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A01", services: [], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  project = withRasterStandLabels(project, [makeLabel("1A01", "l1")]);
  const standId = project.stands[0]!.id;
  assert.equal(project.stands[0]?.placement.status, "matched_auto");

  project = assignStandManually(project, standId, { page: 1, anchorXNormalized: 0.9, anchorYNormalized: 0.9 });
  assert.equal(project.stands[0]?.placement.status, "matched_manual");

  project = clearStandAssignment(project, standId);
  assert.equal(project.stands[0]?.placement.status, "matched_auto", "the raster still unambiguously has this stand's label, so clearing manual placement lets exact-match take over again");
  assert.equal(project.stands[0]?.placement.matchMethod, "exact_auto");
});

// =========================================================================================
// Source traceability (spec batch 2.5 section 16) — every TechnicalService must retain enough
// to trace back to its origin PDF (spec section 32), even after merging multiple imports.
// =========================================================================================
test("source traceability: every service keeps sourceImportId/page/rawValue/externalLabel/rawRow, and sourceImportId resolves back to the import's own filename", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [{ standNumber: "1A01", services: [{ category: "electricity", externalLabel: "Do 2kW 230V", quantity: 1, rawValue: "1", sourcePage: 3, rawRow: "1A01 Firma s.r.o. 1" }], notes: [] }],
    warnings: [],
  };
  const importRecord = makeImport("electricity", "imp-trace-1");
  project = mergeTechnicalRasterImport(project, importRecord, report, alwaysResolved);

  const service = project.stands[0]!.services[0]!;
  assert.equal(service.sourceImportId, "imp-trace-1");
  assert.equal(service.sourcePage, 3);
  assert.equal(service.rawValue, "1");
  assert.equal(service.externalLabel, "Do 2kW 230V");
  assert.equal(service.rawRow, "1A01 Firma s.r.o. 1");

  const resolvedImport = project.imports.find((entry) => entry.id === service.sourceImportId);
  assert.equal(resolvedImport?.filename, "electricity.pdf");
});

test("source traceability survives merging TWO different categories — each service still points to its OWN import", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const electricityReport: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1B04", services: [{ category: "electricity", externalLabel: "Do 6kW", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  const wasteReport: ParsedTechnicalReport = { category: "waste", rows: [{ standNumber: "1B04", services: [{ category: "waste", externalLabel: "Kontejner 1100 l", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-e"), electricityReport, alwaysResolved);
  project = mergeTechnicalRasterImport(project, makeImport("waste", "imp-w"), wasteReport, alwaysResolved);

  const stand = project.stands[0]!;
  const electricityService = stand.services.find((s) => s.category === "electricity")!;
  const wasteService = stand.services.find((s) => s.category === "waste")!;
  assert.equal(electricityService.sourceImportId, "imp-e");
  assert.equal(wasteService.sourceImportId, "imp-w");
  assert.equal(project.imports.find((i) => i.id === electricityService.sourceImportId)?.filename, "electricity.pdf");
  assert.equal(project.imports.find((i) => i.id === wasteService.sourceImportId)?.filename, "waste.pdf");
});

test("notes also carry sourceImportId — traceable back to their own import, same as services", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "waste", rows: [{ standNumber: "1B04", services: [], notes: [{ text: "doobjednáno telefonicky", sourcePage: 1 }] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("waste", "imp-notes-1"), report, alwaysResolved);
  assert.equal(project.stands[0]?.notes[0]?.sourceImportId, "imp-notes-1");
});

// =========================================================================================
// Duplicate import WITHOUT an explicit replace (spec batch 2.5 section 17/18) — documents the
// CURRENT, intended division of responsibility: the domain merge function trusts its caller to
// decide replace-vs-append (the real UI, TechnicalServiceImportPanel.tsx + TechnicalRasterEditorPage.tsx,
// always looks up any existing import of the SAME category and passes its id as replaceImportId,
// so a duplicate upload always confirms-and-replaces in practice) — calling merge twice for the
// same category WITHOUT replaceImportId is a caller error the domain layer does not silently
// paper over, so this is verified rather than assumed.
// =========================================================================================
test("duplicate import protection: WITH replaceImportId (the real UI's actual path), re-uploading the same category never duplicates services", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const reportV1: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A01", services: [{ category: "electricity", externalLabel: "Do 2kW", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-v1"), reportV1, alwaysResolved);

  const reportV2: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A01", services: [{ category: "electricity", externalLabel: "Do 2kW", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-v2"), reportV2, alwaysResolved, "imp-v1");

  assert.equal(project.stands.length, 1);
  assert.equal(project.stands[0]?.services.length, 1, "no silent quantity duplication across re-upload of the identical PDF");
});

test("without replaceImportId, merging the SAME category twice is additive (documented current behavior — the UI is responsible for always supplying replaceImportId on a real duplicate)", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A01", services: [{ category: "electricity", externalLabel: "Do 2kW", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-2"), report, alwaysResolved);
  // deliberately NOT asserting this is "correct" business behavior — only that it's the CURRENT,
  // documented shape (2 services), so a future change to this rule is a conscious decision, not
  // an accidental regression this test would silently paper over either way.
  assert.equal(project.stands[0]?.services.length, 2);
  assert.equal(project.imports.length, 2);
});

test("rematchStands is idempotent/safe to call repeatedly", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = { category: "electricity", rows: [{ standNumber: "1A01", services: [], notes: [] }], warnings: [] };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);
  const once = rematchStands(project);
  const twice = rematchStands(once);
  assert.deepEqual(once.stands, twice.stands);
});

// =========================================================================================
// Layer visibility + white mode combinations (spec batch 2.5 section 8) — white mode (the
// stand-fill whitening) and the layer-visibility panel (effectiveHiddenLayerIds) are two
// independent features; neither one may change the other's behavior, and the stand layer itself
// must NEVER be auto-hidden just because viewMode === "work".
// =========================================================================================
test("white OFF / stand layer ON: stand layer is visible, no layer forced hidden", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  project = withRasterViewMode(project, "original");
  project = withRasterLayers(project, [{ id: "STANDS", name: "STÁNKY", defaultVisible: true }, { id: "OTHER", name: "JINÁ VRSTVA", defaultVisible: true }]);
  assert.deepEqual([...effectiveHiddenLayerIds(project)], []);
});

test("white ON / stand layer ON: turning on 'work' viewMode never auto-hides the stand layer itself", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1"); // defaults to viewMode "work"
  project = withRasterLayers(project, [{ id: "STANDS", name: "STÁNKY", defaultVisible: true }, { id: "OTHER", name: "JINÁ VRSTVA", defaultVisible: true }]);
  const hidden = effectiveHiddenLayerIds(project);
  assert.equal(hidden.has("STANDS"), false, "white mode must never auto-hide the stand layer via effectiveHiddenLayerIds — its fill is whitened separately, at the operator level, never by hiding the OCG");
});

test("white ON / a DIFFERENT layer OFF: hiding another layer while white mode is on works exactly like it would with white mode off — the two features don't interact", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1"); // viewMode "work"
  project = withRasterLayers(project, [{ id: "STANDS", name: "STÁNKY", defaultVisible: true }, { id: "OTHER", name: "JINÁ VRSTVA", defaultVisible: true }]);
  project = withLayerVisibility(project, "OTHER", false);
  const hidden = effectiveHiddenLayerIds(project);
  assert.equal(hidden.has("OTHER"), true, "the explicitly-hidden other layer is hidden");
  assert.equal(hidden.has("STANDS"), false, "the stand layer stays visible — white mode handles ITS fill separately");
});

test("white OFF / a DIFFERENT layer OFF: identical hidden-layer result whether white mode is on or off", () => {
  let projectWorkMode = createTechnicalRasterProject({ name: "X" }, "p1"); // "work"
  projectWorkMode = withRasterLayers(projectWorkMode, [{ id: "STANDS", name: "STÁNKY", defaultVisible: true }, { id: "OTHER", name: "JINÁ VRSTVA", defaultVisible: true }]);
  projectWorkMode = withLayerVisibility(projectWorkMode, "OTHER", false);

  let projectOriginal = withRasterViewMode(projectWorkMode, "original");
  assert.deepEqual([...effectiveHiddenLayerIds(projectWorkMode)].sort(), [...effectiveHiddenLayerIds(projectOriginal)].sort(), "layer-visibility hiding of an UNRELATED layer must behave identically regardless of viewMode");
});

void ({} as TechnicalRasterProject);

// =========================================================================================
// withoutTechnicalRasterProject (spec batch 4, UI section 14-22, 29) — pure list projection behind
// the project list page's "delete project" flow. Only the SUCCESS path calls this at all
// (TechnicalRasterProjectListPage.tsx's handleDeleteProject calls it inside the try block, only
// after `await projectRepository.delete(project.id)` resolves without throwing) — the failure
// path's catch block never calls it (the project stays), and cancelling the confirm() dialog
// returns before even calling projectRepository.delete(), let alone this. Those two guarantees are
// structural (an early return / a catch block that never reaches this call), not something this
// pure function itself needs to encode — this test file only pins the function's own behavior.
// =========================================================================================

function makeSummary(id: string, name = id): TechnicalRasterProjectSummary {
  return { id, name, hasRaster: false, standCount: 0, unassignedCount: 0, ambiguousCount: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}

test("withoutTechnicalRasterProject: removes exactly the matching project, leaves every other project untouched", () => {
  const projects = [makeSummary("p1"), makeSummary("p2"), makeSummary("p3")];
  const result = withoutTechnicalRasterProject(projects, "p2");
  assert.deepEqual(result.map((p) => p.id), ["p1", "p3"]);
  assert.deepEqual(projects.map((p) => p.id), ["p1", "p2", "p3"], "never mutates the input array");
});

test("withoutTechnicalRasterProject: an id not present in the list is a no-op (same members, unchanged)", () => {
  const projects = [makeSummary("p1"), makeSummary("p2")];
  const result = withoutTechnicalRasterProject(projects, "does-not-exist");
  assert.deepEqual(result.map((p) => p.id), ["p1", "p2"]);
});

test("withoutTechnicalRasterProject: an empty list stays empty", () => {
  assert.deepEqual(withoutTechnicalRasterProject([], "p1"), []);
});

// =========================================================================================
// "Krytí bílé" project settings (spec batch 6, UI section 17-23, 33 I/J) — persistence and
// backward compatibility. The render-time proxy/color-string logic itself is tested in
// tests/technicalRasterWhiteRender.test.ts; this is purely about where the number lives in the
// project's own settings and what happens when it's missing.
// =========================================================================================

test("createDefaultRasterSettings sets whiteFillOpacity to DEFAULT_WHITE_FILL_OPACITY (0.6) for every NEW project", () => {
  const settings = createDefaultRasterSettings();
  assert.equal(settings.whiteFillOpacity, DEFAULT_WHITE_FILL_OPACITY);
  assert.equal(DEFAULT_WHITE_FILL_OPACITY, 0.6);
});

test("I) effectiveWhiteFillOpacity: a project settings object saved BEFORE this field existed (no whiteFillOpacity key at all) reads as the default, never crashes", () => {
  const legacySettings = { layerVisibility: {}, workModeHiddenLayerIds: [], viewMode: "work" } as RasterSettings;
  assert.doesNotThrow(() => effectiveWhiteFillOpacity(legacySettings));
  assert.equal(effectiveWhiteFillOpacity(legacySettings), 0.6);
});

test("effectiveWhiteFillOpacity: an explicitly-set value is always honored over the default", () => {
  const settings: RasterSettings = { layerVisibility: {}, workModeHiddenLayerIds: [], viewMode: "work", whiteFillOpacity: 0.25 };
  assert.equal(effectiveWhiteFillOpacity(settings), 0.25);
});

test("withWhiteFillOpacity: clamps to [0,1] defensively", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  project = withWhiteFillOpacity(project, 1.4);
  assert.equal(project.rasterSettings.whiteFillOpacity, 1);
  project = withWhiteFillOpacity(project, -0.3);
  assert.equal(project.rasterSettings.whiteFillOpacity, 0);
});

test("withWhiteFillOpacity: never touches any other project field (stands, imports, layers, viewMode)", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  project = withRasterViewMode(project, "work");
  project = withRasterLayers(project, [{ id: "STANDS", name: "STÁNKY", defaultVisible: true }]);
  const before = { ...project };
  const after = withWhiteFillOpacity(project, 0.35);
  assert.equal(after.rasterSettings.viewMode, before.rasterSettings.viewMode);
  assert.deepEqual(after.rasterLayers, before.rasterLayers);
  assert.deepEqual(after.stands, before.stands);
  assert.deepEqual(after.imports, before.imports);
});

test("J) save/load round trip: 0.60 (or any other explicit value) survives a plain JSON serialize/deserialize cycle, exactly as project persistence would do it", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  project = withWhiteFillOpacity(project, 0.6);
  const roundTripped = JSON.parse(JSON.stringify(project)) as TechnicalRasterProject;
  assert.equal(roundTripped.rasterSettings.whiteFillOpacity, 0.6);
  assert.equal(effectiveWhiteFillOpacity(roundTripped.rasterSettings), 0.6);
});

test("original mode ignores whiteFillOpacity at the DATA level too: withRasterViewMode('original') leaves whiteFillOpacity completely untouched (the render-time ignoring is TechnicalRasterCanvas.tsx's job, not a data concern)", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  project = withWhiteFillOpacity(project, 0.25);
  project = withRasterViewMode(project, "original");
  assert.equal(project.rasterSettings.whiteFillOpacity, 0.25, "switching to original mode never resets/clears the stored work-mode opacity — it's preserved for when the user switches back");
});

// =========================================================================================
// Service placement (spec batch 7, section 5/6/9/70). Uses the SAME real electricity/internet/
// cleaning categories the presentation config (tests/technicalRasterServicePresentation.test.ts)
// covers, so "point" vs "informational" vs "none" behavior is exercised against real category
// strings, never a made-up one.
// =========================================================================================

function projectWithService(externalLabel: string, quantity: number, category = "electricity") {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const report: ParsedTechnicalReport = {
    category,
    rows: [{ standNumber: "1A21", services: [{ category, externalLabel, quantity, rawValue: String(quantity), sourcePage: 1 }], notes: [] }],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport(category, "imp-1"), report, alwaysResolved);
  const stand = project.stands[0]!;
  return { project, standId: stand.id, serviceId: stand.services[0]!.id };
}

test("A) point service qty 1 -> max 1 placement", () => {
  const { project, standId, serviceId } = projectWithService("Do 3kW 230V", 1);
  const once = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.2 });
  const service1 = once.stands[0]!.services[0]!;
  assert.equal(effectiveServicePlacements(service1).length, 1);

  const twice = placeTechnicalService(once, standId, serviceId, { page: 1, xNormalized: 0.3, yNormalized: 0.4 });
  const service2 = twice.stands[0]!.services[0]!;
  assert.equal(effectiveServicePlacements(service2).length, 1, "quantity=1 must never accept a second placement");
});

test("B) point service qty 2 -> 0/2, 1/2, 2/2", () => {
  const { project, standId, serviceId } = projectWithService("Do 3kW 230V", 2);
  assert.equal(effectiveServicePlacements(project.stands[0]!.services[0]!).length, 0);

  const one = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  assert.equal(effectiveServicePlacements(one.stands[0]!.services[0]!).length, 1);

  const two = placeTechnicalService(one, standId, serviceId, { page: 1, xNormalized: 0.2, yNormalized: 0.2 });
  assert.equal(effectiveServicePlacements(two.stands[0]!.services[0]!).length, 2);
});

test("C) a third placement on a qty=2 service is refused/no-op", () => {
  const { project, standId, serviceId } = projectWithService("Do 3kW 230V", 2);
  const two = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }].reduce(
    (proj, point) => placeTechnicalService(proj, standId, serviceId, { page: 1, xNormalized: point.x, yNormalized: point.y }),
    project,
  );
  const three = placeTechnicalService(two, standId, serviceId, { page: 1, xNormalized: 0.9, yNormalized: 0.9 });
  assert.equal(effectiveServicePlacements(three.stands[0]!.services[0]!).length, 2, "the third click must not create a placement");
  assert.equal(three, two, "a refused placement returns the SAME project reference — genuinely a no-op, not even a re-timestamped copy");
});

test("D) remove placement -> quantity state updates, service/quantity/notes untouched", () => {
  const { project, standId, serviceId } = projectWithService("Do 3kW 230V", 1);
  const placed = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.5, yNormalized: 0.5 });
  const placementId = effectiveServicePlacements(placed.stands[0]!.services[0]!)[0]!.id;

  const removed = removeTechnicalServicePlacement(placed, standId, serviceId, placementId);
  const service = removed.stands[0]!.services[0]!;
  assert.equal(effectiveServicePlacements(service).length, 0, "back to Neumístěno");
  assert.equal(service.quantity, 1, "quantity itself is never touched");
  assert.equal(service.id, serviceId, "removing a placement never removes/replaces the service itself");
});

test("E) move placement -> SAME placement id, new coordinates", () => {
  const { project, standId, serviceId } = projectWithService("Do 3kW 230V", 1);
  const placed = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  const original = effectiveServicePlacements(placed.stands[0]!.services[0]!)[0]!;

  const moved = moveTechnicalServicePlacement(placed, standId, serviceId, original.id, { page: 1, xNormalized: 0.8, yNormalized: 0.9 });
  const movedPlacement = effectiveServicePlacements(moved.stands[0]!.services[0]!)[0]!;
  assert.equal(movedPlacement.id, original.id, "same placement id — a move is never a delete+recreate");
  assert.equal(movedPlacement.xNormalized, 0.8);
  assert.equal(movedPlacement.yNormalized, 0.9);
});

test("F) informational service (WIFI) -> placeTechnicalService is a structural no-op, never creates a placement", () => {
  const { project, standId, serviceId } = projectWithService("WIFI", 2, "internet");
  const attempted = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.5, yNormalized: 0.5 });
  assert.equal(effectiveServicePlacements(attempted.stands[0]!.services[0]!).length, 0);
  assert.equal(attempted, project, "refused placement on a non-point service returns the SAME project reference — a genuine no-op");
});

test("G) cleaning qty 40 -> placeTechnicalService never creates any of the 40 points", () => {
  const { project, standId, serviceId } = projectWithService("Denní úklid", 40, "cleaning");
  const attempted = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.5, yNormalized: 0.5 });
  assert.equal(effectiveServicePlacements(attempted.stands[0]!.services[0]!).length, 0);
});

test("H) coordinates persist through a plain JSON round trip (save/reload)", () => {
  const { project, standId, serviceId } = projectWithService("Do 3kW 230V", 1);
  const placed = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.3333, yNormalized: 0.6667 });
  const reloaded = JSON.parse(JSON.stringify(placed)) as TechnicalRasterProject;
  const placement = effectiveServicePlacements(reloaded.stands[0]!.services[0]!)[0]!;
  assert.equal(placement.xNormalized, 0.3333);
  assert.equal(placement.yNormalized, 0.6667);
});

test("H2) a quantity>1 service's placement round trip survives with distinct ids/coordinates/page/createdAt for EACH placement (spec batch 12 section 10)", () => {
  const { project, standId, serviceId } = projectWithService("Do 3kW 230V", 2);
  const first = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.2 });
  const both = placeTechnicalService(first, standId, serviceId, { page: 2, xNormalized: 0.8, yNormalized: 0.9 });
  const reloaded = JSON.parse(JSON.stringify(both)) as TechnicalRasterProject;
  const placements = effectiveServicePlacements(reloaded.stands[0]!.services[0]!);
  assert.equal(placements.length, 2);
  assert.notEqual(placements[0]!.id, placements[1]!.id, "each placement keeps its own distinct id");
  assert.equal(placements[0]!.page, 1);
  assert.equal(placements[0]!.xNormalized, 0.1);
  assert.equal(placements[0]!.yNormalized, 0.2);
  assert.equal(placements[1]!.page, 2);
  assert.equal(placements[1]!.xNormalized, 0.8);
  assert.equal(placements[1]!.yNormalized, 0.9);
  assert.ok(placements[0]!.createdAt && placements[1]!.createdAt, "createdAt survives on both");
});

test("I) placement coordinates are stored normalized (0-1), with no notion of zoom at all — the domain layer never touches/derives them from a zoom value", () => {
  const { project, standId, serviceId } = projectWithService("Do 3kW 230V", 1);
  const placed = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.42, yNormalized: 0.17 });
  const placement = effectiveServicePlacements(placed.stands[0]!.services[0]!)[0]!;
  assert.ok(placement.xNormalized >= 0 && placement.xNormalized <= 1);
  assert.ok(placement.yNormalized >= 0 && placement.yNormalized <= 1);
  assert.ok(!("zoom" in placement) && !("screenX" in placement) && !("screenY" in placement), "placement must never carry any screen/zoom-derived field");
});

test("removeTechnicalServicePlacement / moveTechnicalServicePlacement: unknown placementId is a safe no-op", () => {
  const { project, standId, serviceId } = projectWithService("Do 3kW 230V", 1);
  const placed = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  const afterBadRemove = removeTechnicalServicePlacement(placed, standId, serviceId, "does-not-exist");
  assert.equal(afterBadRemove, placed, "a true structural no-op returns the SAME project reference, never even a re-timestamped copy");
  const afterBadMove = moveTechnicalServicePlacement(placed, standId, serviceId, "does-not-exist", { page: 1, xNormalized: 0.9, yNormalized: 0.9 });
  assert.equal(afterBadMove, placed);
});

test("unknown standId/serviceId: every placement mutator is a safe no-op, never throws", () => {
  const { project } = projectWithService("Do 3kW 230V", 1);
  assert.doesNotThrow(() => placeTechnicalService(project, "no-such-stand", "no-such-service", { page: 1, xNormalized: 0.1, yNormalized: 0.1 }));
  const result = placeTechnicalService(project, "no-such-stand", "no-such-service", { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  assert.equal(result, project);
});

// ============================================================================
// Corrective batch section 9/10 — realizace data model.
// ============================================================================

test("effectiveShowRealizations / effectiveIncludeRealizationsInExport default to false for a brand-new project — no realization data yet means no badges by default", () => {
  const project = createTechnicalRasterProject({ name: "X" }, "p1");
  assert.equal(effectiveShowRealizations(project.rasterSettings), false);
  assert.equal(effectiveIncludeRealizationsInExport(project.rasterSettings), false);
});

test("withShowRealizations / withIncludeRealizationsInExport toggle independently, never touch each other", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  project = withShowRealizations(project, true);
  assert.equal(effectiveShowRealizations(project.rasterSettings), true);
  assert.equal(effectiveIncludeRealizationsInExport(project.rasterSettings), false);
  project = withIncludeRealizationsInExport(project, true);
  assert.equal(effectiveShowRealizations(project.rasterSettings), true);
  assert.equal(effectiveIncludeRealizationsInExport(project.rasterSettings), true);
});

test("setStandRealizationCompany: sets the raw text on exactly the matching stand, leaves services/placement/notes untouched", () => {
  const { project, standId } = projectWithService("Do 3kW 230V", 1);
  const updated = setStandRealizationCompany(project, standId, "CREATIV EXPO, s.r.o.");
  const stand = updated.stands.find((candidate) => candidate.id === standId)!;
  assert.equal(stand.realizationCompany, "CREATIV EXPO, s.r.o.");
  assert.equal(stand.services.length, project.stands[0]!.services.length);
  assert.deepEqual(stand.placement, project.stands[0]!.placement);
});

test("setStandRealizationCompany: can clear back to undefined", () => {
  const { project, standId } = projectWithService("Do 3kW 230V", 1);
  const withCompany = setStandRealizationCompany(project, standId, "GENDAI");
  const cleared = setStandRealizationCompany(withCompany, standId, undefined);
  assert.equal(cleared.stands[0]!.realizationCompany, undefined);
});

test("setStandRealizationCompany: unknown standId is a safe no-op", () => {
  const { project } = projectWithService("Do 3kW 230V", 1);
  const result = setStandRealizationCompany(project, "no-such-stand", "GENDAI");
  assert.deepEqual(result.stands, project.stands);
});

// ============================================================================
// Corrective batch (post real-file acceptance test) section 7-11 — supplemental catalog import.
// ============================================================================

test("mergeSupplementalCatalogImport: auto-assigns realizationCompany on a stand whose number matches, never touches services", () => {
  const { project, standId } = projectWithService("Do 3kW 230V", 1);
  // projectWithService's own stand is "1A21".
  const updated = mergeSupplementalCatalogImport(
    project,
    { stands: [{ standNumber: "1A21", realizationCompanyRaw: "GENDAI, s.r.o.", items: [], page: 1 }], warnings: [] },
    "realizacky.pdf",
  );
  const stand = updated.stands.find((candidate) => candidate.id === standId)!;
  assert.equal(stand.realizationCompany, "GENDAI, s.r.o.");
  assert.equal(stand.services.length, project.stands[0]!.services.length, "services must never be touched by a catalog import");
});

test("mergeSupplementalCatalogImport: a catalog stand number matching NO existing project stand creates a NEW catalog-only stand (real 1B06 case), never crashes, never invents a technical service", () => {
  const { project } = projectWithService("Do 3kW 230V", 1);
  const updated = mergeSupplementalCatalogImport(
    project,
    { stands: [{ standNumber: "9Z99", realizationCompanyRaw: "GENDAI", items: [], page: 1 }], warnings: [] },
    "realizacky.pdf",
  );
  assert.equal(updated.stands.length, project.stands.length + 1, "a brand-new stand must be created for a catalog-only build record");
  const newStand = updated.stands.find((stand) => stand.standNumber === "9Z99");
  assert.ok(newStand, "the new stand must carry the catalog's own stand number");
  assert.equal(newStand!.services.length, 0, "must never invent a fake technical service just to make the catalog stand exist");
  assert.equal(newStand!.hasCatalogBuildRecord, true);
  assert.equal(newStand!.realizationCompany, "GENDAI");
  assert.equal(newStand!.placement.status, "unassigned", "no raster label exists for 9Z99 in this test project, so it stays unassigned rather than being force-placed");
  // matchedStandCount means matched to an actual RASTER stand (section 16) — this project has no
  // raster labels at all, so even though a catalog record/stand now exists, it is NOT counted here.
  assert.equal(updated.catalogImportMeta?.standCount, 1);
  assert.equal(updated.catalogImportMeta?.matchedStandCount, 0);
});

test("mergeSupplementalCatalogImport: replaces catalogMentions wholesale on a SECOND import, never accumulates duplicates from the first", () => {
  const { project } = projectWithService("Do 3kW 230V", 1);
  const firstImport = mergeSupplementalCatalogImport(
    project,
    { stands: [{ standNumber: "1A21", items: [{ label: "ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 }], page: 1 }], warnings: [] },
    "realizacky-v1.pdf",
  );
  assert.equal(firstImport.catalogMentions?.length, 1);
  const secondImport = mergeSupplementalCatalogImport(
    project,
    { stands: [{ standNumber: "1A21", items: [{ label: "ELEKTRICKÁ ENERGIE - PŘÍKON DO 5 kW/230", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 }], page: 1 }], warnings: [] },
    "realizacky-v2.pdf",
  );
  assert.equal(secondImport.catalogMentions?.length, 1, "the second import replaces, never appends to, the first");
  assert.equal(secondImport.catalogMentions?.[0]?.externalLabel, "ELEKTRICKÁ ENERGIE - PŘÍKON DO 5 kW/230");
});

test("mergeSupplementalCatalogImport: a catalog stand with realizationCompanyRaw undefined (no R: line this run) does NOT wipe a previously-set value", () => {
  const { project, standId } = projectWithService("Do 3kW 230V", 1);
  const withManualEntry = setStandRealizationCompany(project, standId, "MAC Praha");
  const updated = mergeSupplementalCatalogImport(
    withManualEntry,
    { stands: [{ standNumber: "1A21", realizationCompanyRaw: undefined, items: [], page: 1 }], warnings: [] },
    "realizacky.pdf",
  );
  assert.equal(updated.stands.find((candidate) => candidate.id === standId)!.realizationCompany, "MAC Praha");
});

// ============================================================================
// CORRECTIVE BATCH (multi-hall imports) — a single technical-service report can legitimately mix
// rows from several halls (real scenario: an electricity report with 50 Hala 3 rows and 50 Hala 4
// rows, imported into a Hala 3 project). These pin the exact classification/work-queue/manual-
// override behavior domain/technicalRasterHallScope.ts's own doc describes in full.
// ============================================================================

function electricityRowsReport(standNumbers: readonly string[]): ParsedTechnicalReport {
  return {
    category: "electricity",
    rows: standNumbers.map((standNumber) => ({
      standNumber,
      services: [{ category: "electricity", externalLabel: "Do 2 kW", quantity: 1, rawValue: "1", sourcePage: 1 }],
      notes: [],
    })),
    warnings: [],
  };
}

test("BASIC MULTI-HALL CASE: raster 3A01/3A02/3B01, imported 3A01/4A01/4B02 -> 3A01 matched, 4A01/4B02 outside_current_raster, never fake stands, never entered as errors", () => {
  let project = createTechnicalRasterProject({ name: "Hala 3" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("3A01", "l1"), makeLabel("3A02", "l2"), makeLabel("3B01", "l3")]);
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), electricityRowsReport(["3A01", "4A01", "4B02"]), alwaysResolved);

  const byNumber = new Map(project.stands.map((stand) => [stand.standNumber, stand]));
  assert.equal(byNumber.get("3A01")?.placement.status, "matched_auto");
  assert.equal(byNumber.get("4A01")?.placement.status, "outside_current_raster");
  assert.equal(byNumber.get("4B02")?.placement.status, "outside_current_raster");
  // The records themselves are fully preserved — raw stand number, service, quantity — never discarded.
  assert.equal(byNumber.get("4A01")?.services[0]?.externalLabel, "Do 2 kW");
  assert.equal(byNumber.get("4A01")?.services[0]?.quantity, 1);
});

test("CURRENT-HALL TYPO: raster 3A01/3A02, imported 3A99 -> stays 'unassigned' (a real problem), never reclassified as outside_current_raster", () => {
  let project = createTechnicalRasterProject({ name: "Hala 3" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("3A01", "l1"), makeLabel("3A02", "l2")]);
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), electricityRowsReport(["3A99"]), alwaysResolved);
  assert.equal(project.stands[0]?.placement.status, "unassigned");
});

test("AMBIGUOUS RASTER: preserved exactly as before — a stand number matching MULTIPLE raster labels stays 'ambiguous', never reclassified as outside_current_raster", () => {
  let project = createTechnicalRasterProject({ name: "Hala 3" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("3A01", "l1"), makeLabel("3A01", "l2")]);
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), electricityRowsReport(["3A01"]), alwaysResolved);
  assert.equal(project.stands[0]?.placement.status, "ambiguous");
});

test("NO RELIABLE HALL PREFIX: raster A01/A02 (no leading digit), imported B99 -> stays 'unassigned' via ordinary behavior, never assumed foreign", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("A01", "l1"), makeLabel("A02", "l2")]);
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), electricityRowsReport(["B99"]), alwaysResolved);
  assert.equal(project.stands[0]?.placement.status, "unassigned");
});

test("CROSS-CATEGORY CONSISTENCY: the scope classification applies identically to EVERY primary technical-report category (internet/water/waste/cleaning), never electricity-only — all funnel through the SAME mergeTechnicalRasterImport + rematchStands pipeline", () => {
  for (const category of ["internet", "water", "waste", "cleaning"]) {
    let project = createTechnicalRasterProject({ name: "Hala 3" }, "p1");
    project = withRasterStandLabels(project, [makeLabel("3A01", "l1")]);
    const report: ParsedTechnicalReport = {
      category,
      rows: [{ standNumber: "4A01", services: [{ category, externalLabel: "X", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }],
      warnings: [],
    };
    project = mergeTechnicalRasterImport(project, makeImport(category, `imp-${category}`), report, alwaysResolved);
    assert.equal(project.stands[0]?.placement.status, "outside_current_raster", `category "${category}" must classify a foreign-hall stand the same way electricity does`);
  }
});

test("WORK QUEUE: outside_current_raster stands never enter K umístění/Hotovo/Bez bodových služeb, and never affect completion totals — mirrors TechnicalStandBuffer.tsx's own matched_auto/matched_manual filter", () => {
  let project = createTechnicalRasterProject({ name: "Hala 3" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("3A01", "l1")]);
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), electricityRowsReport(["3A01", "4A01"]), alwaysResolved);

  const assigned = project.stands.filter((stand) => stand.placement.status === "matched_auto" || stand.placement.status === "matched_manual");
  assert.equal(assigned.length, 1, "only the real Hala 3 stand is ever considered 'assigned'");
  const queue = groupStandsByPlacementWorkQueue(assigned);
  assert.equal(queue.toPlace.length + queue.done.length + queue.noPointServices.length, 1, "the foreign-hall stand never appears in ANY work-queue bucket");
  const summary = computeTechnicalRasterPlacementSummary(assigned);
  assert.equal(summary.standCountWithPointServices, 1, "completion totals are computed ONLY from current-raster assigned stands");
});

test("MANUAL OVERRIDE: an automatically outside_current_raster stand can still be explicitly manually paired — the manual action takes precedence over the automatic classification", () => {
  let project = createTechnicalRasterProject({ name: "Hala 3" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("3A01", "l1")]);
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), electricityRowsReport(["4A01"]), alwaysResolved);
  const foreignStand = project.stands.find((stand) => stand.standNumber === "4A01")!;
  assert.equal(foreignStand.placement.status, "outside_current_raster");

  project = assignStandManually(project, foreignStand.id, { page: 1, anchorXNormalized: 0.5, anchorYNormalized: 0.5 });
  const manuallyPaired = project.stands.find((stand) => stand.id === foreignStand.id)!;
  assert.equal(manuallyPaired.placement.status, "matched_manual");

  // A later rematch (e.g. the raster reloading) must NEVER undo the explicit manual pairing.
  project = withRasterStandLabels(project, [makeLabel("3A01", "l1"), makeLabel("3A02", "l2")]);
  assert.equal(project.stands.find((stand) => stand.id === foreignStand.id)!.placement.status, "matched_manual");
});

test("SUPPLEMENTAL STAVBY CATALOG: raster 3A01/3B01, catalog 3B01=MAC PRAHA + 4A01=CREATIV EXPO -> 3B01 gets the current-raster catalog build, 4A01 is skipped entirely (no lightweight stand, no realization)", () => {
  let project = createTechnicalRasterProject({ name: "Hala 3" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("3A01", "l1"), makeLabel("3B01", "l2")]);
  const updated = mergeSupplementalCatalogImport(
    project,
    {
      stands: [
        { standNumber: "3B01", realizationCompanyRaw: "MAC Praha, spol. s r.o.", items: [], page: 1 },
        { standNumber: "4A01", realizationCompanyRaw: "CREATIV EXPO, s.r.o.", items: [], page: 1 },
      ],
      warnings: [],
    },
    "realizacky.pdf",
  );

  const stand3B01 = updated.stands.find((stand) => stand.standNumber === "3B01");
  assert.ok(stand3B01);
  assert.equal(stand3B01!.hasCatalogBuildRecord, true);
  assert.equal(stand3B01!.realizationCompany, "MAC Praha, spol. s r.o.");
  const display3B01 = resolveRealizationDisplayState(stand3B01!.hasCatalogBuildRecord, stand3B01!.realizationCompany);
  assert.equal(display3B01.shouldShow && display3B01.group, "macPraha");

  const stand4A01 = updated.stands.find((stand) => stand.standNumber === "4A01");
  assert.equal(stand4A01, undefined, "a confidently foreign-hall catalog record must NEVER create a current-project lightweight TechnicalStand");
  assert.equal(updated.catalogImportMeta?.outsideCurrentRasterCount, 1);
  assert.equal(updated.catalogImportMeta?.matchedStandCount, 1, "only the real current-raster catalog build (3B01) is ever counted as matched");
});

test("SUPPLEMENTAL STAVBY CATALOG: a foreign-hall catalog record is skipped even when an EXISTING project stand of that number already exists (e.g. itself already correctly classified outside_current_raster by a primary report)", () => {
  let project = createTechnicalRasterProject({ name: "Hala 3" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("3A01", "l1")]);
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), electricityRowsReport(["4A01"]), alwaysResolved);
  const before = project.stands.find((stand) => stand.standNumber === "4A01")!;
  assert.equal(before.hasCatalogBuildRecord, undefined);

  const updated = mergeSupplementalCatalogImport(
    project,
    { stands: [{ standNumber: "4A01", realizationCompanyRaw: "CREATIV EXPO, s.r.o.", items: [], page: 1 }], warnings: [] },
    "realizacky.pdf",
  );
  const after = updated.stands.find((stand) => stand.standNumber === "4A01")!;
  assert.equal(after.hasCatalogBuildRecord, undefined, "an existing foreign-hall stand must never retroactively gain a catalog build record");
  assert.equal(after.realizationCompany, undefined);
  assert.equal(updated.catalogImportMeta?.outsideCurrentRasterCount, 1);
});

test("CATALOG-ONLY CURRENT-RASTER STAND (regression): a stand present in the CURRENT raster, absent from every primary technical report, present only in the Stavby catalog -> still gets a lightweight current-raster stand with hasCatalogBuildRecord + realization, no fake service", () => {
  let project = createTechnicalRasterProject({ name: "Hala 3" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("3B01", "label-3b01")]);
  const updated = mergeSupplementalCatalogImport(
    project,
    { stands: [{ standNumber: "3B01", realizationCompanyRaw: "MAC Praha, spol. s r.o.", items: [], page: 1 }], warnings: [] },
    "realizacky.pdf",
  );
  const stand = updated.stands.find((candidate) => candidate.standNumber === "3B01")!;
  assert.equal(stand.services.length, 0);
  assert.equal(stand.hasCatalogBuildRecord, true);
  assert.equal(stand.placement.status, "matched_auto");
  assert.equal(updated.catalogImportMeta?.matchedStandCount, 1);
});

// ============================================================================
// Corrective batch (3rd) section 1/2/20 — realization domain model, 6 required cases.
// ============================================================================

test("Realization domain Case 1 (real 1B06): raster stand with NO technical service, catalog build record with MAC PRAHA -> gets catalog/build association + MAC PRAHA + eligible for the blue underline, without ever inventing a fake technical service", () => {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("1B06", "label-1b06")]);
  const updated = mergeSupplementalCatalogImport(
    project,
    { stands: [{ standNumber: "1B06", realizationCompanyRaw: "MAC Praha, spol. s r.o.", items: [], page: 1 }], warnings: [] },
    "realizacky.pdf",
  );
  const stand = updated.stands.find((candidate) => candidate.standNumber === "1B06")!;
  assert.equal(stand.services.length, 0, "no fake technical service may ever be invented just to make a catalog stand exist");
  assert.equal(stand.hasCatalogBuildRecord, true);
  assert.equal(stand.placement.status, "matched_auto", "must match the RASTER-detected label directly, independent of any technical-service report");
  const display = resolveRealizationDisplayState(stand.hasCatalogBuildRecord, stand.realizationCompany);
  assert.equal(display.shouldShow, true);
  assert.equal(display.shouldShow && display.group, "macPraha");
  assert.equal(updated.catalogImportMeta?.matchedStandCount, 1, "matched means matched to the raster");
});

test("Realization domain Case 2: stand HAS an electricity service but does NOT exist in the build catalog -> keeps its technical service, gets NO realization indicator", () => {
  const { project, standId } = projectWithService("Do 2kW 230V", 1);
  const stand = project.stands.find((candidate) => candidate.id === standId)!;
  const display = resolveRealizationDisplayState(stand.hasCatalogBuildRecord, stand.realizationCompany);
  assert.equal(display.shouldShow, false);
  assert.equal(stand.services.length, 1, "the technical service itself must remain untouched");
});

test("Realization domain Case 3: catalog build record present + known R -> known group/color", () => {
  const display = resolveRealizationDisplayState(true, "CREATIV EXPO, s.r.o.");
  assert.equal(display.shouldShow, true);
  assert.equal(display.shouldShow && display.group, "creativExpo");
});

test("Realization domain Case 4: catalog build record present + unknown R -> OSTATNÍ (a CONFIRMED build with an unrecognized contractor)", () => {
  const display = resolveRealizationDisplayState(true, "Elseya spol. s r.o.");
  assert.equal(display.shouldShow, true);
  assert.equal(display.shouldShow && display.group, "ostatni");
});

test("Realization domain Case 5: catalog build record present + blank R -> OSTATNÍ, never interpreted as 'no data'", () => {
  const display = resolveRealizationDisplayState(true, undefined);
  assert.equal(display.shouldShow, true);
  assert.equal(display.shouldShow && display.group, "ostatni");
});

test("Realization domain Case 6: no catalog build record at all -> no realization marker, regardless of any stray realizationCompany text", () => {
  const display = resolveRealizationDisplayState(undefined, "MAC Praha");
  assert.equal(display.shouldShow, false);
});

test("buildPrimaryReportMentions: only MATCHED stands contribute, in the exact shape reconcileTechnicalReportAndCatalog expects", () => {
  const { project, standId } = projectWithService("Do 3kW 230V", 1);
  const unmatched = buildPrimaryReportMentions(project);
  assert.equal(unmatched.length, 0, "an unassigned stand contributes nothing yet");

  const matched = assignStandManually(project, standId, { page: 1, anchorXNormalized: 0.5, anchorYNormalized: 0.5 });
  const mentions = buildPrimaryReportMentions(matched);
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0]!.standNumber, "1A21");
  assert.equal(mentions[0]!.category, "electricity");
  assert.equal(mentions[0]!.externalLabel, "Do 3kW 230V");
  assert.equal(mentions[0]!.quantity, 1);
});
