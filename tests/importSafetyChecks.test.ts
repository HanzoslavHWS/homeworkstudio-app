import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAbraOrderFormPdf } from "../domain/abraOrderForm.ts";
import { buildAbraOrderTechnicalImport, type AbraOrderTechnicalImport } from "../domain/abraOrderTechnicalImport.ts";
import { applyAbraOrderImport, placementLossOfOrderDecisions, reconcileAbraOrdersWithProject } from "../domain/abraOrderReconciliation.ts";
import { checkAbraOrderFairAffiliation, fairConfirmationOf } from "../domain/abraOrderFairCheck.ts";
import {
  ABRA_ORDER_IMPORT_CATEGORY,
  createTechnicalRasterProject,
  effectiveServicePlacements,
  mergeTechnicalRasterImportWithDiff,
  placeTechnicalService,
  placementLossOfDiff,
  resolveTechnicalImportReplacement,
  withRasterStandLabels,
  type ParsedTechnicalReport,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
  type TechnicalService,
} from "../domain/technicalRaster.ts";
import type { PdfTextItem } from "../domain/technicalReportTableParsing.ts";
import type { StoredAsset } from "../domain/assets.ts";

// =========================================================================================
// Two safety checks before an import changes a project:
//  1. a lower quantity removes NOT-YET-PLACED points first; placed points disappear only after an
//     explicit confirmation (listed in the preview, the confirm button waits for it);
//  2. the ABRA order PDF carries no fair identifier -> its fair is never guessed: the user confirms the
//     file belongs to the project's fair, a factual contradiction is shown as a conflict.
// =========================================================================================

