import assert from "node:assert/strict";
import test from "node:test";
import {
  extractTechnicalMentionsFromCatalogStand,
  parseSupplementalCatalogPdf,
  type ParsedCatalogStand,
} from "../domain/technicalRasterCatalogImport.ts";
import type { PdfTextItem } from "../domain/technicalReportTableParsing.ts";

// ============================================================================
// Corrective batch (post real-file acceptance test) section 7/8/9 — supplemental catalog PDF
// parser ("5. Stavby - tisk vše katalog"). Column x-positions below are the REAL ones verified
// directly against `_IMPORT/realizacky.pdf` (see scripts/technicalRasterCatalogRealDiagnostic.ts
// for the skip-safe real-file run) — never invented.
// ============================================================================

function item(str: string, x: number, y: number, page = 1): PdfTextItem {
  return { str, page, x, y, width: str.length * 5, height: 9 };
}

const STAND_COL_X = 28.3;
const DOC_COL_X = 116.1;
const TRADE_COL_X = 186.9;
const R_COL_X = 325.6;
const NOTE_COL_X = 45.3;
const QTY_COL_X = 243.8;

/** Builds the real 3-row "header + company" preamble every stand block starts with. */
function standPreamble(y0: number, standNumber: string | undefined, docNumber: string, company: string, trade: string, realizationRaw: string | undefined, page = 1): PdfTextItem[] {
  const headerRow = standNumber
    ? [item(standNumber, STAND_COL_X, y0, page), item(docNumber, DOC_COL_X, y0, page)]
    : [item(docNumber, DOC_COL_X, y0, page)];
  const companyRow = [
    item(company, STAND_COL_X, y0 - 14, page),
    item(trade, TRADE_COL_X, y0 - 14, page),
    ...(realizationRaw !== undefined ? [item(`R: ${realizationRaw}`, R_COL_X, y0 - 14, page)] : []),
  ];
  return [...headerRow, ...companyRow];
}

function itemRow(label: string, qtyUnitText: string, y: number, page = 1): PdfTextItem[] {
  return [item(label, STAND_COL_X, y, page), item(qtyUnitText, QTY_COL_X, y, page)];
}

function noteRow(text: string, y: number, page = 1): PdfTextItem[] {
  return [item(text, NOTE_COL_X, y, page)];
}

function columnHeaderRow(y: number, page = 1): PdfTextItem[] {
  return [item("Stánek", STAND_COL_X, y, page), item("Číslo dokladu", 113.3, y, page), item("Externí číslo", 198.2, y, page)];
}

function footerRow(y: number, page = 1): PdfTextItem[] {
  return [item("Výtisk sestavil(a)", STAND_COL_X, y, page), item("Jan Novák", 94.9, y, page), item("dne", 226.5, y, page), item("11.09.2026", 246.3, y, page), item("strana", 487.0, y, page), item(String(page), 518.2, y, page)];
}

test("A) a full real-shaped stand block: header, company/trade/R:, one item, extracts everything correctly", () => {
  const items: PdfTextItem[] = [
    ...columnHeaderRow(720),
    ...standPreamble(691, "1A16", "V229-5/2026", "Pavoncella sp. z o.o.", "Pavoncella sp. z o.o.", "CREATIV EXPO, s.r.o."),
    ...itemRow("ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230", "1,0 ks", 572.7),
  ];
  const result = parseSupplementalCatalogPdf(items);
  assert.equal(result.stands.length, 1);
  const stand = result.stands[0]!;
  assert.equal(stand.standNumber, "1A16");
  assert.equal(stand.documentNumber, "V229-5/2026");
  assert.equal(stand.companyName, "Pavoncella sp. z o.o.");
  assert.equal(stand.tradeName, "Pavoncella sp. z o.o.");
  assert.equal(stand.realizationCompanyRaw, "CREATIV EXPO, s.r.o.");
  assert.equal(stand.items.length, 1);
  assert.equal(stand.items[0]!.label, "ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230");
  assert.equal(stand.items[0]!.quantity, 1);
  assert.equal(stand.items[0]!.unit, "ks");
});

