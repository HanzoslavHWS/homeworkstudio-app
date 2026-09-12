import assert from "node:assert/strict";
import test from "node:test";
import {
  groupImportedStandsByImport,
  groupParsedReportByStand,
  matchesTechnicalImportPreviewSearch,
  summarizeParsedReport,
  summarizeParsedReportScope,
} from "../domain/technicalRasterImportPreview.ts";
import type { ParsedTechnicalReport, RasterStandLabel, TechnicalStand } from "../domain/technicalRaster.ts";

// =========================================================================================
// Technické rastry — pure view-model helpers behind "Zobrazit nalezená data" (pre-import preview)
// and the import-history accordion detail (spec batch 3, UI section 10-15). Both call sites feed a
// different source into the SAME grouped-by-stand shape TechnicalImportParsedDataList.tsx renders.
// =========================================================================================

const alwaysResolved = () => "resolved" as const;
const alwaysUnknown = () => "unresolved_product" as const;

test("groupParsedReportByStand: groups multiple services under the same stand, natural-sorted by stand number", () => {
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [
      { standNumber: "1B04", companyName: "KLIA PRAHA s.r.o.", services: [
        { category: "electricity", externalLabel: "Do 6 kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 },
        { category: "electricity", externalLabel: "Lednicový okruh", quantity: 1, rawValue: "1", sourcePage: 1 },
      ], notes: [] },
      { standNumber: "1A03", companyName: "BDK-GLASS, spol. s r.o.", services: [
        { category: "electricity", externalLabel: "Do 2 kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 },
      ], notes: [] },
    ],
    warnings: [],
  };
  const groups = groupParsedReportByStand(report, alwaysResolved);
  assert.deepEqual(groups.map((g) => g.standNumber), ["1A03", "1B04"], "natural-sorted, never insertion order");
  const stand1B04 = groups.find((g) => g.standNumber === "1B04")!;
  assert.equal(stand1B04.companyName, "KLIA PRAHA s.r.o.");
  assert.equal(stand1B04.services.length, 2);
  assert.deepEqual(stand1B04.services.map((s) => s.externalLabel), ["Do 6 kW 230V", "Lednicový okruh"]);
});

test("groupParsedReportByStand: notes land under their own stand", () => {
  const report: ParsedTechnicalReport = {
    category: "waste",
    rows: [{ standNumber: "1B04", services: [], notes: [{ text: "doobjednáno telefonicky", sourcePage: 1 }] }],
    warnings: [],
  };
  const groups = groupParsedReportByStand(report, alwaysResolved);
  assert.deepEqual(groups[0]?.notes, ["doobjednáno telefonicky"]);
});

test("groupParsedReportByStand: marks a service unknown-product exactly when resolveProductStatus says so, per (category, externalLabel)", () => {
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [{ standNumber: "1A01", services: [
      { category: "electricity", externalLabel: "Known", quantity: 1, rawValue: "1", sourcePage: 1 },
      { category: "electricity", externalLabel: "Unknown", quantity: 1, rawValue: "1", sourcePage: 1 },
    ], notes: [] }],
    warnings: [],
  };
  const resolve = (_category: string, label: string) => (label === "Unknown" ? "unresolved_product" as const : "resolved" as const);
  const groups = groupParsedReportByStand(report, resolve);
  const services = groups[0]!.services;
  assert.equal(services.find((s) => s.externalLabel === "Known")?.isUnknownProduct, false);
  assert.equal(services.find((s) => s.externalLabel === "Unknown")?.isUnknownProduct, true);
});