function asset(id: string): StoredAsset {
  return { id, storageKey: `k/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 1, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-import" };
}

let counter = 0;
function record(category: string): TechnicalRasterImport {
  counter += 1;
  return { id: `imp-${counter}`, category, filename: `${category}-${counter}.pdf`, asset: asset(`a${counter}`), importedAt: "2026-10-30T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: 1, servicesFound: 1, warnings: [] };
}

function newProject(stands: readonly string[] = ["1A01", "1A02"]): TechnicalRasterProject {
  return withRasterStandLabels(createTechnicalRasterProject({ name: "Hala 1", hall: "1" }, "p"), stands.map((stand, index) => ({ id: `l-${stand}`, page: 1, rawText: stand, normalizedStandNumber: stand, xNormalized: 0.2 + index * 0.3, yNormalized: 0.5, widthNormalized: 0.02, heightNormalized: 0.01 })));
}

function electricity(rows: readonly (readonly [stand: string, label: string, quantity: number])[]): ParsedTechnicalReport {
  return { category: "electricity", rows: rows.map(([standNumber, externalLabel, quantity]) => ({ standNumber, services: [{ category: "electricity", externalLabel, quantity, rawValue: String(quantity), sourcePage: 1 }], notes: [] })), warnings: [] };
}

function importReport(project: TechnicalRasterProject, report: ParsedTechnicalReport) {
  return mergeTechnicalRasterImportWithDiff(project, record(report.category), report, () => ({ status: "unresolved_product" as const }), resolveTechnicalImportReplacement(project, report.category));
}

const servicesOf = (project: TechnicalRasterProject, stand = "1A01"): readonly TechnicalService[] => project.stands.find((candidate) => candidate.standNumber === stand)?.services ?? [];

/** Places `count` points of the service at index `serviceIndex` of the stand. */
function place(project: TechnicalRasterProject, count: number, serviceIndex = 0, stand = "1A01"): TechnicalRasterProject {
  let next = project;
  const standId = next.stands.find((candidate) => candidate.standNumber === stand)!.id;
  const serviceId = servicesOf(next, stand)[serviceIndex]!.id;
  for (let index = 0; index < count; index += 1) next = placeTechnicalService(next, standId, serviceId, { page: 1, xNormalized: 0.1 + index * 0.02, yNormalized: 0.3 + serviceIndex * 0.1 });
  return next;
}

const pointsOf = (project: TechnicalRasterProject, stand = "1A01") => servicesOf(project, stand).map((service) => [service.quantity, effectiveServicePlacements(service).length]);

// --- ABRA order page fixture (same measured layout as tests/abraOrderImport.test.ts) ---------------
function cell(page: number, x: number, y: number, str: string): PdfTextItem {
  return { str, page, x, y, width: str.length * 4, height: 8 };
}
function orderPage(page: number, orderNumber: string, stand: string, rows: readonly (readonly [code: string, quantity: string])[]): PdfTextItem[] {
  const items: PdfTextItem[] = [cell(page, 249, 799, "Objednávka přijatá č."), cell(page, 426, 798, orderNumber), cell(page, 531, 788, "č."), cell(page, 541, 787, "1")];
  items.push(cell(page, 62, 748, "Dodavatel:"), cell(page, 252, 748, "Odběratel:"), cell(page, 365, 748, "Zákaznické číslo: TR0001"), cell(page, 481, 727, stand), cell(page, 289, 708, "Firma s.r.o."));
  items.push(cell(page, 255, 578, "Datum vystavení dokladu:"), cell(page, 377, 578, "27.01.2026"));
  items.push(cell(page, 389, 544, "Cena za jedn."), cell(page, 65, 538, "Předmět zdanitelného plnění"), cell(page, 311, 538, "Množství / j."));
  let y = 515;
  for (const [code, quantity] of rows) {
    items.push(cell(page, 71, y, code), cell(page, 139, y, "ELEKTRICKÁ ENERGIE - PŘÍKON D"), cell(page, 328, y, quantity), cell(page, 357, y, "ks"), cell(page, 428, y, "0,000"), cell(page, 507, y, "0,00"), cell(page, 541, y, "21%"));
    y -= 14.5;
  }
  items.push(cell(page, 71, y - 10, "Částky v CZK"));
  return items;
}
function orders(series: string, ...perStand: readonly (readonly [stand: string, rows: readonly (readonly [string, string])[]])[]): AbraOrderTechnicalImport {
  return buildAbraOrderTechnicalImport(parseAbraOrderFormPdf(perStand.flatMap(([stand, rows], index) => orderPage(index + 1, `${series}-${index + 1}/2026`, stand, rows))));
}

// =========================================================================================
// 1. Lower quantity: unplaced points first, placed points only with an explicit confirmation
// =========================================================================================

test("REPORT RE-IMPORT 3× -> 2× with ONE point placed: the unplaced point goes, the placed one stays — nothing to confirm", () => {
  let project = importReport(newProject(), electricity([["1A01", "Do 3kW 230V", 3]])).project;
  project = place(project, 1);
  const { project: after, diff } = importReport(project, electricity([["1A01", "Do 3kW 230V", 2]]));
  assert.deepEqual(pointsOf(after), [[2, 1]]);
  assert.deepEqual(diff!.changes.map((change) => [change.kind, change.removedPlacementCount]), [["quantityDecreased", 0]]);
  assert.deepEqual(placementLossOfDiff(diff), [], "no placed point is lost -> no confirmation needed");
});

test("REPORT RE-IMPORT 3× -> 1× with all THREE placed: the 2 placed points that would disappear are listed for an explicit confirmation", () => {
  let project = importReport(newProject(), electricity([["1A01", "Do 3kW 230V", 3]])).project;
  project = place(project, 3);
  const dryRun = importReport(project, electricity([["1A01", "Do 3kW 230V", 1]]));
  assert.deepEqual(placementLossOfDiff(dryRun.diff), [{ standNumber: "1A01", externalLabel: "Do 3kW 230V", previousQuantity: 3, quantity: 1, placementCount: 2 }]);
  // 3× -> 2× with 2 of 3 placed: still only unplaced first.
  let partly = importReport(newProject(), electricity([["1A01", "Do 3kW 230V", 3]])).project;
  partly = place(partly, 2);
  assert.deepEqual(placementLossOfDiff(importReport(partly, electricity([["1A01", "Do 3kW 230V", 2]])).diff), []);
  assert.deepEqual(placementLossOfDiff(importReport(partly, electricity([["1A01", "Do 3kW 230V", 1]])).diff).map((item) => item.placementCount), [1]);
});

test("REPORT RE-IMPORT: a service missing from the new report takes its placed points with it — listed too; without points it needs no confirmation", () => {
  let project = importReport(newProject(), electricity([["1A01", "Do 3kW 230V", 1], ["1A02", "Do 9kW 400V", 1]])).project;
  project = place(project, 1, 0, "1A01");
  const loss = placementLossOfDiff(importReport(project, electricity([["1A02", "Do 9kW 400V", 1]])).diff);
  assert.deepEqual(loss.map((item) => [item.standNumber, item.externalLabel, item.placementCount]), [["1A01", "Do 3kW 230V", 1]]);
  const unplaced = importReport(newProject(), electricity([["1A01", "Do 3kW 230V", 1], ["1A02", "Do 9kW 400V", 1]])).project;
  assert.deepEqual(placementLossOfDiff(importReport(unplaced, electricity([["1A02", "Do 9kW 400V", 1]])).diff), []);
});

test("ORDERS lower the quantity (3× placed 1 -> 2×): no placed point dropped; with every point placed the drop is shown and needs the decision AND the confirmation", () => {
  let project = importReport(newProject(), electricity([["1A01", "Do 3kW 230V", 3]])).project;
  project = place(project, 1);
  const lower = orders("V1", ["1A01", [["L03", "2,000"]]]);
  const reconciliation = reconcileAbraOrdersWithProject(project, lower);
  const [item] = reconciliation.services;
  assert.deepEqual([item!.kind, item!.placementsDroppedIfApplied], ["quantityDiff", 0]);
  const accepted = new Set([item!.id]);
  assert.deepEqual(placementLossOfOrderDecisions(reconciliation, accepted), []);
  assert.deepEqual(pointsOf(applyAbraOrderImport(project, record(ABRA_ORDER_IMPORT_CATEGORY), lower, accepted).project), [[2, 1]]);

  const full = place(importReport(newProject(), electricity([["1A01", "Do 3kW 230V", 3]])).project, 3);
  const fullReconciliation = reconcileAbraOrdersWithProject(full, lower);
  const fullItem = fullReconciliation.services[0]!;
  assert.equal(fullItem.placementsDroppedIfApplied, 1);
  assert.deepEqual(placementLossOfOrderDecisions(fullReconciliation, new Set()), [], "not accepted -> nothing to lose");
  assert.deepEqual(placementLossOfOrderDecisions(fullReconciliation, new Set([fullItem.id])), [{ standNumber: "1A01", externalLabel: "Do 3kW 230V", previousQuantity: 3, quantity: 2, placementCount: 1 }]);
  assert.deepEqual(pointsOf(applyAbraOrderImport(full, record(ABRA_ORDER_IMPORT_CATEGORY), lower, new Set()).project), [[3, 3]], "not accepted -> untouched");
});

test("ORDERS lower a GROUP of two equal services: the unplaced one is reduced first, the placed one keeps its point", () => {
  // Two "Do 3kW" services of 1 each (two orders); only the SECOND is placed. Orders now: 1× in total.
  let project = applyAbraOrderImport(newProject(), record(ABRA_ORDER_IMPORT_CATEGORY), orders("V1", ["1A01", [["L03", "1,000"], ["L03", "1,000"]]]), new Set(reconcileAbraOrdersWithProject(newProject(), orders("V1", ["1A01", [["L03", "1,000"], ["L03", "1,000"]]])).defaultAcceptedIds)).project;
  project = place(project, 1, 1);
  assert.deepEqual(pointsOf(project), [[1, 0], [1, 1]]);
  const lower = orders("V1", ["1A01", [["L03", "1,000"]]]);
  const reconciliation = reconcileAbraOrdersWithProject(project, lower);
  const item = reconciliation.services[0]!;
  assert.deepEqual([item.kind, item.existingQuantity, item.orderQuantity, item.placementsDroppedIfApplied], ["quantityDiff", 2, 1, 0]);
  assert.deepEqual(pointsOf(applyAbraOrderImport(project, record(ABRA_ORDER_IMPORT_CATEGORY), lower, new Set([item.id])).project), [[0, 0], [1, 1]]);
});

test("UI wiring: the preview lists placed points that would disappear and the fair check; the confirm button and the confirm handler both wait for the explicit confirmations", async () => {
  const editor = await readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterEditorPage.tsx", import.meta.url), "utf8");
  assert.match(editor, /<PlacementLossConfirmation items=\{safety\.placementLoss\} confirmed=\{placementLossConfirmed\}/u);
  assert.match(editor, /\{safety\.fairCheck && <AbraOrderFairConfirmation check=\{safety\.fairCheck\} confirmed=\{fairConfirmed\}/u);
  assert.match(editor, /disabled=\{isConfirmingImport \|\| !safetyConfirmed\(safety\)\}/u);
  const confirmStart = editor.indexOf("async function handleConfirmImport(");
  const confirm = editor.slice(confirmStart, editor.indexOf("const asset = await uploadAsset(", confirmStart));
  assert.match(confirm, /if \(!safetyConfirmed\(safety\)\) \{/u, "never applied without the confirmations, even if the button were bypassed");
  assert.match(editor, /fairConfirmation: fairConfirmationOf\(safety\.fairCheck\)/u, "what was confirmed is stored on the import");
  assert.match(editor, /placementLoss: placementLossOfDiff\(diff\)/u, "report re-import: from the dry run of the exact merge");
  assert.match(editor, /setPlacementLossConfirmed\(false\); setOrderDecisions/u, "changing a decision asks again");
  const checks = await readFile(new URL("../components/workflow/technicalRasters/TechnicalImportSafetyChecks.tsx", import.meta.url), "utf8");
  assert.match(checks, /Rozumím a souhlasím s odstraněním/u);
  assert.match(checks, /<dt>Zdrojový soubor<\/dt>/u);
  assert.match(checks, /<dt>Cílový veletrh<\/dt>/u);
});

// =========================================================================================
// 2. Fair of the ABRA order PDF — never guessed
// =========================================================================================

test("FAIR CHECK: no fair identifier in the PDF -> 'unverifiable', naming the source file (series, dates) and the target fair; explicit confirmation text", () => {
  const orderImport = orders("V238", ["1A01", [["L03", "1,000"]]]);
  assert.deepEqual(orderImport.documents, { orderSeries: ["V238"], issueDateRange: { from: "27.01.2026", to: "27.01.2026" } });
  const check = checkAbraOrderFairAffiliation({ project: newProject(), orderImport, sourceFileName: "objednavky.pdf", targetEventLabel: "Veletrh A 2026" });
  assert.equal(check.status, "unverifiable");
  assert.deepEqual(check.findings.map((finding) => finding.kind), ["noFairIdentifier"]);
  assert.deepEqual(check.target, { projectName: "Hala 1", hall: "1", eventLabel: "Veletrh A 2026" });
  assert.deepEqual(check.standsInRaster, { matched: 1, total: 1 });
  assert.equal(check.confirmationText, "Potvrzuji, že soubor „objednavky.pdf“ patří k veletrhu „Veletrh A 2026“ (projekt „Hala 1“, hala 1).");
  const stored = fairConfirmationOf(check, "2026-10-30T12:00:00.000Z");
  assert.deepEqual(stored, { status: "unverifiable", orderSeries: ["V238"], targetEventLabel: "Veletrh A 2026", findings: [check.findings[0]!.message], confirmedAt: "2026-10-30T12:00:00.000Z" });
});

test("FAIR CHECK: a project without a fair says so; nothing is invented from the order series", () => {
  const check = checkAbraOrderFairAffiliation({ project: newProject(), orderImport: orders("V238", ["1A01", [["L03", "1,000"]]]), sourceFileName: "o.pdf" });
  assert.equal(check.status, "unverifiable");
  assert.deepEqual(check.findings.map((finding) => finding.kind), ["noFairIdentifier", "noTargetFair"]);
  assert.equal(check.target.eventLabel, undefined);
  assert.match(check.confirmationText, /patří k veletrhu tohoto projektu/u);
});

test("FAIR CHECK conflicts: another order series than the project's earlier order import, or not one ordered stand on the raster", () => {
  const first = orders("V238", ["1A01", [["L03", "1,000"]]]);
  const project = applyAbraOrderImport(newProject(), { ...record(ABRA_ORDER_IMPORT_CATEGORY), fairConfirmation: { status: "unverifiable", orderSeries: ["V238"], findings: [], confirmedAt: "x" } }, first, reconcileAbraOrdersWithProject(newProject(), first).defaultAcceptedIds).project;
  // Same series again: no conflict.
  assert.equal(checkAbraOrderFairAffiliation({ project, orderImport: first, sourceFileName: "o.pdf", targetEventLabel: "A" }).status, "unverifiable");
  // Another series.
  const other = checkAbraOrderFairAffiliation({ project, orderImport: orders("V239", ["1A01", [["L03", "1,000"]]]), sourceFileName: "jine.pdf", targetEventLabel: "A" });
  assert.equal(other.status, "conflict");
  assert.ok(other.findings.some((finding) => finding.message === "Rozpor: dříve importované objednávky v tomto projektu mají řadu V238, nový soubor V239."));
  assert.match(other.confirmationText, /^Přes uvedený rozpor potvrzuji, že soubor „jine\.pdf“/u);
  // No ordered stand on the raster.
  const elsewhere = checkAbraOrderFairAffiliation({ project: newProject(), orderImport: orders("V238", ["9Z99", [["L03", "1,000"]]], ["9Z98", [["L09", "1,000"]]]), sourceFileName: "o.pdf", targetEventLabel: "A" });
  assert.equal(elsewhere.status, "conflict");
  assert.deepEqual(elsewhere.standsInRaster, { matched: 0, total: 2 });
  assert.ok(elsewhere.findings.some((finding) => finding.kind === "noStandInRaster"));
  // Without a raster nothing can be compared — no conflict made up.
  const noRaster = createTechnicalRasterProject({ name: "Bez rastru" }, "q");
  assert.equal(checkAbraOrderFairAffiliation({ project: noRaster, orderImport: orders("V238", ["9Z99", [["L03", "1,000"]]]), sourceFileName: "o.pdf" }).standsInRaster, undefined);
});

const realPdf = new URL("../_IMPORT/FORMULARE/3. Formulář objednávky přijaté ABF (2026_10_30 10-40).pdf", import.meta.url);
test("REAL order form PDF: one document series V238, issue dates read, no fair identifier -> unverifiable", { skip: !existsSync(realPdf) }, async () => {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await readFile(realPdf)), verbosity: 0 });
  const doc = await task.promise;
  const items: PdfTextItem[] = [];
  for (let page = 1; page <= doc.numPages; page += 1) {
    const content = await (await doc.getPage(page)).getTextContent();
    for (const item of content.items as { str: string; width: number; height: number; transform: number[] }[]) {
      if (item.str.trim()) items.push({ str: item.str, page, x: item.transform[4]!, y: item.transform[5]!, width: item.width, height: item.height || Math.abs(item.transform[3]!) });
    }
  }
  await task.destroy();
  const orderImport = buildAbraOrderTechnicalImport(parseAbraOrderFormPdf(items));
  assert.deepEqual(orderImport.documents.orderSeries, ["V238"]);
  assert.ok(orderImport.documents.issueDateRange);
  const check = checkAbraOrderFairAffiliation({ project: createTechnicalRasterProject({ name: "Test" }, "r"), orderImport, sourceFileName: "objednavky.pdf" });
  assert.equal(check.status, "unverifiable");
});
