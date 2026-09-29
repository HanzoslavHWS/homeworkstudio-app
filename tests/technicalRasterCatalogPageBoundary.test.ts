import assert from "node:assert/strict";
import test from "node:test";
import { extractTechnicalMentionsFromCatalogStand, parseSupplementalCatalogPdf } from "../domain/technicalRasterCatalogImport.ts";
import { resolveTechnicalRealizationGroup } from "../domain/technicalRasterRealization.ts";
import type { PdfTextItem } from "../domain/technicalReportTableParsing.ts";

// =========================================================================================
// CORRECTIVE BATCH (real FOR BEAUTY catalog, 2026-09-24 export) — a stand HEADER printed as the
// LAST row of page N, its company/R row as the first content row of page N+1. Between them sit the
// page-N footer and page-N+1's repeated column header. Previously the footer ("Výtisk sestavil(a)")
// was consumed as the company row, and the real "<company> … R: …" row fell through to item
// parsing, producing 8 structural warnings like
//   Položka "Espeon, s.r.o." u stánku 4B15 má nerozpoznané množství "R: CREATIV EXPO, s.r.o."
// The sequences below are the exact production rows (text, x positions and page split) dumped from
// the real file by scripts/technicalRasterBeautyProductionDiagnostic.ts --rows.
// =========================================================================================

function item(str: string, x: number, y: number, page: number): PdfTextItem {
  return { str, page, x, y, width: str.length * 5, height: 9 };
}

type Boundary = Readonly<{
  standNumber: string;
  documentNumber: string;
  page: number;
  /** Last item of the PREVIOUS stand, printed just above the header on page N. */
  previousLastItem: string;
  company: string;
  trade: string;
  realizationRun: string;
  expectedRealizationRaw: string;
  /** First real item row of the new stand on page N+1. */
  firstItem: readonly [string, string];
  withDimensions: boolean;
}>;

const BOUNDARIES: readonly Boundary[] = [
  { standNumber: "4B15", documentNumber: "V253-57/2026", page: 10, previousLastItem: "ZAJIŠTĚNÍ POJIŠTĚNÍ ODPOVĚDNOSTI ZA ŠK", company: "Espeon, s.r.o.", trade: "Rukavice Espeon", realizationRun: "R: CREATIV EXPO, s.r.o.", expectedRealizationRaw: "CREATIV EXPO, s.r.o.", firstItem: ["T12 - TYPOVÝ STÁNEK 4X3 m (STAVBA)", "1,0 ks"], withDimensions: true },
  { standNumber: "4C08", documentNumber: "V253-74/2026", page: 13, previousLastItem: "INTERNET - KABEL RJ45, 1. PŘIPOJENÍ", company: "ABF, a.s.", trade: "ABF, a.s. - zázemí DP 1", realizationRun: "R: CREATIV EXPO, s.r.o.", expectedRealizationRaw: "CREATIV EXPO, s.r.o.", firstItem: ["STAVBA OBVODOVÝCH STĚN - OCTANORM", "4,0 bm"], withDimensions: false },
  { standNumber: "4C02", documentNumber: "V253-77/2026", page: 14, previousLastItem: "ÚKLID DENNÍ", company: "ABF, a.s.", trade: "ABF, a.s. - zázemí DP 2 (NAIL MA", realizationRun: "R: CREATIV EXPO, s.r.o.", expectedRealizationRaw: "CREATIV EXPO, s.r.o.", firstItem: ["STAVBA OBVODOVÝCH STĚN - OCTANORM", "7,0 bm"], withDimensions: false },
  { standNumber: "3A34", documentNumber: "V253-124/202", page: 25, previousLastItem: "ZAJIŠTĚNÍ POJIŠTĚNÍ ODPOVĚDNOSTI ZA ŠK", company: "Esthetix Professional s.r.o.", trade: "Esthetix Professional s.r.o.", realizationRun: "R: MAC Praha, spol. s r.o.", expectedRealizationRaw: "MAC Praha, spol. s r.o.", firstItem: ["INDIVIDUÁLNÍ STÁNEK (STAVBA ATYPU)", "1,0 ks"], withDimensions: true },
  { standNumber: "4B24", documentNumber: "V253-129/202", page: 26, previousLastItem: "INTERNET - WIFI PŘIPOJENÍ (MIMO VENKOVNÍ", company: "Česká podologická společnost, z. s.", trade: "Česká podologická společnost,", realizationRun: "R: CREATIV EXPO, s.r.o.", expectedRealizationRaw: "CREATIV EXPO, s.r.o.", firstItem: ["STAVBA STÁNKU - OCTANORM", "6,0 m2"], withDimensions: true },
  { standNumber: "3A20", documentNumber: "V253-137/202", page: 28, previousLastItem: "ZAJIŠTĚNÍ POJIŠTĚNÍ ODPOVĚDNOSTI ZA ŠK", company: "Medaprex, s.r.o.", trade: "ANNA BRANDEJS ®", realizationRun: "R: GENDAI, s.r.o.", expectedRealizationRaw: "GENDAI, s.r.o.", firstItem: ["INDIVIDUÁLNÍ STÁNEK (STAVBA ATYPU)", "1,0 ks"], withDimensions: true },
  { standNumber: "4B11", documentNumber: "V253-208/202", page: 43, previousLastItem: "ZAJIŠTĚNÍ POJIŠTĚNÍ ODPOVĚDNOSTI ZA ŠK", company: "Klaudia Eisová", trade: "Klaudia Eis HAIR", realizationRun: "R: MAC Praha, spol. s r.o.", expectedRealizationRaw: "MAC Praha, spol. s r.o.", firstItem: ["STAVBA STÁNKU - OCTANORM", "4,5 m2"], withDimensions: true },
];

