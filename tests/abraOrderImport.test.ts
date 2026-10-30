import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAbraOrderFormPdf, parseCzechNumber } from "../domain/abraOrderForm.ts";
import { ABRA_TECHNICAL_CODE_MAP, buildAbraOrderTechnicalImport } from "../domain/abraOrderTechnicalImport.ts";
import { APPROVED_TECHNICAL_MARKER_ROWS } from "../domain/technicalMarkerApprovedTable.ts";
import {
  ABRA_ORDER_IMPORT_CATEGORY,
  createTechnicalRasterProject,
  effectiveServicePlacements,
  mergeTechnicalRasterImportWithDiff,
  placeTechnicalService,
  requiredPlacementCount,
  resolveTechnicalImportReplacement,
  withRasterStandLabels,
  type ParsedTechnicalReport,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
  type TechnicalService,
} from "../domain/technicalRaster.ts";
import { resolveServicePresentation } from "../domain/technicalRasterServicePresentation.ts";
import type { PdfTextItem } from "../domain/technicalReportTableParsing.ts";
import type { StoredAsset } from "../domain/assets.ts";

// =========================================================================================
// ABRA "3. Formulář objednávky přijaté ABF" — primary import of technical services by ABF code.
// Synthetic pages reproduce the measured layout of the real export (coordinates from the real PDF);
// company names here are invented. The real-file test at the end is skip-safe (_IMPORT/ is ignored).
// =========================================================================================

type ItemRow = readonly [code: string, name: string, quantity: string, unit: string, unitPrice?: string, total?: string] | readonly ["NOTE", string];

function cell(page: number, x: number, y: number, str: string): PdfTextItem {
  return { str, page, x, y, width: str.length * 4, height: 8 };
}

/** One page of an order, laid out like the real ABRA export. */
function orderPage(page: number, orderNumber: string, pageOfOrder: number, rows: readonly ItemRow[], options: Readonly<{ first?: boolean; stand?: string; company?: string; customer?: string; footer?: readonly string[] }> = {}): PdfTextItem[] {
  const items: PdfTextItem[] = [cell(page, 527, 802, "Strana"), cell(page, 249, 799, "Objednávka přijatá č."), cell(page, 426, 798, orderNumber), cell(page, 531, 788, "č."), cell(page, 541, 787, String(pageOfOrder))];
  let headerY = 742;
  if (options.first) {
    items.push(cell(page, 62, 748, "Dodavatel:"), cell(page, 252, 748, "Odběratel:"), cell(page, 365, 748, `Zákaznické číslo: ${options.customer ?? "TR0001"}`), cell(page, 62, 733, "ABF, a.s."));
    if (options.stand) items.push(cell(page, 481, 727, options.stand));
    items.push(cell(page, 62, 708, "199 00"), cell(page, 105, 708, "Praha 9"), cell(page, 289, 708, options.company ?? "Firma s.r.o."), cell(page, 289, 682, "Ulice 1"), cell(page, 289, 668, "110 00"));
    items.push(cell(page, 255, 578, "Datum vystavení dokladu:"), cell(page, 377, 578, "27.01.2026"));
    headerY = 538;
  }
  items.push(cell(page, 389, headerY + 6, "Cena za jedn."), cell(page, 460, headerY + 6, "Cena celkem"), cell(page, 532, headerY + 6, "Sazba"));
  items.push(cell(page, 65, headerY, "Předmět zdanitelného plnění"), cell(page, 311, headerY, "Množství / j."));
  items.push(cell(page, 381, headerY - 6, "v CZK bez DPH"), cell(page, 483, headerY - 6, "bez DPH"), cell(page, 542, headerY - 6, "DPH"));
  let y = headerY - 23;
  for (const row of rows) {
    if (row[0] === "NOTE") items.push(cell(page, 139, y, row[1]));
    else {
      const [code, name, quantity, unit, unitPrice = "0,000", total = "0,00"] = row;
      if (code) items.push(cell(page, 71, y, code));
      items.push(cell(page, code ? 139 : 71, y, name), cell(page, 328, y, quantity), cell(page, 357, y, unit), cell(page, 428, y, unitPrice), cell(page, 507, y, total), cell(page, 541, y, "21%"));
    }
    y -= 14.5;
  }
  for (const line of options.footer ?? ["Částky v CZK"]) { items.push(cell(page, 71, y - 10, line)); y -= 14; }
  items.push(cell(page, 261, 59, "Vystaveno v systému ABRAGen"), cell(page, 65, 45, "Telefon:"));
  return items;
}

