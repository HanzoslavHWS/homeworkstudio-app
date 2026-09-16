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

// ============================================================================
// CORRECTIVE BATCH (4th, real Beauty-catalog production import) section 2/3/19 — real production
// root cause: header-row detection depended ENTIRELY on the document-number token (its pattern AND
// its narrow column position). A later stand's own header row whose document-number token was not
// recognized (pattern mismatch / position shift / pdf.js splitting it across runs) was silently
// swallowed as an ITEM ROW of the still-open PREVIOUS stand — and because the state machine never
// flushed/reset, that header's own following company/"R:" row was then ALSO swallowed as a second
// bogus item. Verified against the real report's own warnings (stand "3A33" and its company
// "Terra99 Europe s.r.o." both appearing as item rows under the PRECEDING stand "3A46"). The fix
// (extractLeftColumnStandNumber in domain/technicalRasterCatalogImport.ts) makes the stand's OWN
// number — recognized by the SAME shared shape every other parser in this app already trusts — the
// PRIMARY, structural boundary signal, independent of the document-number token entirely.
// ============================================================================

test("R) REAL PRODUCTION SEQUENCE: 3A46 -> 3A33 (header row whose OWN document-number token is unrecognized) -> Terra99 Europe s.r.o. + R: CREATIV EXPO -> both stands are independent records, neither swallows the other", () => {
  const items: PdfTextItem[] = [
    ...standPreamble(700, "3A46", "V231-46/2026", "Firma A46", "Firma A46", "GENDAI, s.r.o."),
    ...itemRow("ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230", "1,0 ks", 660),
    // 3A33's own header row: its document-number token is garbled/unrecognized — the real production
    // failure mode — so ONLY the stand number's own shape is available as a boundary signal.
    item("3A33", STAND_COL_X, 630),
    item("V231-XX?", DOC_COL_X, 630),
    item("Terra99 Europe s.r.o.", STAND_COL_X, 616),
    item("R: CREATIV EXPO, s.r.o.", R_COL_X, 616),
  ];
  const result = parseSupplementalCatalogPdf(items);
  assert.equal(result.stands.length, 2, "3A33 must be its OWN record, never swallowed as an item of 3A46");

  const stand3A46 = result.stands.find((stand) => stand.standNumber === "3A46")!;
  assert.equal(stand3A46.items.length, 1, "3A46 must keep ONLY its own real item, never gain 3A33/Terra99/R: as bogus items");
  assert.equal(stand3A46.items[0]!.label, "ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230");

  const stand3A33 = result.stands.find((stand) => stand.standNumber === "3A33")!;
  assert.equal(stand3A33.companyName, "Terra99 Europe s.r.o.", "the company row must attach to the NEW stand (3A33), never fall through as an item of 3A46");
  assert.equal(stand3A33.realizationCompanyRaw, "CREATIV EXPO, s.r.o.");
  assert.equal(stand3A33.items.length, 0);

  assert.ok(!result.warnings.some((w) => w.message.includes("3A33") && w.message.includes("3A46")), 'no warning like `Položka "3A33" u stánku 3A46...` may ever be produced');
  assert.ok(!result.warnings.some((w) => w.message.includes("Terra99")), "the company name must never be treated as a service item / warned about");
  assert.ok(!result.warnings.some((w) => w.message.includes("CREATIV EXPO")), "the R: text must never be treated as an item quantity / warned about");
});

test("S) a later valid stand number terminates the previous record even with NO document-number token present on its header row at all", () => {
  const items: PdfTextItem[] = [
    ...standPreamble(700, "4C07", "V231-70/2026", "Firma C07", "Firma C07", "MAC Praha, spol. s r.o."),
    ...itemRow("STAVBA OBVODOVÝCH STĚN - OCTANORM", "5,0 bm", 660),
    // 4B08's header row: no document-number token at all on this row (real edge case — the doc
    // number can be entirely absent/unrecognized, not just malformed).
    item("4B08", STAND_COL_X, 630),
    item("Beauty Import s.r.o.", STAND_COL_X, 616),
    item("R: GENDAI, s.r.o.", R_COL_X, 616),
    ...itemRow("KOBEREC ŠEDÝ", "9,0 m2", 600),
  ];
  const result = parseSupplementalCatalogPdf(items);
  assert.equal(result.stands.length, 2);
  const stand4C07 = result.stands.find((stand) => stand.standNumber === "4C07")!;
  assert.equal(stand4C07.items.length, 1);
  const stand4B08 = result.stands.find((stand) => stand.standNumber === "4B08")!;
  assert.equal(stand4B08.companyName, "Beauty Import s.r.o.");
  assert.equal(stand4B08.realizationCompanyRaw, "GENDAI, s.r.o.");
  assert.equal(stand4B08.items.length, 1);
  assert.equal(stand4B08.items[0]!.label, "KOBEREC ŠEDÝ");
  assert.equal(stand4B08.documentNumber, undefined, "a header recognized purely by stand-number shape may legitimately have no captured document number");
});

