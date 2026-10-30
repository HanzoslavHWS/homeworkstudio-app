import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { parseAbraOrderFormPdf, parseCzechNumber } from "../domain/abraOrderForm.ts";
import { ABRA_TECHNICAL_CODE_MAP, buildAbraOrderTechnicalImport, type AbraOrderTechnicalImport } from "../domain/abraOrderTechnicalImport.ts";
import { ONLY_EXISTING_MESSAGE, applyAbraOrderImport, reconcileAbraOrdersWithProject, type AbraOrderReconciliation } from "../domain/abraOrderReconciliation.ts";
import { APPROVED_TECHNICAL_MARKER_ROWS } from "../domain/technicalMarkerApprovedTable.ts";
import {
  ABRA_ORDER_IMPORT_CATEGORY,
  createTechnicalRasterProject,
  effectiveServicePlacements,
  effectiveServiceSources,
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
// Fixtures for the merge / reconciliation tests below
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

function ordersFixture(): AbraOrderTechnicalImport {
  return buildAbraOrderTechnicalImport(parseAbraOrderFormPdf(fixture()));
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

test("RULES: stand × technical service — imported / service without stand listed / ignored; ABF code only; storno never deletes; L63 is the 'BEZ elektriky' X", () => {
  const result = buildAbraOrderTechnicalImport(parseAbraOrderFormPdf(fixture()));
  assert.deepEqual(result.counts, {
    orders: 5, pages: 6, items: 15, ordersWithTechnicalServices: 3, technicalServices: 8, importedTechnicalServices: 7,
    standsWithTechnicalServices: 1, ordersWithoutStandOrServices: 1, ordersWithStandWithoutServices: 1, emptyOrders: 1,
  });
  // No stand + service: shown with company, order, code, name and quantity — not in the raster.
  assert.deepEqual(result.servicesWithoutStand.map((line) => [line.companyName, line.orderNumber, line.code, line.name, line.quantityRaw]), [["Gama s.r.o.", "V1-3/2026", "L02", "ELEKTRICKÁ ENERGIE - PŘÍKON D", "2,000"]]);
  assert.ok(!result.report.rows.some((row) => row.services.some((service) => service.sourceOrderNumber === "V1-3/2026")));
  // L63 is not an unknown code any more: it is the stand's "BEZ elektriky" X (and a conflict next to L09).
  assert.deepEqual(result.unknownTechnicalCodes, []);
  assert.deepEqual(result.noElectricityLines.map((line) => [line.orderNumber, line.standNumber, line.companyName]), [["V1-5/2026", "1A01", "Alfa s.r.o."]]);
  // Storno: listed, and the order's technical service is still imported. An uncoded item is shown with everything needed to find it.
  assert.deepEqual(result.reviewItems.map((item) => [item.kind, item.orderNumber, item.code]).sort(), [["cancellationFee", "V1-5/2026", "R99"], ["noElectricityWithElectricity", "V1-5/2026", "L63"], ["uncodedItem", "V1-5/2026", ""]]);
  const uncoded = result.reviewItems.find((item) => item.kind === "uncodedItem")!;
  assert.deepEqual([uncoded.orderNumber, uncoded.companyName, uncoded.standNumber, uncoded.name, uncoded.quantityRaw], ["V1-5/2026", "Alfa s.r.o.", "1A01", "Cleaning services", "1,000"]);
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

test("UNKNOWN / UNCODED: an unknown technical code is never converted — listed with order, company, stand, name, quantity and the original note", () => {
  const result = buildAbraOrderTechnicalImport(parseAbraOrderFormPdf(orderPage(1, "V9-1/2026", 1, [["L77", "ELEKTRICKÁ ENERGIE - ZVLÁŠTNÍ", "2,000", "ks"], ["NOTE", "dle dohody"]], { first: true, stand: "2B05", company: "Omega s.r.o." })));
  assert.deepEqual(result.report.rows, [], "nothing guessed from the name");
  assert.deepEqual(result.unknownTechnicalCodes.map((code) => [code.code, code.itemCount, code.orderNumbers]), [["L77", 1, ["V9-1/2026"]]]);
  const review = result.reviewItems.find((item) => item.kind === "unknownTechnicalCode")!;
  assert.deepEqual([review.orderNumber, review.companyName, review.standNumber, review.name, review.quantityRaw, review.notes], ["V9-1/2026", "Omega s.r.o.", "2B05", "ELEKTRICKÁ ENERGIE - ZVLÁŠTNÍ", "2,000", ["dle dohody"]]);
});

// =========================================================================================
// Multi-page orders — joined by order number + the order's own page number; never guessed.
// =========================================================================================

const continues = (next: number) => ["Tento doklad má pokračování na stránce č. " + next];

/** An order spread over `itemsPerPage.length` PDF pages starting at PDF page `startPage`. */
function multiPageOrder(startPage: number, orderNumber: string, itemsPerPage: readonly (readonly ItemRow[])[], stand = "1A01"): PdfTextItem[] {
  return itemsPerPage.flatMap((rows, index) => orderPage(startPage + index, orderNumber, index + 1, rows, {
    first: index === 0, stand, company: "Alfa s.r.o.",
    footer: index < itemsPerPage.length - 1 ? continues(index + 2) : ["Částky v CZK"],
  }));
}

const electricity = (code: string): ItemRow => [code, "ELEKTRICKÁ ENERGIE - PŘÍKON D", "1,000", "ks"];

test("MULTI-PAGE: orders with 1, 2, 3 and 4 pages keep every item, in order, each on its own page; nothing ambiguous", () => {
  const parsed = parseAbraOrderFormPdf([
    ...multiPageOrder(1, "V2-1/2026", [[electricity("L02")]], "1A01"),
    ...multiPageOrder(2, "V2-2/2026", [[electricity("L02"), electricity("L03")], [electricity("L05")]], "1A02"),
    ...multiPageOrder(4, "V2-3/2026", [[electricity("L02")], [electricity("L03"), electricity("L05")], [electricity("L06")]], "1A03"),
    ...multiPageOrder(7, "V2-4/2026", [[electricity("L02")], [electricity("L03")], [electricity("L05")], [electricity("L09"), ["NOTE", "u zadní stěny"]]], "1A04"),
  ]);
  assert.deepEqual(parsed.ambiguousPages, []);
  assert.deepEqual(parsed.warnings, []);
  assert.deepEqual(parsed.orders.map((order) => [order.orderNumber, order.standNumber, order.pages, order.items.map((item) => `${item.code}@${item.page}`)]), [
    ["V2-1/2026", "1A01", [1], ["L02@1"]],
    ["V2-2/2026", "1A02", [2, 3], ["L02@2", "L03@2", "L05@3"]],
    ["V2-3/2026", "1A03", [4, 5, 6], ["L02@4", "L03@5", "L05@5", "L06@6"]],
    ["V2-4/2026", "1A04", [7, 8, 9, 10], ["L02@7", "L03@8", "L05@9", "L09@10"]],
  ]);
  assert.deepEqual(parsed.orders[3]!.items.map((item) => item.lineNumber), [1, 2, 3, 4]);
  assert.deepEqual(parsed.orders[3]!.items[3]!.notes, ["u zadní stěny"]);
  // The continuation pages' items reach the raster on the stand of the order's first page.
  const result = buildAbraOrderTechnicalImport(parsed);
  assert.deepEqual(result.report.rows.map((row) => [row.standNumber, row.services.map((service) => service.abfCode)]), [
    ["1A01", ["L02"]], ["1A02", ["L02", "L03", "L05"]], ["1A03", ["L02", "L03", "L05", "L06"]], ["1A04", ["L02", "L03", "L05", "L09"]],
  ]);
});

test("MULTI-PAGE: a single item alone on the last page is never lost — also when it is the only technical service; notes at the top of a page continue the previous item", () => {
  const parsed = parseAbraOrderFormPdf([
    ...multiPageOrder(1, "V3-1/2026", [[["P1", "PLOCHA ŘADOVÁ", "24,000", "m2"], ["M57", "ŽIDLE KOVOVÁ ČALOUNĚNÁ", "4,000", "ks"]], [electricity("L09")]], "1A01"),
    ...multiPageOrder(3, "V3-2/2026", [[electricity("L03")], [["NOTE", "pokračování poznámky"], ["W21", "VODA, ODPAD", "1,000", "ks"]]], "1A02"),
  ]);
  assert.deepEqual(parsed.ambiguousPages, []);
  assert.deepEqual(parsed.orders.map((order) => order.items.map((item) => item.code)), [["P1", "M57", "L09"], ["L03", "W21"]]);
  assert.deepEqual(parsed.orders[1]!.items[0]!.notes, ["pokračování poznámky"], "a note at the top of page 2 belongs to the last item of page 1");
  const result = buildAbraOrderTechnicalImport(parsed);
  assert.deepEqual(result.importedLines.map((line) => [line.standNumber, line.code, line.page]), [["1A01", "L09", 2], ["1A02", "L03", 3], ["1A02", "W21", 4]]);
  assert.equal(result.counts.ordersWithTechnicalServices, 2);
});

test("AMBIGUOUS PAGES: a gap, a repeated first page, a missing page number or a continuation of another order is NOT guessed — listed with its items and a warning", () => {
  const withoutPageNumber = (items: PdfTextItem[]) => items.filter((item) => !(item.x === 541 && item.y === 787));
  const parsed = parseAbraOrderFormPdf([
    // Order 1: pages 1 and 3 of the order — page 2 is missing.
    ...orderPage(1, "V4-1/2026", 1, [electricity("L02")], { first: true, stand: "1A01", footer: continues(2) }),
    ...orderPage(2, "V4-1/2026", 3, [electricity("L03")]),
    // Order 2: its first page twice.
    ...orderPage(3, "V4-2/2026", 1, [electricity("L05")], { first: true, stand: "1A02" }),
    ...orderPage(4, "V4-2/2026", 1, [electricity("L06")], { first: true, stand: "1A02" }),
    // A continuation page of order 3 right after order 2.
    ...orderPage(5, "V4-3/2026", 2, [electricity("L09")]),
    // A page without the order's page number.
    ...withoutPageNumber(orderPage(6, "V4-4/2026", 1, [electricity("L15")], { first: true, stand: "1A04" })),
  ]);
  assert.deepEqual(parsed.orders.map((order) => [order.orderNumber, order.pages, order.items.map((item) => item.code)]), [
    ["V4-1/2026", [1], ["L02"]],
    ["V4-2/2026", [3], ["L05"]],
  ]);
  assert.deepEqual(parsed.ambiguousPages.map((page) => [page.page, page.orderNumber, page.pageOfOrder, page.itemCodes]), [
    [2, "V4-1/2026", 3, ["L03"]],
    [4, "V4-2/2026", 1, ["L06"]],
    [5, "V4-3/2026", 2, ["L09"]],
    [6, "V4-4/2026", undefined, ["L15"]],
  ]);
  for (const page of parsed.ambiguousPages) assert.ok(parsed.warnings.some((warning) => warning.page === page.page && /nejde jednoznačně přiřadit/u.test(warning.message)), `page ${page.page} warned`);
  assert.ok(parsed.warnings.some((warning) => warning.message === "Objednávce V4-1/2026 chybí pokračovací strana č. 2."));
  // The import overview carries them, so the control screen can list them.
  assert.equal(buildAbraOrderTechnicalImport(parsed).ambiguousPages.length, 4);
});

// =========================================================================================
// Non-destructive reconciliation with the per-category reports already in the raster
// =========================================================================================

function orderRecord(): TechnicalRasterImport {
  importCounter += 1;
  return { id: `ord-${importCounter}`, category: ABRA_ORDER_IMPORT_CATEGORY, filename: `objednavky-${importCounter}.pdf`, asset: asset(`o${importCounter}`), importedAt: "2026-10-30T00:00:00.000Z", parserVersion: "abra-orders-pdf-v1", parseStatus: "ok", standsFound: 0, servicesFound: 0, warnings: [] };
}

/** One-page orders, one per stand: `[stand, rows]`. */
function orders(...perStand: readonly (readonly [stand: string, rows: readonly ItemRow[]])[]): AbraOrderTechnicalImport {
  return buildAbraOrderTechnicalImport(parseAbraOrderFormPdf(perStand.flatMap(([stand, rows], index) => orderPage(index + 1, `V5-${index + 1}/2026`, 1, rows, { first: true, stand, company: `Firma ${index + 1}` }))));
}

function applyOrders(project: TechnicalRasterProject, orderImport: AbraOrderTechnicalImport, accept: "default" | "none" | "all" = "default") {
  const reconciliation = reconcileAbraOrdersWithProject(project, orderImport);
  const all = [...reconciliation.services, ...reconciliation.noElectricity].map((item) => item.id);
  const accepted = accept === "default" ? reconciliation.defaultAcceptedIds : new Set(accept === "all" ? all : []);
  return applyAbraOrderImport(project, orderRecord(), orderImport, accepted);
}

const kinds = (reconciliation: AbraOrderReconciliation, stand = "1A01") => reconciliation.services.filter((item) => item.standNumber === stand).map((item) => [item.externalLabel, item.kind, item.existingQuantity, item.orderQuantity]);
const placementsOf = (project: TechnicalRasterProject, stand: string) => Object.fromEntries(services(project, stand).map((service) => [service.externalLabel, effectiveServicePlacements(service)]));

test("RECONCILE (the 1A01 example): report 2 kW + 5 kW + Vrchní přívod, orders 2 kW + 9 kW -> 2 kW paired, 9 kW offered, 5 kW and Vrchní přívod kept with a warning", () => {
  let project = confirm(newProject(), "electricity", electricityReport([["1A01", "Do 2kW 230V", 1], ["1A01", "Do 5kW 230V", 1], ["1A01", "Vrchní přívod", 1]])).project;
  project = placeEvery(project, "1A01");
  const placed = placementsOf(project, "1A01");
  const ordered = orders(["1A01", [electricity("L02"), electricity("L09")]]);

  const reconciliation = reconcileAbraOrdersWithProject(project, ordered);
  assert.deepEqual(kinds(reconciliation).sort(), [
    ["Do 2kW 230V", "matched", 1, 1],
    ["Do 5kW 230V", "onlyExisting", 1, 0],
    ["Do 9kW 400V", "new", 0, 1],
    ["Vrchní přívod", "onlyExisting", 1, 0],
  ]);
  assert.equal(ONLY_EXISTING_MESSAGE, "Služba je v předchozím technickém výjezdu, ale v nových objednávkách chybí.");
  const matched = reconciliation.services.find((item) => item.kind === "matched")!;
  assert.match(matched.existing[0]!.sourceLabels[0]!, /^Výjezd Elektrická energie \(electricity-\d+\.pdf\) 1×$/u, "each side says where it comes from");
  assert.equal(matched.orderLines[0]!.orderNumber, "V5-1/2026");
  assert.deepEqual([...reconciliation.defaultAcceptedIds], [reconciliation.services.find((item) => item.kind === "new")!.id], "only the new service is pre-selected");

  // Not confirmed -> nothing added, nothing removed.
  const declined = applyOrders(project, ordered, "none").project;
  assert.deepEqual(services(declined, "1A01").map((service) => service.externalLabel), ["Do 2kW 230V", "Do 5kW 230V", "Vrchní přívod"]);

  // Confirmed -> 9 kW added; 2 kW is ONE service with both sources and its point; 5 kW + Vrchní přívod untouched.
  const { project: after, diff } = applyOrders(project, ordered);
  assert.deepEqual(services(after, "1A01").map((service) => service.externalLabel), ["Do 2kW 230V", "Do 5kW 230V", "Vrchní přívod", "Do 9kW 400V"]);
  assert.deepEqual([diff.added, diff.removed, diff.unchanged], [1, 0, 1]);
  const twoKw = services(after, "1A01")[0]!;
  assert.deepEqual(effectiveServiceSources(twoKw).map((source) => [after.imports.find((record) => record.id === source.importId)!.category, source.quantity, source.abfCode]), [["electricity", 1, undefined], [ABRA_ORDER_IMPORT_CATEGORY, 1, "L02"]]);
  const { "Do 9kW 400V": newPoints, ...kept } = placementsOf(after, "1A01");
  assert.deepEqual(kept, placed, "no point moved or lost");
  assert.deepEqual(newPoints, [], "the new service waits to be placed");
  const nineKw = services(after, "1A01")[3]!;
  assert.deepEqual([nineKw.abfCode, nineKw.sourceOrderNumber], ["L09", "V5-1/2026"]);
  assert.deepEqual(after.imports.at(-1)!.orderLines!.map((line) => line.abfCode), ["L02", "L09"], "the orders keep their own evidence");
});

test("RECONCILE: a different quantity shows both values and the difference; the raster changes only when confirmed", () => {
  let project = confirm(newProject(), "electricity", electricityReport([["1A01", "Do 3kW 230V", 2]])).project;
  project = placeEvery(project, "1A01");
  const ordered = orders(["1A01", [electricity("L03")]]);
  const [item] = reconcileAbraOrdersWithProject(project, ordered).services;
  assert.deepEqual([item!.kind, item!.existingQuantity, item!.orderQuantity, item!.placementsDroppedIfApplied], ["quantityDiff", 2, 1, 1]);
  assert.ok(!reconcileAbraOrdersWithProject(project, ordered).defaultAcceptedIds.has(item!.id), "never pre-selected");

  const untouched = applyOrders(project, ordered).project;
  assert.deepEqual(services(untouched, "1A01").map((service) => [service.quantity, effectiveServicePlacements(service).length]), [[2, 2]]);
  const applied = applyOrders(project, ordered, "all");
  assert.deepEqual(services(applied.project, "1A01").map((service) => [service.quantity, effectiveServicePlacements(service).length]), [[1, 1]]);
  assert.deepEqual(applied.diff.changes.map((change) => [change.kind, change.previousQuantity, change.quantity, change.removedPlacementCount]), [["quantityDecreased", 2, 1, 1]]);
});

test("RE-IMPORT of the same orders: everything matched, no duplicates, ids, placements and notes kept; the previous order import is history", () => {
  let project = applyOrders(newProject(), ordersFixture()).project;
  project = placeEvery(project, "1A01");
  const snapshot = (value: TechnicalRasterProject) => services(value, "1A01").map((service) => [service.id, service.abfCode, service.sourceOrderNumber, service.itemNotes, service.placements]);
  const baseline = snapshot(project);
  assert.equal(baseline.length, 7);
  for (let run = 0; run < 3; run += 1) {
    const reconciliation = reconcileAbraOrdersWithProject(project, ordersFixture());
    assert.deepEqual([reconciliation.counts.new, reconciliation.counts.onlyExisting, reconciliation.counts.quantityDiff, reconciliation.counts.noElectricityNew], [0, 0, 0, 0], `run ${run}`);
    const { project: next, diff } = applyOrders(project, ordersFixture());
    assert.deepEqual(snapshot(next), baseline, `run ${run}`);
    assert.deepEqual([diff.added, diff.removed], [0, 0]);
    assert.equal(next.imports.filter((record) => record.category === ABRA_ORDER_IMPORT_CATEGORY && !record.supersededByImportId).length, 1, "exactly one active order import");
    // Evidence of the superseded order import is replaced, not stacked.
    for (const service of services(next, "1A01")) assert.ok(effectiveServiceSources(service).every((source) => source.importId === next.imports.at(-1)!.id), JSON.stringify(service.sources));
    project = next;
  }
});

test("RE-IMPORT: a service missing from the NEW version of the orders stays (with its point) and is listed as only in the earlier source", () => {
  let project = applyOrders(newProject(), orders(["1A01", [electricity("L03"), ["W21", "VODA, ODPAD", "1,000", "ks"]]])).project;
  project = placeEvery(project, "1A01");
  const before = placementsOf(project, "1A01");
  const newer = orders(["1A01", [electricity("L03")]]);
  const reconciliation = reconcileAbraOrdersWithProject(project, newer);
  assert.deepEqual(kinds(reconciliation), [["Do 3kW 230V", "matched", 1, 1], ["Voda, odpad", "onlyExisting", 1, 0]]);
  assert.match(reconciliation.services[1]!.existing[0]!.sourceLabels[0]!, /^Objednávky ABRA V5-1\/2026 \(objednavky-\d+\.pdf\) 1×$/u);
  const after = applyOrders(project, newer, "all").project;
  assert.deepEqual(placementsOf(after, "1A01"), before);
  assert.equal(reconcileAbraOrdersWithProject(after, newer).services.find((item) => item.externalLabel === "Voda, odpad")!.existing[0]!.sourceLabels[0]!.startsWith("Objednávky ABRA — předchozí import"), true);
});

test("ABF CODE FIRST: I10 (Internet) and I11 (Další přípojka) stay two services with their own points on re-import", () => {
  let project = applyOrders(newProject(), ordersFixture()).project;
  project = placeEvery(project, "1A01");
  const before = placementsOf(project, "1A01");
  const after = applyOrders(project, ordersFixture()).project;
  assert.deepEqual(placementsOf(after, "1A01"), before);
  assert.notDeepEqual(before["Internet"], before["Další přípojka"]);
});

test("SEPARATE REPORT AFTER THE ORDERS: it confirms the order services (no duplicate point), a quantity difference is a warning, and its re-import never removes what the orders hold", () => {
  let project = applyOrders(newProject(), orders(["1A01", [electricity("L09"), ["W21", "VODA, ODPAD", "1,000", "ks"]]])).project;
  project = placeEvery(project, "1A01");
  const before = placementsOf(project, "1A01");

  const first = confirm(project, "electricity", electricityReport([["1A01", "Do 9kW 400V", 2], ["1A01", "Do 5kW 230V", 1]])).project;
  assert.deepEqual(services(first, "1A01").map((service) => [service.externalLabel, service.quantity]), [["Do 9kW 400V", 1], ["Voda, odpad", 1], ["Do 5kW 230V", 1]], "9 kW not duplicated, quantity unchanged");
  const nineKw = services(first, "1A01")[0]!;
  assert.deepEqual(effectiveServiceSources(nineKw).map((source) => first.imports.find((record) => record.id === source.importId)!.category), [ABRA_ORDER_IMPORT_CATEGORY, "electricity"]);
  assert.ok(first.imports.at(-1)!.warnings.some((warning) => /1A01: Do 9kW 400V — výjezd uvádí 2, objednávky 1/u.test(warning.message)));
  assert.deepEqual(placementsOf(first, "1A01")["Do 9kW 400V"], before["Do 9kW 400V"]);

  // A new report version WITHOUT the 9 kW: the order service stays, only the old report's evidence goes.
  const second = confirm(first, "electricity", electricityReport([["1A01", "Do 5kW 230V", 1]])).project;
  assert.deepEqual(services(second, "1A01").map((service) => service.externalLabel), ["Do 9kW 400V", "Voda, odpad", "Do 5kW 230V"]);
  assert.deepEqual(effectiveServiceSources(services(second, "1A01")[0]!).map((source) => second.imports.find((record) => record.id === source.importId)!.category), [ABRA_ORDER_IMPORT_CATEGORY]);
  assert.deepEqual(placementsOf(second, "1A01")["Do 9kW 400V"], before["Do 9kW 400V"]);
});

test("REPORT SERVICE CONFIRMED BY THE ORDERS survives the report's own re-import without it", () => {
  let project = confirm(newProject(), "electricity", electricityReport([["1A01", "Do 2kW 230V", 1], ["1A01", "Do 5kW 230V", 1]])).project;
  project = placeEvery(project, "1A01");
  project = applyOrders(project, orders(["1A01", [electricity("L02")]])).project;
  const twoKw = services(project, "1A01")[0]!;
  const after = confirm(project, "electricity", electricityReport([["1A01", "Do 5kW 230V", 1]])).project;
  const kept = services(after, "1A01").find((service) => service.id === twoKw.id);
  assert.ok(kept, "the orders still contain it");
  assert.deepEqual(kept.placements, twoKw.placements);
  assert.equal(services(after, "1A01").filter((service) => service.externalLabel === "Do 2kW 230V").length, 1);
});

test("L63 'BEZ ELEKTRICKÉ ENERGIE' -> red X 'BEZ elektriky': offered when new, matched on re-import, conflict next to electricity, kept with a warning when missing; never cleared by a report", () => {
  const l63: ItemRow = ["L63", "BEZ ELEKTRICKÉ ENERGIE", "1,000", "ks"];
  const project = newProject();
  // Only in the orders -> offered (pre-selected), set with the orders as its source.
  const ordered = orders(["1A02", [l63]], ["1A01", [l63, electricity("L03")]]);
  const reconciliation = reconcileAbraOrdersWithProject(project, ordered);
  assert.deepEqual(reconciliation.noElectricity.map((item) => [item.kind, item.standNumber]).sort(), [["conflict", "1A01"], ["new", "1A01"], ["new", "1A02"]]);
  assert.match(reconciliation.noElectricity.find((item) => item.kind === "conflict")!.message, /^Rozpor: L63 BEZ ELEKTRICKÉ ENERGIE, ale stánek má elektrickou přípojku \(L03 v objednávce V5-2\/2026\)\.$/u);
  assert.ok(reconciliation.defaultAcceptedIds.has("l63-new:1A02"));
  const declined = applyAbraOrderImport(project, orderRecord(), ordered, new Set()).project;
  assert.equal(declined.stands.find((stand) => stand.standNumber === "1A02")?.hasNoElectricityAssignment ?? false, false, "nothing set without confirmation");
  let after = applyOrders(project, ordered).project;
  const stand = after.stands.find((candidate) => candidate.standNumber === "1A02")!;
  assert.deepEqual([stand.hasNoElectricityAssignment, stand.noElectricitySource], [true, "abra-orders"]);
  // Re-import -> matched, nothing new.
  assert.deepEqual(reconcileAbraOrdersWithProject(after, ordered).noElectricity.filter((item) => item.standNumber === "1A02").map((item) => item.kind), ["matched"]);
  // A newer order version without L63 -> the X stays, listed.
  const without = orders(["1A02", [["W21", "VODA, ODPAD", "1,000", "ks"]]]);
  assert.deepEqual(reconcileAbraOrdersWithProject(after, without).noElectricity.filter((item) => item.standNumber === "1A02").map((item) => [item.kind, item.existingSource]), [["onlyExisting", "abra-orders"]]);
  after = applyOrders(after, without, "all").project;
  assert.equal(after.stands.find((candidate) => candidate.standNumber === "1A02")!.hasNoElectricityAssignment, true);
  // An electricity report that does not mention the stand never clears an X the orders or the user set.
  after = { ...after, stands: after.stands.map((candidate) => (candidate.standNumber === "1A01" ? { ...candidate, hasNoElectricityAssignment: true, noElectricitySource: "manual" as const } : candidate)) };
  const reported = confirm(after, "electricity", { category: "electricity", rows: [{ standNumber: "1A02", services: [], notes: [] }, { standNumber: "1A01", services: [], notes: [] }], warnings: [] }).project;
  assert.deepEqual(reported.stands.filter((candidate) => ["1A01", "1A02"].includes(candidate.standNumber)).map((candidate) => [candidate.standNumber, candidate.hasNoElectricityAssignment, candidate.noElectricitySource]).sort(), [["1A01", true, "manual"], ["1A02", true, "abra-orders"]]);
});

test("L63 only in the earlier electricity report -> kept, listed with its source", () => {
  const reported = confirm(newProject(), "electricity", { category: "electricity", rows: [{ standNumber: "1A02", services: [], notes: [], explicitNoServiceAssignment: true }], warnings: [] }).project;
  const reconciliation = reconcileAbraOrdersWithProject(reported, orders(["1A01", [electricity("L03")]]));
  assert.deepEqual(reconciliation.noElectricity.map((item) => [item.kind, item.standNumber, item.existingSource]), [["onlyExisting", "1A02", "report"]]);
  const after = applyOrders(reported, orders(["1A01", [electricity("L03")]]), "all").project;
  assert.equal(after.stands.find((stand) => stand.standNumber === "1A02")!.hasNoElectricityAssignment, true);
});

test("UI wiring: order form is PDF-only (the broken Excel export is refused with an explanation); the preview shows the reconciliation with per-change checkboxes", async () => {
  const panel = await readFile(new URL("../components/workflow/technicalRasters/TechnicalServiceImportPanel.tsx", import.meta.url), "utf8");
  assert.match(panel, /if \(category === ABRA_ORDER_IMPORT_CATEGORY && format === "xlsx"\) \{\s*setError\(ABRA_ORDER_EXCEL_REFUSAL\);/u);
  const editor = await readFile(new URL("../components/workflow/technicalRasters/TechnicalRasterEditorPage.tsx", import.meta.url), "utf8");
  assert.match(editor, /<AbraOrderImportCheckSummary\s+orderImport=\{pendingImport\.orderImport\}\s+reconciliation=\{/u);
  assert.match(editor, /applyAbraOrderImport\(/u, "confirming the orders goes through the non-destructive apply");
  assert.match(editor, /Potvrdit vybrané změny/u);
  const summary = await readFile(new URL("../components/workflow/technicalRasters/AbraOrderImportCheckSummary.tsx", import.meta.url), "utf8");
  for (const label of ["Objednávek", "Rozpoznaných služeb", "Stánků se službami", "Nové k doplnění", "Shodné", "Jen v předchozích výjezdech", "Rozdílná množství", "Neznámé / bez kódu", "Služby bez stánku", "Nejednoznačné strany PDF"]) {
    assert.ok(summary.includes(label), label);
  }
  assert.match(summary, /ONLY_EXISTING_MESSAGE/u);
});

// Real export — skip-safe (git-ignored _IMPORT/).
const realPdf = new URL("../_IMPORT/FORMULARE/3. Formulář objednávky přijaté ABF (2026_10_30 10-40).pdf", import.meta.url);
const realElectricity = new URL("../_IMPORT/TEST_TECHNICKYCH_VYJEZDU/FOR_BEAUTY_2026/PDF/Přehled - elektrická energie (2026_10_29 09-33).pdf", import.meta.url);

async function realPdfItems(url: URL): Promise<PdfTextItem[]> {
  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await readFile(url)), verbosity: 0 });
  const doc = await task.promise;
  const items: PdfTextItem[] = [];
  for (let page = 1; page <= doc.numPages; page += 1) {
    const content = await (await doc.getPage(page)).getTextContent();
    for (const item of content.items as { str: string; width: number; height: number; transform: number[] }[]) {
      if (item.str.trim()) items.push({ str: item.str, page, x: item.transform[4]!, y: item.transform[5]!, width: item.width, height: item.height || Math.abs(item.transform[3]!) });
    }
  }
  await task.destroy();
  return items;
}

test("REAL order form PDF: 127 orders on 151 pages, every page assigned, 942 items (935 coded), 188 technical services on 62 stands, L63 ×6 as 'BEZ elektriky'", { skip: !existsSync(realPdf) }, async () => {
  const parsed = parseAbraOrderFormPdf(await realPdfItems(realPdf));
  const result = buildAbraOrderTechnicalImport(parsed);
  assert.equal(parsed.orders.length, 127);
  assert.deepEqual(parsed.orders.map((order) => order.orderNumber), Array.from({ length: 127 }, (_, index) => `V238-${index + 1}/2026`));
  assert.equal(parsed.pageCount, 151);
  assert.deepEqual(parsed.ambiguousPages, []);
  assert.equal(parsed.orders.reduce((pages, order) => pages + order.pages.length, 0), 151, "every PDF page belongs to exactly one order");
  assert.equal(parsed.orders.filter((order) => order.pages.length === 2).length, 24);
  for (const order of parsed.orders) assert.deepEqual(order.pages, order.pages.map((_, index) => order.pages[0]! + index), order.orderNumber);
  assert.equal(result.counts.items, 942);
  assert.equal(parsed.orders.flatMap((order) => order.items).filter((item) => item.code).length, 935);
  assert.equal(result.counts.technicalServices, 188);
  assert.equal(result.counts.standsWithTechnicalServices, 62);
  assert.deepEqual(result.unknownTechnicalCodes, []);
  assert.equal(result.noElectricityLines.length, 6);
  assert.equal(result.reviewItems.filter((item) => item.kind === "cancellationFee").length, 4);
  assert.equal(result.reviewItems.filter((item) => item.kind === "uncodedItem").length, 7);
  const w32 = result.importedLines.find((line) => line.code === "W32")!;
  assert.deepEqual([w32.standNumber, w32.quantity, w32.unit], ["3A01", 1.8, "m3"]);
});

test("REAL orders × REAL electricity report: nothing of the report removed, confirmed services added once, re-import adds nothing", { skip: !existsSync(realPdf) || !existsSync(realElectricity) }, async () => {
  const orderImport = buildAbraOrderTechnicalImport(parseAbraOrderFormPdf(await realPdfItems(realPdf)));
  const { getTechnicalReportParser } = await import("../domain/technicalReportParsers/index.ts");
  const report = getTechnicalReportParser("electricity")!.parse(await realPdfItems(realElectricity));
  const project = confirm(createTechnicalRasterProject({ name: "real" }, "real"), "electricity", report).project;
  const reportServiceIds = project.stands.flatMap((stand) => stand.services.map((service) => service.id));
  const reconciliation = reconcileAbraOrdersWithProject(project, orderImport);
  assert.ok(reconciliation.counts.onlyExisting > 0 && reconciliation.counts.new > 0);
  const { project: after, diff } = applyOrders(project, orderImport);
  assert.equal(diff.removed, 0);
  const afterIds = new Set(after.stands.flatMap((stand) => stand.services.map((service) => service.id)));
  assert.ok(reportServiceIds.every((id) => afterIds.has(id)), "every report service is still there");
  assert.equal(afterIds.size, reportServiceIds.length + diff.added);
  const again = reconcileAbraOrdersWithProject(after, orderImport);
  assert.deepEqual([again.counts.new, again.counts.noElectricityNew, again.counts.onlyExisting], [0, 0, reconciliation.counts.onlyExisting]);
  assert.equal(applyOrders(after, orderImport).diff.added, 0);
});