/** Page N: previous stand's last item, the NEW stand's header, the page footer. Page N+1: column header, company/R, (dimensions + area), first items. */
function boundaryItems(boundary: Boundary, options: Readonly<{ mergedTradeAndR?: string }> = {}): PdfTextItem[] {
  const n = boundary.page;
  const next = n + 1;
  const companyRow = options.mergedTradeAndR
    ? [item(boundary.company, 28, 740, next), item(options.mergedTradeAndR, 187, 740, next)]
    : [item(boundary.company, 28, 740, next), item(boundary.trade, 187, 740, next), item(boundary.realizationRun, 326, 740, next)];
  return [
    // a previous stand so the page-N item has an owner
    item("9Z99", 28, 700, n), item("V253-1/2026", 116, 700, n),
    item("Předchozí firma", 28, 686, n), item("Předchozí", 187, 686, n), item("R: GENDAI, s.r.o.", 326, 686, n),
    item(boundary.previousLastItem, 28, 90, n), item("1,0 ks", 244, 90, n),
    item(boundary.standNumber, 28, 70, n), item(boundary.documentNumber, 116, 70, n),
    item("Výtisk sestavil(a)", 28, 30, n), item("Jan Polánek", 95, 30, n), item("dne", 227, 30, n), item("24.09.2026", 246, 30, n), item("strana", 487, 30, n), item(String(n), 518, 30, n),
    item("Stánek", 28, 770, next), item("Číslo dokladu", 113, 770, next), item("Externí číslo", 198, 770, next),
    ...companyRow,
    ...(boundary.withDimensions
      ? [item("Šířka:", 28, 726, next), item("4 m", 54, 726, next), item("Hloubka:", 116, 726, next), item("3 m", 156, 726, next), item("Stavba od ABF: Ano", 224, 726, next), item("PLOCHA ŘADOVÁ", 28, 712, next), item("12,0", 239, 712, next), item("m2", 258, 712, next)]
      : []),
    item(boundary.firstItem[0], 28, 698, next), item(boundary.firstItem[1], 244, 698, next),
    item("ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230", 28, 684, next), item("1,0 ks", 244, 684, next),
  ];
}