function fixture(): PdfTextItem[] {
  return [
    // Stand + technical services (decimal quantity, note, repeated item, zero price, furniture).
    ...orderPage(1, "V1-1/2026", 1, [
      ["P1", "PLOCHA ŘADOVÁ", "24,000", "m2"],
      ["L03", "ELEKTRICKÁ ENERGIE - PŘÍKON D", "1,000", "ks", "6 600,000", "6 600,00"],
      ["NOTE", "rampy"],
      ["L03", "ELEKTRICKÁ ENERGIE - PŘÍKON D", "1,000", "ks"],
      ["W32", "BAZÉN - NAPUŠTĚNÍ (OBJEM VOD", "1,800", "m3"],
      ["M57", "ŽIDLE KOVOVÁ ČALOUNĚNÁ", "4,000", "ks"],
    ], { first: true, stand: "1A01", company: "Alfa s.r.o.", footer: ["Tento doklad má pokračování na stránce č. 2"] }),
    // ... continued on its 2nd page.
    ...orderPage(2, "V1-1/2026", 2, [["U01", "ÚKLID DENNÍ", "24,000", "m2/"], ["I10", "INTERNET - KABEL RJ45, 1. PŘIPO", "1,000", "ks"], ["I11", "INTERNET - KABEL RJ45, DALŠÍ PŘ", "1,000", "ks"]]),
    // Stand, no technical service -> ignored.
    ...orderPage(3, "V1-2/2026", 1, [["M01", "KOBEREC ŠEDÝ", "9,000", "m2"], ["R30", "PARKOVACÍ KARTA - Přenosná", "2,000", "ks"]], { first: true, stand: "1A02", company: "Beta a.s." }),
    // No stand, technical service -> review only.
    ...orderPage(4, "V1-3/2026", 1, [["L02", "ELEKTRICKÁ ENERGIE - PŘÍKON D", "2,000", "ks"]], { first: true, company: "Gama s.r.o." }),
    // No stand, no service (empty order) -> ignored.
    ...orderPage(5, "V1-4/2026", 1, [], { first: true, company: "Delta s.r.o." }),
    // Cancellation fee + technical service + unknown technical code + uncoded item; second order of stand 1A01.
    ...orderPage(6, "V1-5/2026", 1, [
      ["R99", "STORNOPOPLATEK", "1,000", "ks", "1 000,000", "1 000,00"],
      ["L09", "ELEKTRICKÁ ENERGIE - PŘÍKON D", "1,000", "ks"],
      ["L63", "BEZ ELEKTRICKÉ ENERGIE", "1,000", "ks"],
      ["", "Cleaning services", "1,000", "", "19 200,000", "19 200,00"],
    ], { first: true, stand: "1A01", company: "Alfa s.r.o.", footer: ["Dodací listy: DL-1/2026", "Částky v CZK"] }),
  ];
}

test("parseCzechNumber: Czech decimal comma and thousands spaces", () => {
  assert.equal(parseCzechNumber("1,800"), 1.8);
  assert.equal(parseCzechNumber("1 653,000"), 1653);
  assert.equal(parseCzechNumber("24,000"), 24);
  assert.equal(parseCzechNumber(""), undefined);
  assert.equal(parseCzechNumber("abc"), undefined);
});

