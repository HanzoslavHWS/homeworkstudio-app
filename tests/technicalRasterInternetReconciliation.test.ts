import assert from "node:assert/strict";
import test from "node:test";
import { reconcileTechnicalReportAndCatalog, resolveCanonicalServiceVariant, type TechnicalReconciliationMention } from "../domain/technicalRasterReconciliation.ts";
import { extractTechnicalMentionsFromCatalogStand, type ParsedCatalogStand } from "../domain/technicalRasterCatalogImport.ts";
import { requiredPlacementCount, createTechnicalRasterProject, mergeSupplementalCatalogImport, mergeTechnicalRasterImport, withRasterStandLabels, buildPrimaryReportMentions, type TechnicalService } from "../domain/technicalRaster.ts";
import { resolveTechnicalServicePresentation } from "../domain/technicalRasterServicePresentation.ts";
import type { StoredAsset } from "../domain/assets.ts";

// =========================================================================================
// CORRECTIVE BATCH (real FOR BEAUTY production, 3A45) — Internet reconciliation.
// Real sources for 3A45:
//   report : "Pevná IP" 1, "Internet" 1, "Router zapůjčení" 1
//   catalog: "INTERNET - KABEL RJ45, 1. PŘIPOJENÍ" 1, "INTERNET - PEVNÁ IP ADRESA" 1, "Router - zapůjčení" 1
// Root cause: the report's router row fell into the catch-all "internet:plain" variant and was
// SUMMED with the Internet row (report 2× vs catalog 1×), while the catalog's router row was not
// classified as internet at all. Router rental now has its own reconciliation variant on BOTH sides.
// =========================================================================================

const REPORT_3A45: readonly TechnicalReconciliationMention[] = [
  { standNumber: "3A45", category: "internet", externalLabel: "Pevná IP", quantity: 1 },
  { standNumber: "3A45", category: "internet", externalLabel: "Internet", quantity: 1 },
  { standNumber: "3A45", category: "internet", externalLabel: "Router zapůjčení", quantity: 1 },
];

function catalogStand(standNumber: string, items: readonly (readonly [string, number])[], realizationCompanyRaw?: string): ParsedCatalogStand {
  return {
    standNumber,
    companyName: "Firma",
    realizationCompanyRaw,
    items: items.map(([label, quantity]) => ({ label, quantity, unit: "ks", rawQuantityText: `${quantity},0 ks`, notes: [], page: 1 })),
    page: 1,
  };
}

const CATALOG_3A45 = catalogStand("3A45", [
  ["INTERNET - KABEL RJ45, 1. PŘIPOJENÍ", 1],
  ["INTERNET - PEVNÁ IP ADRESA", 1],
  ["Router - zapůjčení", 1],
  ["TROJZÁSUVKA", 2],
]);

test("3A45: canonical variants per source row — router never lands in internet:plain; fixed IP stays separate", () => {
  assert.deepEqual(REPORT_3A45.map((mention) => resolveCanonicalServiceVariant("internet", mention.externalLabel)), ["fixed-ip", "internet:plain", "internet:router"]);
  const catalogMentions = extractTechnicalMentionsFromCatalogStand(CATALOG_3A45);
  assert.deepEqual(catalogMentions.map((mention) => [mention.category, resolveCanonicalServiceVariant(mention.category, mention.externalLabel)]), [
    ["internet", "internet:plain"],
    ["internet", "fixed-ip"],
    ["internet", "internet:router"],
  ], "catalog router row is internet equipment on the catalog side too; a socket (TROJZÁSUVKA) is not a technical mention");
});

test("3A45: reconciles cleanly — plain 1=1, fixed IP 1=1, router 1=1, no quantity mismatch, no conflict", () => {
  const outcomes = reconcileTechnicalReportAndCatalog(REPORT_3A45, extractTechnicalMentionsFromCatalogStand(CATALOG_3A45));
  assert.deepEqual(outcomes.map((outcome) => [outcome.status, "variant" in outcome ? outcome.variant : "", "quantity" in outcome ? outcome.quantity : -1]).sort(), [
    ["shoda", "fixed-ip", 1],
    ["shoda", "internet:plain", 1],
    ["shoda", "internet:router", 1],
  ]);
});

test("Router does not inflate plain Internet even when the catalog has no router row (router becomes its own only_report, plain stays 1=1)", () => {
  const catalogWithoutRouter = catalogStand("3A45", [["INTERNET - KABEL RJ45, 1. PŘIPOJENÍ", 1]]);
  const outcomes = reconcileTechnicalReportAndCatalog(REPORT_3A45.filter((mention) => mention.externalLabel !== "Pevná IP"), extractTechnicalMentionsFromCatalogStand(catalogWithoutRouter));
  assert.deepEqual(outcomes.map((outcome) => outcome.status).sort(), ["only_report", "shoda"]);
  assert.ok(!outcomes.some((outcome) => outcome.status === "quantity_mismatch"));
});