for (const boundary of BOUNDARIES) {
  test(`PAGE BOUNDARY ${boundary.standNumber}: header at the end of page ${boundary.page}, company/R on page ${boundary.page + 1} -> ONE record owning company + R, no false quantity warning`, () => {
    const result = parseSupplementalCatalogPdf(boundaryItems(boundary));
    assert.deepEqual(result.warnings, [], "company/R never parsed as an item -> no structural warning");
    assert.deepEqual(result.stands.map((stand) => stand.standNumber), ["9Z99", boundary.standNumber]);
    const previous = result.stands[0]!;
    assert.deepEqual(previous.items.map((row) => row.label), [boundary.previousLastItem], "the page-N item still belongs to the previous stand");
    const stand = result.stands[1]!;
    // The document number is auxiliary metadata (the stand number is the structural boundary); a
    // column-truncated real value like "V253-124/202" is not captured — pre-existing behavior.
    assert.equal(stand.documentNumber, /\/\d{4}$/u.test(boundary.documentNumber) ? boundary.documentNumber : undefined);
    assert.equal(stand.page, boundary.page, "record starts where its header is");
    assert.equal(stand.companyName, boundary.company);
    assert.equal(stand.tradeName, boundary.trade);
    assert.equal(stand.realizationCompanyRaw, boundary.expectedRealizationRaw);
    assert.notEqual(resolveTechnicalRealizationGroup(stand.realizationCompanyRaw), "ostatni", "known R resolves to its canonical group");
    assert.ok(!stand.items.some((row) => row.label === boundary.company || /R\s*:/u.test(row.rawQuantityText)), "company/R never inserted as a catalog item");
    assert.deepEqual(stand.items.map((row) => row.label), [boundary.firstItem[0], "ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230"], "following service rows belong to the new stand");
    assert.equal(extractTechnicalMentionsFromCatalogStand(stand).length, 1, "the new stand's own electricity row is a mention of THIS stand");
  });
}

test("PAGE BOUNDARY 3C32: trade name and R merged into ONE pdf.js run ('… NÁUŠ R: MAC Praha, spol. s r.o.') -> R split off structurally", () => {
  const boundary: Boundary = { standNumber: "3C32", documentNumber: "V253-151/202", page: 31, previousLastItem: "ZAJIŠTĚNÍ POJIŠTĚNÍ ODPOVĚDNOSTI ZA ŠK", company: "Bc. Markéta Bednářová", trade: "", realizationRun: "", expectedRealizationRaw: "MAC Praha, spol. s r.o.", firstItem: ["STAVBA STÁNKU - OCTANORM", "12,0 m2"], withDimensions: true };
  const result = parseSupplementalCatalogPdf(boundaryItems(boundary, { mergedTradeAndR: "PIERCING A NASTŘELOVÁNÍ NÁUŠ R: MAC Praha, spol. s r.o." }));
  assert.deepEqual(result.warnings, []);
  const stand = result.stands.find((candidate) => candidate.standNumber === "3C32")!;
  assert.equal(stand.companyName, "Bc. Markéta Bednářová");
  assert.equal(stand.tradeName, "PIERCING A NASTŘELOVÁNÍ NÁUŠ");
  assert.equal(stand.realizationCompanyRaw, "MAC Praha, spol. s r.o.");
  assert.equal(resolveTechnicalRealizationGroup(stand.realizationCompanyRaw), "macPraha");
});

test("MERGED R (not a page boundary, real 4C01): company name and R in one run -> company and R both recovered", () => {
  const items = [
    item("4C01", 28, 700, 14), item("V253-76/2026", 116, 700, 14),
    item("ABF, a.s. - SOUTĚŽ - BEAUTY FOOT CUP NAIL MASTER ARENA / BEAUTY FO R: CREATIV EXPO, s.r.o.", 28, 686, 14),
    item("STAVBA STÁNKU - OCTANORM", 28, 660, 14), item("30,0 m2", 239, 660, 14),
  ];
  const stand = parseSupplementalCatalogPdf(items).stands[0]!;
  assert.equal(stand.companyName, "ABF, a.s. - SOUTĚŽ - BEAUTY FOOT CUP NAIL MASTER ARENA / BEAUTY FO");
  assert.equal(stand.realizationCompanyRaw, "CREATIV EXPO, s.r.o.");
  assert.equal(stand.items.length, 1);
});

test("A company name that merely contains 'r' / 'R' (no ' R: ' separator) is never split", () => {
  const items = [item("3A01", 28, 700, 1), item("V1-1/2026", 116, 700, 1), item("RAR Group s.r.o.", 28, 686, 1), item("Rozmarýn", 187, 686, 1)];
  const stand = parseSupplementalCatalogPdf(items).stands[0]!;
  assert.equal(stand.companyName, "RAR Group s.r.o.");
  assert.equal(stand.tradeName, "Rozmarýn");
  assert.equal(stand.realizationCompanyRaw, undefined);
});