test("B) dimensions row (Šířka:/Hloubka:/Stavba od ABF) and area row (PLOCHA) are both skipped, never counted as items", () => {
  const items: PdfTextItem[] = [
    ...standPreamble(691, "1A16", "V229-5/2026", "Firma", "Firma", "GENDAI"),
    item("Šířka:", STAND_COL_X, 663.3), item("Hloubka:", 116.1, 663.3), item("Stavba od ABF: Ano", 223.7, 663.3), item("3 m", 155.7, 663.3), item("3 m", 53.8, 663.3),
    item("PLOCHA ŘADOVÁ", STAND_COL_X, 652.0), item("9,0", 243.8, 652.0), item("m2", 257.7, 652.0),
    ...itemRow("REGISTRACE VYSTAVOVATELE", "1,0 ks", 640.6),
  ];
  const stand = parseSupplementalCatalogPdf(items).stands[0]!;
  assert.equal(stand.items.length, 1, "only the real item row counts — dimensions/area rows are metadata, never items");
  assert.equal(stand.items[0]!.label, "REGISTRACE VYSTAVOVATELE");
});

test("C) a note row attaches to the PRECEDING item, never becomes its own item", () => {
  const items: PdfTextItem[] = [
    ...standPreamble(691, "1A16", "V229-5/2026", "Firma", "Firma", undefined),
    ...itemRow("T09 - TYPOVÝ STÁNEK 3X3 m (STAVBA)", "1,0 ks", 640.6),
    ...noteRow("SOK - 13.7. Schvaleno emailem Polanek", 629.3),
    ...itemRow("ŽIDLE KOVOVÁ ČALOUNĚNÁ", "4,0 ks", 618.0),
  ];
  const stand = parseSupplementalCatalogPdf(items).stands[0]!;
  assert.equal(stand.items.length, 2, "the note must never be counted as a 3rd item");
  assert.deepEqual(stand.items[0]!.notes, ["SOK - 13.7. Schvaleno emailem Polanek"]);
  assert.deepEqual(stand.items[1]!.notes, []);
});

test("D) a stand with NO realization line at all -> realizationCompanyRaw is undefined, never a fabricated value", () => {
  const items: PdfTextItem[] = [
    ...standPreamble(691, "1A16", "V229-5/2026", "Firma", "Firma", undefined),
    ...itemRow("ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230", "1,0 ks", 640.6),
  ];
  const stand = parseSupplementalCatalogPdf(items).stands[0]!;
  assert.equal(stand.realizationCompanyRaw, undefined);
});

test("E) a stand header with a document number but NO stand number (real fixture edge case) is captured, standNumber stays undefined, never fabricated — and a warning is raised", () => {
  const items: PdfTextItem[] = [
    item("V229-17/2026", DOC_COL_X, 300.7),
    ...standPreamble(287.2, undefined, "V229-17/2026", "Langtang Handicraft", "Langtang Handicraft", "CREATIV EXPO, s.r.o.").slice(1), // company row only (header row supplied above)
  ];
  const result = parseSupplementalCatalogPdf(items);
  assert.equal(result.stands.length, 1);
  assert.equal(result.stands[0]!.standNumber, undefined);
  assert.equal(result.stands[0]!.companyName, "Langtang Handicraft");
  assert.ok(result.warnings.some((warning) => warning.message.includes("V229-17/2026") && warning.message.includes("nelze jej spárovat")));
});

test("F) multi-page continuation: item/note rows after a page break, before the NEXT stand header, still belong to the PREVIOUS stand — the repeated column-header row and page footer are pure noise", () => {
  const items: PdfTextItem[] = [
    ...standPreamble(691, "1B05", "V229-11/2026", "ROSA IMPORT s.r.o.", "ROSA IMPORT s.r.o.", "CREATIV EXPO, s.r.o.", 1),
    ...itemRow("KOBEREC BAREVNÝ", "45,0 m2", 600, 1),
    ...footerRow(33.1, 1),
    // page 2 begins with the repeated table header, then MORE items for the SAME stand (1B05), no new header row:
    ...columnHeaderRow(806.3, 2),
    ...itemRow("REFLEKTOR HALOGENOVÝ HQI 150 W", "15,0 ks", 795.0, 2),
    ...itemRow("ELEKTRICKÁ ENERGIE - PŘÍKON DO 5 kW/230", "1,0 ks", 780.0, 2),
    // NOW a real new stand begins on page 2:
    ...standPreamble(700, "1B17", "V229-13/2026", "MYRIS TRADE, s.r.o.", "MYRIS TRADE, s.r.o.", "CREATIV EXPO, s.r.o.", 2),
    ...itemRow("DVEŘE SHRNOVACÍ UZAMYKATELNÉ 100X20", "1,0 ks", 650.0, 2),
  ];
  const result = parseSupplementalCatalogPdf(items);
  assert.equal(result.stands.length, 2);
  const stand1B05 = result.stands.find((stand) => stand.standNumber === "1B05")!;
  assert.equal(stand1B05.items.length, 3, "the two page-2 items before the next header must still belong to 1B05");
  assert.ok(stand1B05.items.some((row) => row.label === "ELEKTRICKÁ ENERGIE - PŘÍKON DO 5 kW/230"));
  const stand1B17 = result.stands.find((stand) => stand.standNumber === "1B17")!;
  assert.equal(stand1B17.items.length, 1);
  assert.equal(stand1B17.page, 2);
});