test("T) H3 and H4 stand numbers both parse as independent records at the PARSER level — hall-scope classification is deliberately a LATER, separate concern", () => {
  const items: PdfTextItem[] = [
    ...standPreamble(700, "3A35", "V231-35/2026", "Firma H3", "Firma H3", "CREATIV EXPO, s.r.o."),
    ...itemRow("ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230", "1,0 ks", 660),
    ...standPreamble(630, "4A22", "V231-90/2026", "Firma H4", "Firma H4", "GENDAI, s.r.o.", 1),
    ...itemRow("ÚKLID DENNÍ", "20,0 m2/ak", 590),
  ];
  const result = parseSupplementalCatalogPdf(items);
  assert.equal(result.stands.length, 2, "the parser itself never discards/merges a hall-4 record just because this raster's own current hall might be 3");
  const stand3A35 = result.stands.find((stand) => stand.standNumber === "3A35")!;
  const stand4A22 = result.stands.find((stand) => stand.standNumber === "4A22")!;
  assert.equal(stand3A35.items.length, 1);
  assert.equal(stand4A22.items.length, 1);
  assert.equal(stand4A22.realizationCompanyRaw, "GENDAI, s.r.o.");
});

test("U) an unknown/unrecognized realization value at the parser level is still captured verbatim (never dropped/fabricated) — canonical grouping to OSTATNÍ happens later in domain/technicalRasterRealization.ts", () => {
  const items: PdfTextItem[] = [...standPreamble(691, "3B15", "V231-15/2026", "Firma", "Firma", "Elseya spol. s r.o.")];
  const stand = parseSupplementalCatalogPdf(items).stands[0]!;
  assert.equal(stand.realizationCompanyRaw, "Elseya spol. s r.o.", "a genuinely unrecognized realization company is still a valid, captured build record — never treated as absent");
});

test("V) cross-page continuation still works alongside the new stand-shape header detection: a genuine new stand near a page boundary is recognized even without a matching document-number token", () => {
  const items: PdfTextItem[] = [
    ...standPreamble(691, "3C26", "V231-26/2026", "ROSA IMPORT s.r.o.", "ROSA IMPORT s.r.o.", "CREATIV EXPO, s.r.o.", 1),
    ...itemRow("KOBEREC BAREVNÝ", "45,0 m2", 600, 1),
    ...footerRow(33.1, 1),
    ...columnHeaderRow(806.3, 2),
    ...itemRow("REFLEKTOR HALOGENOVÝ HQI 150 W", "15,0 ks", 795.0, 2),
    // a new stand begins right after the page-2 column-header noise, with its doc-number token
    // unrecognized (the same real production failure mode as test R above):
    item("3C32", STAND_COL_X, 760, 2),
    item("??-32", DOC_COL_X, 760, 2),
    item("Firma 3C32", STAND_COL_X, 746, 2),
    item("R: MAC Praha, spol. s r.o.", R_COL_X, 746, 2),
  ];
  const result = parseSupplementalCatalogPdf(items);
  assert.equal(result.stands.length, 2);
  const stand3C26 = result.stands.find((stand) => stand.standNumber === "3C26")!;
  assert.equal(stand3C26.items.length, 2, "the page-2 item before the next header must still belong to 3C26");
  const stand3C32 = result.stands.find((stand) => stand.standNumber === "3C32")!;
  assert.equal(stand3C32.companyName, "Firma 3C32");
  assert.equal(stand3C32.realizationCompanyRaw, "MAC Praha, spol. s r.o.");
  assert.equal(stand3C32.page, 2);
});

test("O) waste service labels (kontejner/odvoz odpadu) classify as waste, but a wastebasket furniture item does not", () => {
  assert.equal(extractTechnicalMentionsFromCatalogStand(stand({ items: [{ label: "Kontejn 1100 l", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 }] }))[0]?.category, "waste");
  assert.equal(extractTechnicalMentionsFromCatalogStand(stand({ items: [{ label: "Odvoz odpadu", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 }] }))[0]?.category, "waste");
  assert.equal(extractTechnicalMentionsFromCatalogStand(stand({ items: [{ label: "KOŠ ODPADKOVÝ", quantity: 1, unit: "ks", rawQuantityText: "1,0 ks", notes: [], page: 1 }] })).length, 0);
});