test("PARSER: every order by its ABRA number, multi-page orders joined, stand/company/customer, every item with code, quantity, unit, prices and notes", () => {
  const parsed = parseAbraOrderFormPdf(fixture());
  assert.deepEqual(parsed.orders.map((order) => [order.orderNumber, order.standNumber, order.companyName, order.pages]), [
    ["V1-1/2026", "1A01", "Alfa s.r.o.", [1, 2]],
    ["V1-2/2026", "1A02", "Beta a.s.", [3]],
    ["V1-3/2026", undefined, "Gama s.r.o.", [4]],
    ["V1-4/2026", undefined, "Delta s.r.o.", [5]],
    ["V1-5/2026", "1A01", "Alfa s.r.o.", [6]],
  ]);
  const first = parsed.orders[0]!;
  assert.deepEqual(first.items.map((item) => [item.code, item.quantity, item.unit, item.notes]), [
    ["P1", 24, "m2", []], ["L03", 1, "ks", ["rampy"]], ["L03", 1, "ks", []], ["W32", 1.8, "m3", []], ["M57", 4, "ks", []], ["U01", 24, "m2/", []], ["I10", 1, "ks", []], ["I11", 1, "ks", []],
  ]);
  assert.equal(first.items[1]!.unitPrice, 6600);
  assert.equal(first.customerNumber, "TR0001");
  assert.equal(first.issueDate, "27.01.2026");
  const fifth = parsed.orders[4]!;
  assert.deepEqual(fifth.items.map((item) => item.code), ["R99", "L09", "L63", ""], "a free-text item without code is kept, not dropped");
  assert.equal(fifth.items[3]!.name, "Cleaning services");
  assert.deepEqual(fifth.documentReferences, ["DL-1/2026"]);
  assert.deepEqual(parsed.warnings, []);
});

test("RULES: stand × technical service — imported / service without stand listed / ignored; ABF code only; storno never deletes", () => {
  const result = buildAbraOrderTechnicalImport(parseAbraOrderFormPdf(fixture()));
  assert.deepEqual(result.counts, {
    orders: 5, pages: 6, items: 15, ordersWithTechnicalServices: 3, technicalServices: 8, importedTechnicalServices: 7,
    standsWithTechnicalServices: 1, ordersWithoutStandOrServices: 1, ordersWithStandWithoutServices: 1, emptyOrders: 1,
  });
  // No stand + service: shown with company, order, code, name and quantity — not in the raster.
  assert.deepEqual(result.servicesWithoutStand.map((line) => [line.companyName, line.orderNumber, line.code, line.name, line.quantityRaw]), [["Gama s.r.o.", "V1-3/2026", "L02", "ELEKTRICKÁ ENERGIE - PŘÍKON D", "2,000"]]);
  assert.ok(!result.report.rows.some((row) => row.services.some((service) => service.sourceOrderNumber === "V1-3/2026")));
  // Unknown code of a technical family: listed, never imported or guessed from its name.
  assert.deepEqual(result.unknownTechnicalCodes, [{ code: "L63", name: "BEZ ELEKTRICKÉ ENERGIE", itemCount: 1, orderNumbers: ["V1-5/2026"] }]);
  // Storno: listed, and the order's technical service is still imported.
  assert.deepEqual(result.reviewItems.map((item) => [item.kind, item.orderNumber, item.code]), [["cancellationFee", "V1-5/2026", "R99"], ["unknownTechnicalCode", "V1-5/2026", "L63"], ["uncodedItem", "V1-5/2026", ""]]);
  // One row per stand; both orders of 1A01; repeated L03 stays two services; furniture/parking never a service.
  assert.equal(result.report.category, ABRA_ORDER_IMPORT_CATEGORY);
  const [row] = result.report.rows;
  assert.equal(row!.standNumber, "1A01");
  assert.deepEqual(row!.services.map((service) => [service.abfCode, service.category, service.externalLabel, service.quantity, service.sourceOrderNumber]), [
    ["L03", "electricity", "Do 3kW 230V", 1, "V1-1/2026"],
    ["L03", "electricity", "Do 3kW 230V", 1, "V1-1/2026"],
    ["W32", "water", "Bazén - objem", 1.8, "V1-1/2026"],
    ["U01", "cleaning", "Denní úklid", 24, "V1-1/2026"],
    ["I10", "internet", "Internet", 1, "V1-1/2026"],
    ["I11", "internet", "Další přípojka", 1, "V1-1/2026"],
    ["L09", "electricity", "Do 9kW 400V", 1, "V1-5/2026"],
  ]);
  assert.deepEqual(row!.services[0]!.itemNotes, ["rampy"], "item notes are kept on the service");
  // Decimal quantity keeps its approved dynamic label.
  assert.equal(resolveServicePresentation({ category: "water", externalLabel: "Bazén - objem", quantity: 1.8 }).displayLabel, "1.8 m³");
});

