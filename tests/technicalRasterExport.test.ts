import assert from "node:assert/strict";
import test from "node:test";
import {
  assignStandManually,
  createTechnicalRasterProject,
  mergeTechnicalRasterImport,
  placeTechnicalService,
  withRasterStandLabels,
  type ParsedTechnicalReport,
  type RasterStandLabel,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
} from "../domain/technicalRaster.ts";
import {
  buildTechnicalRasterExportFileName,
  buildTechnicalRasterExportHeaderLine,
  buildTechnicalRasterExportLegend,
  buildTechnicalRasterExportPlacements,
  computeTechnicalRasterExportWarnings,
  computeTechnicalRasterStatusSummary,
} from "../domain/technicalRasterExport.ts";
import type { StoredAsset } from "../domain/assets.ts";

function makeAsset(id: string): StoredAsset {
  return { id, storageKey: `technical-rasters/p1/source/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-source" };
}

function makeImport(category: string, id: string): TechnicalRasterImport {
  return { id, category, filename: `${category}.pdf`, asset: makeAsset(`import-${id}`), importedAt: "2026-01-01T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: 1, servicesFound: 1, warnings: [] };
}

const alwaysResolved = () => ({ status: "unresolved_product" as const });

/** One matched stand ("1A21") with one electricity service ("Do 3kW 230V", qty given), optionally an unmatched stand ("1B04") with one internet service. */
function buildProject(options: Readonly<{ electricityQuantity: number; addUnmatchedStandWithService?: boolean }>): TechnicalRasterProject {
  let project = createTechnicalRasterProject({ name: "X" }, "p1");
  const electricityReport: ParsedTechnicalReport = {
    category: "electricity",
    rows: [{ standNumber: "1A21", services: [{ category: "electricity", externalLabel: "Do 3kW 230V", quantity: options.electricityQuantity, rawValue: "1", sourcePage: 1 }], notes: [] }],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), electricityReport, alwaysResolved);
  const standId = project.stands[0]!.id;
  project = assignStandManually(project, standId, { page: 1, anchorXNormalized: 0.2, anchorYNormalized: 0.3 });

  if (options.addUnmatchedStandWithService) {
    const internetReport: ParsedTechnicalReport = {
      category: "internet",
      rows: [{ standNumber: "1B04", services: [{ category: "internet", externalLabel: "Pevná IP", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] }],
      warnings: [],
    };
    project = mergeTechnicalRasterImport(project, makeImport("internet", "imp-2"), internetReport, alwaysResolved);
  }
  return project;
}

test("buildTechnicalRasterExportPlacements: only includes placements on the requested page, for matched stands, for point services", () => {
  let project = buildProject({ electricityQuantity: 1 });
  const standId = project.stands[0]!.id;
  const serviceId = project.stands[0]!.services[0]!.id;
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.4, yNormalized: 0.5 });

  const onPage1 = buildTechnicalRasterExportPlacements(project, 1, new Set());
  assert.equal(onPage1.length, 1);
  assert.equal(onPage1[0]!.standNumber, "1A21");
  assert.equal(onPage1[0]!.presentation.displayLabel, "3 kW");

  const onPage2 = buildTechnicalRasterExportPlacements(project, 2, new Set());
  assert.equal(onPage2.length, 0, "a placement stored on page 1 must never leak into a different page's export");
});

test("buildTechnicalRasterExportPlacements: a hidden category is excluded (spec section 37: export respects technical layer visibility)", () => {
  let project = buildProject({ electricityQuantity: 1 });
  const standId = project.stands[0]!.id;
  const serviceId = project.stands[0]!.services[0]!.id;
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.4, yNormalized: 0.5 });

  const included = buildTechnicalRasterExportPlacements(project, 1, new Set());
  assert.equal(included.length, 1);
  const excluded = buildTechnicalRasterExportPlacements(project, 1, new Set(["electricity"]));
  assert.equal(excluded.length, 0);
});

test("buildTechnicalRasterExportPlacements: an UNMATCHED stand's own services never appear, even with a placement", () => {
  const project = buildProject({ electricityQuantity: 1, addUnmatchedStandWithService: true });
  const placements = buildTechnicalRasterExportPlacements(project, 1, new Set());
  assert.ok(placements.every((item) => item.standNumber !== "1B04"));
});

function makeLabel(standNumber: string, id: string): RasterStandLabel {
  return { id, rawText: standNumber, normalizedStandNumber: standNumber, page: 1, xNormalized: 0.2, yNormalized: 0.3, widthNormalized: 0.03, heightNormalized: 0.015 };
}

// ============================================================================
// CORRECTIVE BATCH (multi-hall imports) section 8 — EXPORT: current raster = Hala 3 (3A01 only).
// Imported electricity services: 3A01 = 5 kW, 4A01 = 2 kW (a genuinely foreign hall, per
// domain/technicalRasterHallScope.ts). Foreign-hall services must never render, never count toward
// placement-completion totals, and never appear as an export warning.
// ============================================================================

test("EXPORT: current raster contains 3A01 only; imported 3A01=5kW + 4A01=2kW -> only 3A01's placement is ever included in the export", () => {
  let project = createTechnicalRasterProject({ name: "Hala 3" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("3A01", "l1")]);
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [
      { standNumber: "3A01", services: [{ category: "electricity", externalLabel: "Do 5kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
      { standNumber: "4A01", services: [{ category: "electricity", externalLabel: "Do 2kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
    ],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);

  const foreignStand = project.stands.find((stand) => stand.standNumber === "4A01")!;
  assert.equal(foreignStand.placement.status, "outside_current_raster");
  const currentStand = project.stands.find((stand) => stand.standNumber === "3A01")!;
  project = placeTechnicalService(project, currentStand.id, currentStand.services[0]!.id, { page: 1, xNormalized: 0.5, yNormalized: 0.5 });
  // A foreign-hall stand has no matched placement anchor at all, but even IF it somehow carried a
  // placement (e.g. stale/corrupted data), buildTechnicalRasterExportPlacements only ever includes
  // matched_auto/matched_manual stands — this is asserted structurally below.

  const placements = buildTechnicalRasterExportPlacements(project, 1, new Set());
  assert.equal(placements.length, 1);
  assert.equal(placements[0]!.standNumber, "3A01");
  assert.equal(placements[0]!.presentation.displayLabel, "5 kW");
  assert.ok(placements.every((item) => item.standNumber !== "4A01"), "the foreign-hall service must never render a marker for the current raster's export");
});

test("computeTechnicalRasterStatusSummary: a foreign-hall stand never inflates totalStandCount/totalPointCount — 'Spárování: 1/1', never '1/2'", () => {
  let project = createTechnicalRasterProject({ name: "Hala 3" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("3A01", "l1")]);
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [
      { standNumber: "3A01", services: [{ category: "electricity", externalLabel: "Do 5kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
      { standNumber: "4A01", services: [{ category: "electricity", externalLabel: "Do 2kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
    ],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);

  const summary = computeTechnicalRasterStatusSummary(project);
  assert.equal(summary.totalStandCount, 1, "the foreign-hall stand is entirely excluded from this raster's own stand count");
  assert.equal(summary.matchedStandCount, 1);
  assert.equal(summary.totalPointCount, 1, "the foreign-hall stand's own unplaced 2kW point never counts toward THIS raster's totals");
});

test("computeTechnicalRasterExportWarnings: a foreign-hall stand with services never appears in unmatchedStandsWithServices, and never inflates unplacedPointCount — never a wall of red errors for a combined multi-hall import", () => {
  let project = createTechnicalRasterProject({ name: "Hala 3" }, "p1");
  project = withRasterStandLabels(project, [makeLabel("3A01", "l1")]);
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: Array.from({ length: 3 }, (_, i) => ({
      standNumber: `4A0${i}`,
      services: [{ category: "electricity", externalLabel: "Do 2kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }],
      notes: [],
    })),
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("electricity", "imp-1"), report, alwaysResolved);

  const warnings = computeTechnicalRasterExportWarnings(project);
  assert.deepEqual(warnings, { unplacedServiceCount: 0, unplacedPointCount: 0, unmatchedStandsWithServices: [] });
});

test("buildTechnicalRasterExportLegend: only entries from placements actually passed in, deduplicated by legendLabel", () => {
  let project = buildProject({ electricityQuantity: 2 });
  const standId = project.stands[0]!.id;
  const serviceId = project.stands[0]!.services[0]!.id;
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.2, yNormalized: 0.2 });

  const placements = buildTechnicalRasterExportPlacements(project, 1, new Set());
  assert.equal(placements.length, 2);
  const legend = buildTechnicalRasterExportLegend(placements);
  assert.equal(legend.length, 1, "two placements of the SAME presentation collapse into one legend entry");
  assert.equal(legend[0]!.legendLabel, "PŘÍVOD EL. ENERGIE");
});

test("buildTechnicalRasterExportLegend: an empty placement list (nothing placed, or everything filtered out) produces an empty legend, never a crash", () => {
  assert.deepEqual(buildTechnicalRasterExportLegend([]), []);
});

test("computeTechnicalRasterStatusSummary: 'Technické body' counts only point services, informational/none never inflate the denominator", () => {
  let project = buildProject({ electricityQuantity: 2 });
  // add a cleaning service (qty 40, "none") and a WIFI service (informational) to the SAME stand — neither should ever show up in totalPointCount.
  const cleaningReport: ParsedTechnicalReport = {
    category: "cleaning",
    rows: [{ standNumber: "1A21", services: [{ category: "cleaning", externalLabel: "Denní úklid", quantity: 40, rawValue: "40", sourcePage: 1 }], notes: [] }],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("cleaning", "imp-3"), cleaningReport, alwaysResolved);
  const wifiReport: ParsedTechnicalReport = {
    category: "internet",
    rows: [{ standNumber: "1A21", services: [{ category: "internet", externalLabel: "WIFI", quantity: 3, rawValue: "3", sourcePage: 1 }], notes: [] }],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("internet", "imp-4"), wifiReport, alwaysResolved);

  const summary = computeTechnicalRasterStatusSummary(project);
  assert.equal(summary.totalPointCount, 2, "only the electricity service's own qty=2 counts — cleaning(40) and WIFI(3) never inflate this");
  assert.equal(summary.placedPointCount, 0);
  assert.equal(summary.matchedStandCount, 1);
  assert.equal(summary.totalStandCount, 1);
});

test("computeTechnicalRasterStatusSummary: placedPointCount tracks real placements, capped at quantity", () => {
  let project = buildProject({ electricityQuantity: 2 });
  const standId = project.stands[0]!.id;
  const serviceId = project.stands[0]!.services[0]!.id;
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  assert.equal(computeTechnicalRasterStatusSummary(project).placedPointCount, 1);
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.2, yNormalized: 0.2 });
  assert.equal(computeTechnicalRasterStatusSummary(project).placedPointCount, 2);
});

test("computeTechnicalRasterExportWarnings: unplaced point services/points counted correctly, cleaning(40) never appears as '40 missing points'", () => {
  let project = buildProject({ electricityQuantity: 2 });
  const cleaningReport: ParsedTechnicalReport = {
    category: "cleaning",
    rows: [{ standNumber: "1A21", services: [{ category: "cleaning", externalLabel: "Denní úklid", quantity: 40, rawValue: "40", sourcePage: 1 }], notes: [] }],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport("cleaning", "imp-3"), cleaningReport, alwaysResolved);

  const warnings = computeTechnicalRasterExportWarnings(project);
  assert.equal(warnings.unplacedServiceCount, 1, "exactly the one electricity service, never the cleaning row");
  assert.equal(warnings.unplacedPointCount, 2, "2 missing electricity points, never 42");
});

test("computeTechnicalRasterExportWarnings: a service that's already fully placed contributes zero", () => {
  let project = buildProject({ electricityQuantity: 1 });
  const standId = project.stands[0]!.id;
  const serviceId = project.stands[0]!.services[0]!.id;
  project = placeTechnicalService(project, standId, serviceId, { page: 1, xNormalized: 0.1, yNormalized: 0.1 });
  const warnings = computeTechnicalRasterExportWarnings(project);
  assert.equal(warnings.unplacedServiceCount, 0);
  assert.equal(warnings.unplacedPointCount, 0);
});

test("computeTechnicalRasterExportWarnings: unmatched stand WITH technical services is flagged separately from unplaced points", () => {
  const project = buildProject({ electricityQuantity: 1, addUnmatchedStandWithService: true });
  const warnings = computeTechnicalRasterExportWarnings(project);
  assert.equal(warnings.unmatchedStandsWithServices.length, 1);
  assert.equal(warnings.unmatchedStandsWithServices[0]!.standNumber, "1B04");
});

test("computeTechnicalRasterExportWarnings: a project with no services at all produces zero warnings, never a crash", () => {
  const project = createTechnicalRasterProject({ name: "Empty" }, "p1");
  const warnings = computeTechnicalRasterExportWarnings(project);
  assert.deepEqual(warnings, { unplacedServiceCount: 0, unplacedPointCount: 0, unmatchedStandsWithServices: [] });
});

test("buildTechnicalRasterExportFileName: sanitized, diacritics-safe, real project data only", () => {
  assert.equal(buildTechnicalRasterExportFileName({ eventName: "FOR DECOR 2026", hall: "Hala 1" }), "Technicky_rastr_FOR_DECOR_2026_Hala_1.pdf");
  assert.equal(buildTechnicalRasterExportFileName({ eventName: "Léto/Podzim: Veletrh?" }), "Technicky_rastr_LetoPodzim_Veletrh.pdf");
});

test("buildTechnicalRasterExportFileName: falls back to the project name when neither eventName nor hall is known — never invents a value", () => {
  assert.equal(buildTechnicalRasterExportFileName({ projectName: "Testovací projekt" }), "Technicky_rastr_Testovaci_projekt.pdf");
  assert.equal(buildTechnicalRasterExportFileName({}), "Technicky_rastr.pdf");
});

test("buildTechnicalRasterExportHeaderLine: only real, known parts, never a placeholder for a missing one", () => {
  assert.equal(buildTechnicalRasterExportHeaderLine({ eventName: "FOR DECOR 2026", hall: "Hala 1" }), "Technický rastr / FOR DECOR 2026 / Hala 1");
  assert.equal(buildTechnicalRasterExportHeaderLine({}), "Technický rastr");
  assert.equal(buildTechnicalRasterExportHeaderLine({ hall: "Hala 1" }), "Technický rastr / Hala 1");
});
