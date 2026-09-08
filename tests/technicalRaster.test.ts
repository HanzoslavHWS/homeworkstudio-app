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
  DEFAULT_WHITE_FILL_OPACITY,
  type ParsedTechnicalReport,
  type RasterSettings,
  type RasterStandLabel,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
  type TechnicalRasterProjectSummary,
} from "../domain/technicalRaster.ts";
import type { StoredAsset } from "../domain/assets.ts";

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