test("CODE MAP: exactly the 31 approved ABF codes; the 3 approved rows without a code are never matched", () => {
  assert.equal(ABRA_TECHNICAL_CODE_MAP.size, 31);
  assert.deepEqual(APPROVED_TECHNICAL_MARKER_ROWS.filter((row) => !row.abfCode).map((row) => row.abraName), ["+ kW", "Odvoz odpadu", "Stěhování nábytku (příklad)"]);
  assert.deepEqual(ABRA_TECHNICAL_CODE_MAP.get("L51"), { abfCode: "L51", category: "electricity", externalLabel: "Rozvaděč 9-21kW" });
  assert.deepEqual(ABRA_TECHNICAL_CODE_MAP.get("U12"), { abfCode: "U12", category: "waste", externalLabel: "vana 3 m3" });
});

test("PLACEMENTS: a decimal per-unit quantity needs whole points, rounded up", () => {
  const service = { id: "s", category: "electricity", externalLabel: "Do 3kW 230V", quantity: 1.5, rawValue: "1,500", sourceImportId: "i", sourcePage: 1, status: "unresolved_product" } as TechnicalService;
  assert.equal(requiredPlacementCount(service), 2);
});

// =========================================================================================
// Merge: primary source, re-import, coexistence with the per-category reports
// =========================================================================================

function asset(id: string): StoredAsset {
  return { id, storageKey: `k/${id}.pdf`, originalFileName: `${id}.pdf`, mimeType: "application/pdf", size: 1, createdAt: "2026-01-01T00:00:00.000Z", category: "technical-raster-import" };
}

let importCounter = 0;
function confirm(project: TechnicalRasterProject, category: string, report: ParsedTechnicalReport) {
  importCounter += 1;
  const record: TechnicalRasterImport = { id: `imp-${importCounter}`, category, filename: `${category}-${importCounter}.pdf`, asset: asset(`a${importCounter}`), importedAt: "2026-10-30T00:00:00.000Z", parserVersion: "v1", parseStatus: "ok", standsFound: report.rows.length, servicesFound: 0, warnings: [] };
  return mergeTechnicalRasterImportWithDiff(project, record, report, () => ({ status: "unresolved_product" as const }), resolveTechnicalImportReplacement(project, category));
}

function newProject(): TechnicalRasterProject {
  return withRasterStandLabels(createTechnicalRasterProject({ name: "H1" }, "p"), ["1A01", "1A02"].map((stand, index) => ({ id: `l-${stand}`, page: 1, rawText: stand, normalizedStandNumber: stand, xNormalized: 0.2 + index * 0.3, yNormalized: 0.5, widthNormalized: 0.02, heightNormalized: 0.01 })));
}

function electricityReport(rows: readonly (readonly [stand: string, label: string, quantity: number])[]): ParsedTechnicalReport {
  return { category: "electricity", rows: rows.map(([standNumber, externalLabel, quantity]) => ({ standNumber, services: [{ category: "electricity", externalLabel, quantity, rawValue: String(quantity), sourcePage: 1 }], notes: [] })), warnings: [] };
}