test("G) preamble/masthead rows before the first stand header (title, 'Firma:', 'Zakázka:', ...) are silently ignored, never crash, never attach anywhere", () => {
  const items: PdfTextItem[] = [
    item("5. Stavby - tisk vše katalog", STAND_COL_X, 802.7),
    item("Firma: ABF, a.s.", STAND_COL_X, 787.5),
    item("Zakázka: (1): 26V229 FOR DECOR & PRESENT 2026 podzim", 33.9, 757.0),
    ...columnHeaderRow(720.2),
    ...standPreamble(691, "1A16", "V229-5/2026", "Firma", "Firma", "GENDAI"),
    ...itemRow("REGISTRACE VYSTAVOVATELE", "1,0 ks", 640.6),
  ];
  const result = parseSupplementalCatalogPdf(items);
  assert.equal(result.stands.length, 1);
  assert.equal(result.stands[0]!.standNumber, "1A16");
});

test("P) known document header/footer metadata (corrective batch 3rd, section 15) never produces a warning — including 'Výběrové podmínky...'/'Stavba od ABF:'/'Včetně revizí:' lines previously misclassified as out-of-block items", () => {
  const items: PdfTextItem[] = [
    item("5. Stavby - tisk vše katalog", STAND_COL_X, 802.7),
    item("Firma: ABF, a.s.", STAND_COL_X, 787.5),
    item("Výběrové podmínky pro sestavení tisku", STAND_COL_X, 770.0),
    item("Zakázka: (1): 26V229 FOR DECOR & PRESENT 2026 podzim", 33.9, 757.0),
    item("Stavba od ABF: ANO", STAND_COL_X, 744.0),
    item("Včetně revizí: Ne", STAND_COL_X, 733.0),
    ...columnHeaderRow(720.2),
    ...standPreamble(691, "1A16", "V229-5/2026", "Firma", "Firma", "GENDAI"),
    ...itemRow("REGISTRACE VYSTAVOVATELE", "1,0 ks", 640.6),
  ];
  const result = parseSupplementalCatalogPdf(items);
  assert.equal(result.stands.length, 1);
  assert.equal(result.stands[0]!.items.length, 1, "none of the metadata lines may be misclassified as a real item");
  assert.equal(result.warnings.length, 0, "known document metadata must never generate a warning");
});

test("Q) a genuinely unexpected row still produces a warning — the metadata cleanup must not silently swallow real findings", () => {
  const items: PdfTextItem[] = [
    ...standPreamble(691, "1A16", "V229-5/2026", "Firma", "Firma", "GENDAI"),
    item("Nějaký naprosto neočekávaný text uprostřed dokumentu", 250, 650),
    ...itemRow("REGISTRACE VYSTAVOVATELE", "1,0 ks", 640.6),
  ];
  const result = parseSupplementalCatalogPdf(items);
  assert.equal(result.warnings.length, 1);
  assert.ok(result.warnings[0]!.message.includes("Nějaký naprosto neočekávaný text"));
});

test("H) quantity/unit parsing handles every real unit shape seen in the fixture (ks, bm, m2, m2/ak, combined in one token)", () => {
  const items: PdfTextItem[] = [
    ...standPreamble(691, "1A11", "V229-30/2026", "Firma", "Firma", "CREATIV EXPO"),
    ...itemRow("STAVBA OBVODOVÝCH STĚN - OCTANORM", "7,0 bm", 600),
    ...itemRow("KOBEREC ŠEDÝ", "12,0 m2", 580),
    ...itemRow("ÚKLID DENNÍ", "40,0 m2/ak", 560),
    ...itemRow("REGISTRACE VYSTAVOVATELE", "1,0 ks", 540),
  ];
  const stand = parseSupplementalCatalogPdf(items).stands[0]!;
  assert.deepEqual(stand.items.map((row) => [row.quantity, row.unit]), [[7, "bm"], [12, "m2"], [40, "m2/ak"], [1, "ks"]]);
});