test("BLANK / UNKNOWN R across a page boundary: still a valid catalog record (OSTATNÍ), never dropped", () => {
  const blank = parseSupplementalCatalogPdf(boundaryItems({ ...BOUNDARIES[0]!, realizationRun: "R:", expectedRealizationRaw: "" })).stands[1]!;
  assert.equal(blank.standNumber, "4B15");
  assert.equal(blank.companyName, "Espeon, s.r.o.");
  assert.equal(blank.realizationCompanyRaw, undefined);
  assert.equal(resolveTechnicalRealizationGroup(blank.realizationCompanyRaw), "ostatni");
  const unknown = parseSupplementalCatalogPdf(boundaryItems({ ...BOUNDARIES[0]!, realizationRun: "R: Neznámá realizace s.r.o.", expectedRealizationRaw: "" })).stands[1]!;
  assert.equal(unknown.realizationCompanyRaw, "Neznámá realizace s.r.o.");
  assert.equal(resolveTechnicalRealizationGroup(unknown.realizationCompanyRaw), "ostatni");
});

test("NORMAL CROSS-PAGE CONTINUATION still works: item rows after the footer + repeated column header belong to the stand already in progress", () => {
  const items = [
    item("3A10", 28, 700, 5), item("V253-10/2026", 116, 700, 5),
    item("Firma X", 28, 686, 5), item("Firma X", 187, 686, 5), item("R: GENDAI, s.r.o.", 326, 686, 5),
    item("STAVBA STÁNKU - OCTANORM", 28, 90, 5), item("9,0 m2", 244, 90, 5),
    item("Výtisk sestavil(a)", 28, 30, 5), item("strana", 487, 30, 5), item("5", 518, 30, 5),
    item("Stánek", 28, 770, 6), item("Číslo dokladu", 113, 770, 6), item("Externí číslo", 198, 770, 6),
    item("ÚKLID DENNÍ", 28, 740, 6), item("9,0 m2/ak", 239, 740, 6),
    item("INTERNET - KABEL RJ45, 1. PŘIPOJENÍ", 28, 726, 6), item("1,0 ks", 244, 726, 6),
  ];
  const result = parseSupplementalCatalogPdf(items);
  assert.deepEqual(result.warnings, []);
  assert.equal(result.stands.length, 1);
  assert.equal(result.stands[0]!.companyName, "Firma X", "company not overwritten by the page-N+1 first row");
  assert.deepEqual(result.stands[0]!.items.map((row) => row.label), ["STAVBA STÁNKU - OCTANORM", "ÚKLID DENNÍ", "INTERNET - KABEL RJ45, 1. PŘIPOJENÍ"]);
});

test("A stand with no company row at all: its dimensions row ends the wait and is never taken as the company", () => {
  const items = [
    item("3A11", 28, 700, 1), item("V253-11/2026", 116, 700, 1),
    item("Šířka:", 28, 686, 1), item("3 m", 54, 686, 1), item("Hloubka:", 116, 686, 1), item("3 m", 156, 686, 1),
    item("STAVBA STÁNKU - OCTANORM", 28, 660, 1), item("9,0 m2", 244, 660, 1),
  ];
  const stand = parseSupplementalCatalogPdf(items).stands[0]!;
  assert.equal(stand.companyName, undefined);
  assert.deepEqual(stand.items.map((row) => row.label), ["STAVBA STÁNKU - OCTANORM"]);
});

test("Two consecutive headers across a page boundary: the second header is a new record, never swallowed as the first one's company", () => {
  const items = [
    item("3A12", 28, 70, 2), item("V253-12/2026", 116, 70, 2),
    item("Výtisk sestavil(a)", 28, 30, 2), item("strana", 487, 30, 2), item("2", 518, 30, 2),
    item("Stánek", 28, 770, 3), item("Číslo dokladu", 113, 770, 3),
    item("3A13", 28, 740, 3), item("V253-13/2026", 116, 740, 3),
    item("Firma 13", 28, 726, 3), item("Firma 13", 187, 726, 3), item("R: GENDAI, s.r.o.", 326, 726, 3),
  ];
  const result = parseSupplementalCatalogPdf(items);
  assert.deepEqual(result.stands.map((stand) => [stand.standNumber, stand.companyName, stand.realizationCompanyRaw]), [["3A12", undefined, undefined], ["3A13", "Firma 13", "GENDAI, s.r.o."]]);
});

test("Genuinely malformed item quantities still warn — the fix is structural, never warning suppression", () => {
  const items = [
    ...boundaryItems(BOUNDARIES[0]!),
    item("POLOŽKA S DIVNÝM MNOŽSTVÍM", 28, 670, 11), item("cca pár kusů", 244, 670, 11),
  ];
  const result = parseSupplementalCatalogPdf(items);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0]!.message, /POLOŽKA S DIVNÝM MNOŽSTVÍM.*4B15.*cca pár kusů/u);
});