function ordersReport(): ParsedTechnicalReport {
  return buildAbraOrderTechnicalImport(parseAbraOrderFormPdf(fixture())).report;
}

function services(project: TechnicalRasterProject, stand: string): readonly TechnicalService[] {
  return project.stands.find((candidate) => candidate.standNumber === stand)?.services ?? [];
}

function placeEvery(project: TechnicalRasterProject, stand: string): TechnicalRasterProject {
  let next = project;
  const standId = next.stands.find((candidate) => candidate.standNumber === stand)!.id;
  for (const service of services(next, stand)) {
    for (let index = effectiveServicePlacements(service).length; index < requiredPlacementCount(service); index += 1) {
      next = placeTechnicalService(next, standId, service.id, { page: 1, xNormalized: 0.1 + index * 0.01, yNormalized: 0.3 });
    }
  }
  return next;
}

test("PRIMARY SOURCE: the order import replaces the active electricity report and TAKES OVER its placements for the same services; nothing duplicated", () => {
  let project = confirm(newProject(), "electricity", electricityReport([["1A01", "Do 3kW 230V", 2], ["1A01", "Do 9kW 400V", 1]])).project;
  project = placeEvery(project, "1A01");
  const before = services(project, "1A01");
  const placementsByLabel = (list: readonly TechnicalService[]) => list.flatMap((service) => effectiveServicePlacements(service).map((placement) => `${service.externalLabel}@${placement.xNormalized}`)).sort();

  const replacement = resolveTechnicalImportReplacement(project, ABRA_ORDER_IMPORT_CATEGORY);
  assert.deepEqual(replacement?.supersedeImportIds, [project.imports[0]!.id]);
  const { project: after, diff } = confirm(project, ABRA_ORDER_IMPORT_CATEGORY, ordersReport());
  assert.ok(after.imports[0]!.supersededByImportId, "the report import is superseded (kept in history)");
  const now = services(after, "1A01");
  assert.equal(now.filter((service) => service.category === "electricity").length, 3, "2× L03 + L09 — the report's services are not kept next to them");
  // Report "Do 3kW" ×2 (2 points) -> two L03 order lines ×1: one point each; L09 keeps its point. No point is lost or moved.
  assert.deepEqual(placementsByLabel(now.filter((service) => service.category === "electricity")), placementsByLabel(before));
  assert.equal(diff!.changes.reduce((sum, change) => sum + change.removedPlacementCount, 0), 0, "no placement removed");
  assert.ok(diff!.changes.every((change) => change.kind !== "removed"), JSON.stringify(diff!.changes));
});

test("RE-IMPORT of the same order form: no duplicates, every service keeps its id and placement (ABF code + order number)", () => {
  let project = confirm(newProject(), ABRA_ORDER_IMPORT_CATEGORY, ordersReport()).project;
  project = placeEvery(project, "1A01");
  const snapshot = (value: TechnicalRasterProject) => services(value, "1A01").map((service) => [service.id, service.abfCode, service.sourceOrderNumber, service.placements]);
  const baseline = snapshot(project);
  for (let run = 0; run < 3; run += 1) {
    const { project: next, diff } = confirm(project, ABRA_ORDER_IMPORT_CATEGORY, ordersReport());
    assert.deepEqual(snapshot(next), baseline, `run ${run}`);
    assert.deepEqual([diff!.added, diff!.removed, diff!.unchanged], [0, 0, baseline.length]);
    assert.equal(next.imports.filter((existing) => !existing.supersededByImportId).length, 1, "exactly one active order import");
    project = next;
  }
});