// ============================================================================
// extractTechnicalMentionsFromCatalogStand — category classification, including the two real
// Czech-grammar edge cases this batch found and fixed (genitive "elektrické" after "bez", and the
// non-ASCII \b/\w failure on "Ú").
// ============================================================================

function stand(overrides: Partial<ParsedCatalogStand> = {}): ParsedCatalogStand {
  return { standNumber: "1A16", items: [], page: 1, ...overrides };
}

test("I) electricity: a normal kW label classifies correctly and keeps its own real variant", () => {
  const mentions = extractTechnicalMentionsFromCatalogStand(stand({ items: [{ label: "ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 }] }));
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0]!.category, "electricity");
  assert.equal(mentions[0]!.negated, undefined);
});

test("J) electricity NEGATION: 'BEZ ELEKTRICKÉ ENERGIE' (genitive case) is recognized as a negated electricity mention — the real fixture's own exact wording", () => {
  const mentions = extractTechnicalMentionsFromCatalogStand(stand({ items: [{ label: "BEZ ELEKTRICKÉ ENERGIE", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 }] }));
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0]!.category, "electricity");
  assert.equal(mentions[0]!.negated, true);
});

test("K) cleaning: 'ÚKLID DENNÍ' (leading Czech diacritic letter) is correctly classified — regression guard for the real \\b/\\w Unicode bug this batch found", () => {
  const mentions = extractTechnicalMentionsFromCatalogStand(stand({ items: [{ label: "ÚKLID DENNÍ", quantity: 40, unit: "m2/ak", rawQuantityText: "40,0 m2/ak", notes: [], page: 1 }] }));
  assert.equal(mentions.length, 1);
  assert.equal(mentions[0]!.category, "cleaning");
});

test("L) internet: WIFI label classifies as internet", () => {
  const mentions = extractTechnicalMentionsFromCatalogStand(stand({ items: [{ label: "INTERNET - WIFI PŘIPOJENÍ (MIMO VENKOVNÍ", quantity: 2, unit: "ks", rawQuantityText: "2,0 ks", notes: [], page: 1 }] }));
  assert.equal(mentions[0]!.category, "internet");
});

test("M) non-technical catalog rows (furniture, construction, admin) never produce a mention", () => {
  const mentions = extractTechnicalMentionsFromCatalogStand(stand({
    items: [
      { label: "ŽIDLE KOVOVÁ ČALOUNĚNÁ", quantity: 4, unit: "ks", rawQuantityText: "4,0 ks", notes: [], page: 1 },
      { label: "PULT PLNÝ S POLICÍ 100X50X110 cm", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 },
      { label: "REGISTRACE VYSTAVOVATELE", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 },
      { label: "KOŠ ODPADKOVÝ", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 },
    ],
  }));
  assert.equal(mentions.length, 0, "furniture/admin rows (including a wastebasket, a physical object, never a waste-removal SERVICE) must never be misclassified as technical services");
});

test("N) a stand with no standNumber produces NO mentions at all — never reconciled without a real join key", () => {
  const mentions = extractTechnicalMentionsFromCatalogStand(stand({
    standNumber: undefined,
    items: [{ label: "ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 }],
  }));
  assert.equal(mentions.length, 0);
});

test("O) waste service labels (kontejner/odvoz odpadu) classify as waste, but a wastebasket furniture item does not", () => {
  assert.equal(extractTechnicalMentionsFromCatalogStand(stand({ items: [{ label: "Kontejn 1100 l", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 }] }))[0]?.category, "waste");
  assert.equal(extractTechnicalMentionsFromCatalogStand(stand({ items: [{ label: "Odvoz odpadu", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 }] }))[0]?.category, "waste");
  assert.equal(extractTechnicalMentionsFromCatalogStand(stand({ items: [{ label: "KOŠ ODPADKOVÝ", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 }] })).length, 0);
});