test("summarizeParsedReport: standCount/serviceCount/warningCount match the exact pre-existing preview computation (Set of raw row.standNumber, sum of services.length)", () => {
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [
      { standNumber: "1A01", services: [{ category: "electricity", externalLabel: "A", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
      { standNumber: "1A01", services: [{ category: "electricity", externalLabel: "B", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
      { standNumber: "1A02", services: [{ category: "electricity", externalLabel: "C", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] },
    ],
    warnings: [{ message: "problem" }],
  };
  const summary = summarizeParsedReport(report, alwaysResolved);
  assert.equal(summary.standCount, 2, "1A01 appears twice in rows but counts once, matching Set-based row.standNumber counting");
  assert.equal(summary.serviceCount, 3);
  assert.equal(summary.warningCount, 1);
  assert.equal(summary.unknownProductCount, 0);
});

test("summarizeParsedReport: unknownProductCount counts every service resolveProductStatus flags, never derived from anything else", () => {
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [{ standNumber: "1A01", services: [
      { category: "electricity", externalLabel: "A", quantity: 1, rawValue: "1", sourcePage: 1 },
      { category: "electricity", externalLabel: "B", quantity: 1, rawValue: "1", sourcePage: 1 },
    ], notes: [] }],
    warnings: [],
  };
  const summary = summarizeParsedReport(report, alwaysUnknown);
  assert.equal(summary.unknownProductCount, 2);
});

// ============================================================================
// CORRECTIVE BATCH (multi-hall imports) section 9 — pre-commit scope preview: a combined report
// mixing rows from several halls must read as "Importováno: N / Spárováno s rastrem: X / Mimo
// aktuální rastr: Y / Nespárováno: Z / Nejednoznačné: W" BEFORE the user ever confirms the import.
// Reuses the exact same matchStandNumberToRasterLabels + classifyStandScope logic
// mergeTechnicalRasterImport applies at merge time, so preview and real result can never disagree.
// ============================================================================

function makeRasterLabel(standNumber: string, id: string): RasterStandLabel {
  return { id, rawText: standNumber, normalizedStandNumber: standNumber, page: 1, xNormalized: 0.2, yNormalized: 0.3, widthNormalized: 0.03, heightNormalized: 0.015 };
}

function electricityRow(standNumber: string) {
  return { standNumber, services: [{ category: "electricity", externalLabel: "Do 2 kW", quantity: 1, rawValue: "1", sourcePage: 1 }], notes: [] };
}

test("summarizeParsedReportScope: BASIC MULTI-HALL PREVIEW — raster 3A01 only, report rows 3A01 (matched) + 4A01/4B02 (outside current raster)", () => {
  const raster = [makeRasterLabel("3A01", "l1")];
  const report: ParsedTechnicalReport = { category: "electricity", rows: [electricityRow("3A01"), electricityRow("4A01"), electricityRow("4B02")], warnings: [] };
  const scope = summarizeParsedReportScope(report, raster);
  assert.equal(scope.importedStandCount, 3);
  assert.equal(scope.matchedCurrentRasterCount, 1);
  assert.equal(scope.outsideCurrentRasterCount, 2);
  assert.equal(scope.unmatchedCount, 0);
  assert.equal(scope.ambiguousCount, 0);
});

test("summarizeParsedReportScope: a current-hall typo (3A99 against a 3A01/3A02 raster) counts as unmatched, never outsideCurrentRaster", () => {
  const raster = [makeRasterLabel("3A01", "l1"), makeRasterLabel("3A02", "l2")];
  const report: ParsedTechnicalReport = { category: "electricity", rows: [electricityRow("3A99")], warnings: [] };
  const scope = summarizeParsedReportScope(report, raster);
  assert.equal(scope.unmatchedCount, 1);
  assert.equal(scope.outsideCurrentRasterCount, 0);
});

test("summarizeParsedReportScope: an ambiguous raster match is counted separately, never folded into matched/unmatched/outside", () => {
  const raster = [makeRasterLabel("3A01", "l1"), makeRasterLabel("3A01", "l2")];
  const report: ParsedTechnicalReport = { category: "electricity", rows: [electricityRow("3A01")], warnings: [] };
  const scope = summarizeParsedReportScope(report, raster);
  assert.equal(scope.ambiguousCount, 1);
  assert.equal(scope.matchedCurrentRasterCount, 0);
  assert.equal(scope.outsideCurrentRasterCount, 0);
  assert.equal(scope.unmatchedCount, 0);
});

test("summarizeParsedReportScope: no reliable hall prefix (raster A01/A02) never assumes a foreign hall, everything unmatched falls into unmatchedCount", () => {
  const raster = [makeRasterLabel("A01", "l1"), makeRasterLabel("A02", "l2")];
  const report: ParsedTechnicalReport = { category: "electricity", rows: [electricityRow("B99")], warnings: [] };
  const scope = summarizeParsedReportScope(report, raster);
  assert.equal(scope.unmatchedCount, 1);
  assert.equal(scope.outsideCurrentRasterCount, 0);
});

function makeStand(overrides: Partial<TechnicalStand> & { id: string; standNumber: string }): TechnicalStand {
  return {
    companyName: undefined,
    services: [],
    notes: [],
    placement: { status: "unassigned" },
    sourceImportIds: [],
    ...overrides,
  };
}

test("groupImportedStandsByImport: only pulls services/notes whose sourceImportId matches the given import (provenance filter, never the whole stand)", () => {
  const stands: TechnicalStand[] = [
    makeStand({
      id: "s1",
      standNumber: "1B04",
      companyName: "KLIA PRAHA s.r.o.",
      sourceImportIds: ["import-electricity", "import-waste"],
      services: [
        { id: "svc1", category: "electricity", externalLabel: "Do 6 kW", internalProductId: undefined, internalProductCode: undefined, quantity: 1, rawValue: "1", sourceImportId: "import-electricity", sourcePage: 1, status: "resolved" },
        { id: "svc2", category: "waste", externalLabel: "Kontejner", internalProductId: undefined, internalProductCode: undefined, quantity: 1, rawValue: "1", sourceImportId: "import-waste", sourcePage: 1, status: "resolved" },
      ],
      notes: [{ id: "n1", text: "doobjednáno telefonicky", sourceImportId: "import-waste", sourcePage: 1 }],
    }),
  ];
  const electricityView = groupImportedStandsByImport(stands, "import-electricity");
  assert.equal(electricityView.length, 1);
  assert.equal(electricityView[0]?.services.length, 1);
  assert.equal(electricityView[0]?.services[0]?.externalLabel, "Do 6 kW");
  assert.deepEqual(electricityView[0]?.notes, [], "the waste note must not leak into the electricity import's own view");

  const wasteView = groupImportedStandsByImport(stands, "import-waste");
  assert.equal(wasteView[0]?.services[0]?.externalLabel, "Kontejner");
  assert.deepEqual(wasteView[0]?.notes, ["doobjednáno telefonicky"]);
});

test("groupImportedStandsByImport: omits a stand entirely once none of this import's services/notes remain on it (e.g. superseded), never shows an empty group", () => {
  const stands: TechnicalStand[] = [
    makeStand({ id: "s1", standNumber: "1A01", sourceImportIds: ["import-old"], services: [], notes: [] }),
  ];
  assert.deepEqual(groupImportedStandsByImport(stands, "import-old"), []);
});

test("matchesTechnicalImportPreviewSearch: empty query matches everything; substring match is diacritics- and case-insensitive on stand number + company name", () => {
  const group = { standNumber: "1A01", companyName: "Firma Ř. s.r.o.", services: [], notes: [] };
  assert.equal(matchesTechnicalImportPreviewSearch(group, ""), true);
  assert.equal(matchesTechnicalImportPreviewSearch(group, "1a01"), true);
  assert.equal(matchesTechnicalImportPreviewSearch(group, "rimo"), false);
  assert.equal(matchesTechnicalImportPreviewSearch(group, "firma r"), true, "diacritics-insensitive: 'r' must match 'Ř'");
  assert.equal(matchesTechnicalImportPreviewSearch(group, "nope"), false);
});
