/**
 * Technické rastry — corrective batch (multi-hall imports) section 18: a diagnostic simulating the
 * real-world scenario the batch describes (a Hala 3 raster project receiving ONE electricity report
 * that mixes Hala 3 and Hala 4 rows). No real multi-hall fixture exists in `_IMPORT/` (every local
 * fixture — `Hala 1.pdf`, the "Decor 26" electricity/internet/water/waste/cleaning reports — is
 * single-hall), so this is a SYNTHETIC diagnostic built directly from this app's own real domain
 * functions (`mergeTechnicalRasterImport`, `rematchStands`, `classifyStandScope`,
 * `groupStandsByPlacementWorkQueue`, `buildTechnicalRasterExportPlacements`) — never a mock of any
 * of them. Never required by `npm test`, never depends on a gitignored file.
 *
 * Usage: node --no-warnings scripts/technicalRasterHallScopeDiagnostic.ts
 */
import { createTechnicalRasterProject, mergeTechnicalRasterImport, withRasterStandLabels, type ParsedTechnicalReport, type RasterStandLabel, type TechnicalRasterImport } from "../domain/technicalRaster.ts";
import { groupStandsByPlacementWorkQueue, computeTechnicalRasterPlacementSummary } from "../domain/technicalRasterWorkQueue.ts";
import { buildTechnicalRasterExportPlacements, computeTechnicalRasterStatusSummary, computeTechnicalRasterExportWarnings } from "../domain/technicalRasterExport.ts";
import type { StoredAsset } from "../domain/assets.ts";

function section(title: string): void {
  console.log("\n" + "=".repeat(78));
  console.log(title);
  console.log("=".repeat(78));
}

function makeAsset(id: string): StoredAsset {
  return { id, storageKey: `technical-rasters/diag/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 100, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-source" };
}

function makeImport(): TechnicalRasterImport {
  return { id: "imp-electricity-combined", category: "electricity", filename: "Hala3+4_elektrina.pdf", asset: makeAsset("imp"), importedAt: "2026-01-01T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: 100, servicesFound: 100, warnings: [] };
}

function makeLabel(standNumber: string): RasterStandLabel {
  return { id: `label-${standNumber}`, rawText: standNumber, normalizedStandNumber: standNumber, page: 1, xNormalized: 0.1, yNormalized: 0.1, widthNormalized: 0.03, heightNormalized: 0.015 };
}

function main(): void {
  section("SETUP — Hala 3 raster project with 50 REAL Hala 3 stand labels detected");
  const hala3Labels: RasterStandLabel[] = Array.from({ length: 50 }, (_, i) => makeLabel(`3A${String(i + 1).padStart(2, "0")}`));
  let project = createTechnicalRasterProject({ name: "FOR DECOR 2026 — Hala 3", hall: "Hala 3" }, "diag-project");
  project = withRasterStandLabels(project, hala3Labels);
  console.log(`Raster stand labels detected: ${hala3Labels.length} (all "3A.." — Hala 3)`);

  section("IMPORT — ONE combined electricity report: 50 Hala 3 rows + 50 Hala 4 rows");
  const report: ParsedTechnicalReport = {
    category: "electricity",
    rows: [
      ...Array.from({ length: 50 }, (_, i) => ({
        standNumber: `3A${String(i + 1).padStart(2, "0")}`,
        services: [{ category: "electricity", externalLabel: "Do 2 kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }],
        notes: [],
      })),
      ...Array.from({ length: 50 }, (_, i) => ({
        standNumber: `4A${String(i + 1).padStart(2, "0")}`,
        services: [{ category: "electricity", externalLabel: "Do 2 kW 230V", quantity: 1, rawValue: "1", sourcePage: 1 }],
        notes: [],
      })),
    ],
    warnings: [],
  };
  project = mergeTechnicalRasterImport(project, makeImport(), report, () => ({ status: "unresolved_product" as const }));

  section("RESULT — per-stand classification counts");
  const byStatus = new Map<string, number>();
  for (const stand of project.stands) byStatus.set(stand.placement.status, (byStatus.get(stand.placement.status) ?? 0) + 1);
  console.log("Imported (distinct stand numbers):", project.stands.length);
  console.log("By placement status:", Object.fromEntries(byStatus));

  const hala4Sample = project.stands.filter((stand) => stand.standNumber.startsWith("4A")).slice(0, 3);
  console.log("Sample Hala 4 records (raw data preserved, never discarded):");
  for (const stand of hala4Sample) {
    console.log(`  ${stand.standNumber}: status=${stand.placement.status}, service="${stand.services[0]?.externalLabel}" x${stand.services[0]?.quantity}`);
  }

  section("WORK QUEUE — must contain ONLY the 50 real Hala 3 stands");
  const assigned = project.stands.filter((stand) => stand.placement.status === "matched_auto" || stand.placement.status === "matched_manual");
  const queue = groupStandsByPlacementWorkQueue(assigned);
  console.log(`assigned (matched_auto/matched_manual): ${assigned.length}`);
  console.log(`toPlace: ${queue.toPlace.length}, done: ${queue.done.length}, noPointServices: ${queue.noPointServices.length}`);
  console.log(`sum = ${queue.toPlace.length + queue.done.length + queue.noPointServices.length} (must equal 50, never 100)`);
  const placementSummary = computeTechnicalRasterPlacementSummary(assigned);
  console.log("Placement completion summary:", placementSummary);

  section("EXPORT — status summary + warnings must reflect ONLY the current (Hala 3) raster");
  const statusSummary = computeTechnicalRasterStatusSummary(project);
  console.log("computeTechnicalRasterStatusSummary:", statusSummary, "(totalStandCount must be 50, never 100)");
  const warnings = computeTechnicalRasterExportWarnings(project);
  console.log("computeTechnicalRasterExportWarnings:", warnings, "(unmatchedStandsWithServices must be empty — the 50 Hala 4 records are informational, never errors)");
  const exportPlacements = buildTechnicalRasterExportPlacements(project, 1, new Set());
  const foreignInExport = exportPlacements.filter((item) => item.standNumber.startsWith("4A"));
  console.log(`Export placements built: ${exportPlacements.length} (must be 0 here — none of the 50 Hala 3 stands were ever placed with a point in this diagnostic)`);
  console.log(`Foreign-hall (4A..) placements leaking into the export: ${foreignInExport.length} (must always be 0)`);
}

main();