test("A REAL plain-Internet quantity difference is still reported (diagnostic-only), router or not", () => {
  const outcomes = reconcileTechnicalReportAndCatalog(
    [{ standNumber: "3A46", category: "internet", externalLabel: "Internet", quantity: 2 }, { standNumber: "3A46", category: "internet", externalLabel: "Router zapůjčení", quantity: 1 }],
    extractTechnicalMentionsFromCatalogStand(catalogStand("3A46", [["INTERNET - KABEL RJ45, 1. PŘIPOJENÍ", 1], ["Router - zapůjčení", 1]])),
  );
  const mismatch = outcomes.find((outcome) => outcome.status === "quantity_mismatch");
  assert.ok(mismatch && mismatch.status === "quantity_mismatch");
  assert.deepEqual([mismatch.variant, mismatch.reportQuantity, mismatch.catalogQuantity], ["internet:plain", 2, 1]);
});

test("WiFi semantics unchanged: WIFI stays 'wifi' in reconciliation and onePerRecord (1 marker) for placement", () => {
  assert.equal(resolveCanonicalServiceVariant("internet", "WIFI"), "wifi");
  assert.equal(resolveCanonicalServiceVariant("internet", "INTERNET - WIFI PŘIPOJENÍ (MIMO VENKOVNÍ"), "wifi");
  const wifi: TechnicalService = { id: "s", category: "internet", externalLabel: "WIFI", quantity: 5, rawValue: "5", sourceImportId: "i", sourcePage: 1, status: "unresolved_product" };
  assert.equal(requiredPlacementCount(wifi), 1);
});

test("Marker business rules untouched: Internet / IP / router presentation + cardinality come from the unchanged presentation resolver", () => {
  const internet = resolveTechnicalServicePresentation("internet", "Internet");
  const ip = resolveTechnicalServicePresentation("internet", "Pevná IP");
  assert.equal(ip.displayLabel, "IP");
  assert.equal(internet.placementCardinality, "perQuantity");
  assert.equal(ip.placementCardinality, "perQuantity");
});

// =========================================================================================
// Previous normalization — regression guards kept together for this batch
// =========================================================================================

test("PREVIOUS: cleaning aliases (generální úklid / úklid jednorázový, with and without diacritics) stay one variant; daily cleaning distinct", () => {
  const variants = ["generální úklid", "generalni uklid", "úklid jednorázový", "uklid jednorazovy"].map((label) => resolveCanonicalServiceVariant("cleaning", label));
  assert.deepEqual(new Set(variants), new Set(["cleaning:general"]));
  assert.equal(resolveCanonicalServiceVariant("cleaning", "ÚKLID DENNÍ"), "cleaning:daily");
});

test("PREVIOUS: water aliases 'voda, odpad' and 'voda / odpad (přívod)' stay one variant", () => {
  assert.equal(resolveCanonicalServiceVariant("water", "voda, odpad"), resolveCanonicalServiceVariant("water", "VODA / ODPAD (PŘÍVOD)"));
});

test("PREVIOUS: catalog 'BEZ ELEKTRICKÉ ENERGIE' vs a report electricity service is still a TRUE conflict", () => {
  const outcomes = reconcileTechnicalReportAndCatalog(
    [{ standNumber: "1A01", category: "electricity", externalLabel: "Do 2kW 230V", quantity: 1 }],
    extractTechnicalMentionsFromCatalogStand(catalogStand("1A01", [["BEZ ELEKTRICKÉ ENERGIE", 1]])),
  );
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["conflict"]);
});

function makeAsset(id: string): StoredAsset {
  return { id, storageKey: `k/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 1, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-import" };
}

test("PREVIOUS: a quantity mismatch is diagnostic-only — the stand stays matched and keeps hasCatalogBuildRecord + its realization", () => {
  let project = createTechnicalRasterProject({ name: "H3" }, "p");
  project = withRasterStandLabels(project, [{ id: "l1", page: 1, rawText: "3A46", normalizedStandNumber: "3A46", xNormalized: 0.5, yNormalized: 0.5, widthNormalized: 0.01, heightNormalized: 0.01 }]);
  project = mergeTechnicalRasterImport(
    project,
    { id: "imp", category: "internet", filename: "i.pdf", asset: makeAsset("i"), importedAt: "2026-01-01T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: 1, servicesFound: 1, warnings: [] },
    { category: "internet", rows: [{ standNumber: "3A46", services: [{ category: "internet", externalLabel: "Internet", quantity: 2, rawValue: "2", sourcePage: 1 }], notes: [] }], warnings: [] },
    () => ({ status: "unresolved_product" as const }),
  );
  project = mergeSupplementalCatalogImport(project, { stands: [catalogStand("3A46", [["INTERNET - KABEL RJ45, 1. PŘIPOJENÍ", 1]], "MAC Praha, spol. s r.o.")], warnings: [] }, "katalog.pdf");
  const outcomes = reconcileTechnicalReportAndCatalog(buildPrimaryReportMentions(project), project.catalogMentions ?? []);
  assert.deepEqual(outcomes.map((outcome) => outcome.status), ["quantity_mismatch"]);
  const stand = project.stands.find((candidate) => candidate.standNumber === "3A46")!;
  assert.equal(stand.placement.status, "matched_auto");
  assert.equal(stand.hasCatalogBuildRecord, true);
  assert.equal(stand.realizationCompany, "MAC Praha, spol. s r.o.");
  assert.equal(stand.services[0]!.rawValue, "2", "raw source value preserved");
});