test("ABF CODE FIRST: I10 (Internet) and I11 (Další přípojka) share a marker identity but stay distinct services by code", () => {
  let project = confirm(newProject(), ABRA_ORDER_IMPORT_CATEGORY, ordersReport()).project;
  project = placeEvery(project, "1A01");
  const i10 = services(project, "1A01").find((service) => service.abfCode === "I10")!;
  const i11 = services(project, "1A01").find((service) => service.abfCode === "I11")!;
  // New export lists I11 before I10: each keeps its own placement.
  const swapped = ordersReport();
  const row = swapped.rows[0]!;
  const reordered = { ...swapped, rows: [{ ...row, services: [...row.services].sort((a, b) => (a.abfCode === "I11" ? -1 : b.abfCode === "I11" ? 1 : 0)) }] };
  const after = confirm(project, ABRA_ORDER_IMPORT_CATEGORY, reordered).project;
  assert.deepEqual(services(after, "1A01").find((service) => service.abfCode === "I10")!.placements, i10.placements);
  assert.deepEqual(services(after, "1A01").find((service) => service.abfCode === "I11")!.placements, i11.placements);
});

test("SEPARATE REPORTS STAY: a later electricity report replaces only the electricity services of the active order import; other categories untouched", () => {
  let project = confirm(newProject(), ABRA_ORDER_IMPORT_CATEGORY, ordersReport()).project;
  project = placeEvery(project, "1A01");
  const water = services(project, "1A01").find((service) => service.category === "water")!;
  const orderImportId = project.imports[0]!.id;
  const { project: after } = confirm(project, "electricity", electricityReport([["1A01", "Do 9kW 400V", 1]]));
  assert.equal(after.imports.find((existing) => existing.id === orderImportId)!.supersededByImportId, undefined, "the order import stays active for the other categories");
  assert.deepEqual(services(after, "1A01").filter((service) => service.category === "electricity").map((service) => [service.externalLabel, service.abfCode, effectiveServicePlacements(service).length]), [["Do 9kW 400V", undefined, 1]], "the L09 placement carried over to the report's 9 kW");
  assert.deepEqual(services(after, "1A01").find((service) => service.category === "water"), water);
});

test("UI wiring: order form is PDF-only (the broken Excel export is refused with an explanation); the preview shows the control overview", async () => {
  const panel = await readFile(new URL("../components/workflow/technicalRasters/TechnicalServiceImportPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /if \(category === ABRA_ORDER_IMPORT_CATEGORY && format === "xlsx"\) \{\s*setError\(ABRA_ORDER_EXCEL_REFUSAL\);/u);
  const editor = await readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterEditorPage.tsx", import.meta.url), "utf8");
  assert.match(editor, /\{pendingImport\.orderImport && <AbraOrderImportCheckSummary orderImport=\{pendingImport\.orderImport\} \/>\}/u);
  assert.match(editor, /const replacement = resolveTechnicalImportReplacement\(current, category\);/u);
});

// Real export — skip-safe (git-ignored _IMPORT/).
const realPdf = new URL("../_IMPORT/FORMULARE/3. Formulář objednávky přijaté ABF (2026_10_30 10-40).pdf", import.meta.url);
test("REAL order form PDF: 127 orders, 942 items, 188 technical services on 62 stands, L63 listed as unknown", { skip: !existsSync(realPdf) }, async () => {
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
  const parsed = parseAbraOrderFormPdf(items);
  const result = buildAbraOrderTechnicalImport(parsed);
  assert.equal(parsed.orders.length, 127);
  assert.deepEqual(parsed.orders.map((order) => order.orderNumber), Array.from({ length: 127 }, (_, index) => `V238-${index + 1}/2026`));
  assert.equal(result.counts.items, 942);
  assert.equal(result.counts.technicalServices, 188);
  assert.equal(result.counts.standsWithTechnicalServices, 62);
  assert.deepEqual(result.unknownTechnicalCodes.map((code) => [code.code, code.itemCount]), [["L63", 6]]);
  assert.equal(result.reviewItems.filter((item) => item.kind === "cancellationFee").length, 4);
  const w32 = result.importedLines.find((line) => line.code === "W32")!;
  assert.deepEqual([w32.standNumber, w32.quantity, w32.unit], ["3A01", 1.8, "m3"]);
});
