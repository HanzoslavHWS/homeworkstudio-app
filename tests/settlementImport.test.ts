import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import type { RawCellValue, RawSheetRow } from "../domain/priceImport.ts";
import type { PdfTextItem } from "../domain/technicalReportTableParsing.ts";
import { canonicalUnit, parseSettlementQuantity, settlementStandKey, type ParsedAbfOrders } from "../domain/settlementCheck.ts";
import { parseAbfOrdersFromPdfTextItems, parseAbfOrdersFromSheetGrid } from "../domain/settlementAbfOrderImport.ts";
import { inferCreativUnit, isComparableVendorRow, parseCreativExpoWorkbook, type VendorSheetGrid } from "../domain/settlementCreativExpoImport.ts";
import { creativSheet, CREATIV_TEMPLATE as TEMPLATE, readPdfTextItems, readSheets, REAL_FILES } from "./helpers/settlementFixtures.ts";

// =========================================================================================
// Kontrola vyúčtování — import parsers. Two layers:
//   1. synthetic fixtures with the exact structure of the real files (always run);
//   2. the REAL reference files, when present in the git-ignored _IMPORT/vyuctovani_creativ/
//      folder (skipped otherwise, so CI without the business files still passes).
// =========================================================================================

const HAS_REAL = Object.values(REAL_FILES).every((path) => existsSync(path));
const realOnly = { skip: HAS_REAL ? false : "skutečné referenční soubory nejsou v _IMPORT/vyuctovani_creativ/" };

const SUMMARY_SHEET: VendorSheetGrid = {
  name: "SOUHR vše",
  rows: [
    ["Název akce:"],
    ["Beauty podzim 2026 hala 3", "Beauty podzim 2026 hala 3", "Beauty podzim 2026 hala 3"],
    [null],
    ["Celková částka za realizaci expozic od Creativexpa"],
    ["Stánek č.", null, "částka za stánek"],
    ["3A17 Vystavovatel A s.r.o.", null, 1595],
    ["STÁNEK 16", null, null],
    ["Creativexpo - celkem bez DPH", null, 1595],
  ],
};

test("STAND NUMBER: klíč stánku sjednocuje zápis ABF a realizačky, nic nedomýšlí", () => {
  assert.equal(settlementStandKey("3A17"), "3A17");
  assert.equal(settlementStandKey("4C07"), "4C7", "ABF píše úvodní nulu, realizačka ne");
  assert.equal(settlementStandKey("4c7"), "4C7");
  assert.equal(settlementStandKey(" 4 A 04 "), "4A4");
  assert.equal(settlementStandKey("3A38a"), "3A38a", "písmenná přípona zůstává a liší stánky");
  assert.notEqual(settlementStandKey("3A38a"), settlementStandKey("3A38"));
  for (const notAStand of ["13", "ostatní", "4C1-2", "STÁNEK 16", "", "3A", "A17"]) assert.equal(settlementStandKey(notAStand), null, `„${notAStand}“ není jeden stánek`);
});

test("UNITS + QUANTITY: kanonické jednotky a čtení množství", () => {
  assert.equal(canonicalUnit("KS"), "ks");
  assert.equal(canonicalUnit("m²"), "m2");
  assert.equal(canonicalUnit("m2/ak"), "m2");
  assert.equal(canonicalUnit("ks/d"), "ks/den");
  assert.equal(canonicalUnit("bm"), "bm");
  assert.equal(canonicalUnit(""), null);
  assert.deepEqual(parseSettlementQuantity(4.5), { value: 4.5, raw: "4.5", issue: null });
  assert.equal(parseSettlementQuantity("12,5").value, 12.5);
  assert.deepEqual(parseSettlementQuantity(null), { value: null, raw: "", issue: null }, "prázdná buňka není chyba");
  assert.equal(parseSettlementQuantity("dle dohody").value, null);
  assert.ok(parseSettlementQuantity("dle dohody").issue, "nečitelné množství se hlásí, nezahazuje");
});

test("CREATIV UNITS: jednotka se čte z textu položky; nejednoznačné „/1m“ zůstává samostatnou jednotkou", () => {
  assert.deepEqual(inferCreativUnit("koberec šedý Kč/1m2"), { unit: "m2", source: "name" });
  assert.deepEqual(inferCreativUnit("stavba octanorm 1 m2"), { unit: "m2", source: "name" });
  assert.deepEqual(inferCreativUnit("plachta s oky, jednostranný potisk/m2"), { unit: "m2", source: "name" });
  assert.deepEqual(inferCreativUnit("límec, výška 30 cm Kč/bm"), { unit: "bm", source: "name" });
  assert.deepEqual(inferCreativUnit("stěna plná - octanorm (výška 250 cm) - 1 bm"), { unit: "bm", source: "name" });
  assert.deepEqual(inferCreativUnit("stropní podhled bílý Kč/1m"), { unit: "m", source: "name" });
  assert.deepEqual(inferCreativUnit("spacewall/1 m"), { unit: "m", source: "name" });
  assert.deepEqual(inferCreativUnit("zapůjčení TV (40\")/den"), { unit: "ks/den", source: "name" });
  assert.deepEqual(inferCreativUnit("drátěný program/chrom/1x1,5m"), { unit: "ks", source: "default" }, "rozměr v názvu není jednotka");
  assert.deepEqual(inferCreativUnit("židle čalouněná"), { unit: "ks", source: "default" });
});

test("CREATIV: prázdné a nulové množství je šablona — účtované jsou jen vyplněné řádky, originál zůstává celý", () => {
  const parsed = parseCreativExpoWorkbook([SUMMARY_SHEET, creativSheet("3A17", "3A17 Vystavovatel A s.r.o.", { "koberec jiné barvy Kč/1m2": 9, trojzásuvka: 1, "židle čalouněná": 0 })]);
  const sheet = parsed.sheets.find((candidate) => candidate.sheetName === "3A17")!;
  assert.equal(sheet.kind, "stand");
  assert.equal(sheet.standKey, "3A17");
  assert.equal(sheet.exhibitorName, "Vystavovatel A s.r.o.");
  assert.equal(sheet.billedCount, 2);
  assert.deepEqual(sheet.rows.filter((row) => row.isBilled).map((row) => [row.rawName, row.quantity, row.unit]), [["koberec jiné barvy Kč/1m2", 9, "m2"], ["trojzásuvka", 1, "ks"]]);
  assert.equal(sheet.rows.find((row) => row.rawName === "židle čalouněná")!.isBilled, false, "množství 0 není účtovaná položka");
  assert.equal(sheet.rows.length, TEMPLATE.length + 2, "všechny řádky šablony + přirážka + součet jsou uložené jako originál");
  assert.equal(sheet.rows.filter(isComparableVendorRow).length, 2, "do porovnání jdou jen 2 řádky, ne desítky šablonových");
  const surcharge = sheet.rows.find((row) => row.rowKind === "surcharge")!;
  assert.equal(surcharge.isBilled, false, "přirážka bez množství se neúčtuje");
  assert.equal(sheet.rows.find((row) => row.rowKind === "total")!.isBilled, false);
  assert.equal(parsed.eventLabel, "Beauty podzim 2026 hala 3");
  assert.deepEqual(parsed.warnings.filter((warning) => warning.severity === "warning"), []);
});

test("CREATIV: neobvyklé záložky se nepřeskakují ani nedostávají vymyšlené číslo stánku", () => {
  const parsed = parseCreativExpoWorkbook([
    SUMMARY_SHEET,
    creativSheet("3A17", "3A17 Vystavovatel A s.r.o.", { trojzásuvka: 1 }),
    creativSheet("ostatní", "ostatní a doobj.", {}, [["grafika záslepky", 7300, 1, 7300, "za technicke OK"]]),
    creativSheet("4C1-2", "4C1 - 2  soutěž ", { trojzásuvka: 6 }),
    creativSheet("13", null),
    creativSheet("16", "STÁNEK 16"),
    creativSheet("3B9", "3B9 doobj.", { trojzásuvka: 2 }),
    { name: "poznámky", rows: [["volný text bez hlavičky"], ["další řádek", 5]] },
  ]);
  const byName = new Map(parsed.sheets.map((sheet) => [sheet.sheetName, sheet]));

  assert.equal(byName.get("SOUHR vše")!.kind, "summary");
  assert.equal(byName.get("3B9")!.standKey, "3B9", "doobjednávka na záložce se jménem stánku je stánek");

  const other = byName.get("ostatní")!;
  assert.equal(other.kind, "unassigned");
  assert.equal(other.standKey, null);
  assert.equal(other.billedCount, 1);
  assert.equal(other.rows.find((row) => row.isBilled)!.note, "za technicke OK", "poznámka z vedlejšího sloupce se uchová");

  const combined = byName.get("4C1-2")!;
  assert.equal(combined.kind, "unassigned", "záložka pro dva stánky se nezredukuje na první z nich");
  assert.equal(combined.standKey, null);
  assert.match(combined.unassignedReason!, /více stánků/u);

  for (const name of ["13", "16"]) {
    assert.equal(byName.get(name)!.kind, "unassigned");
    assert.equal(byName.get(name)!.standKey, null, `„${name}“ není číslo stánku`);
    assert.match(byName.get(name)!.unassignedReason!, /Nevyplněná šablona/u);
  }
  assert.equal(byName.get("poznámky")!.kind, "unassigned");
  assert.equal(parsed.sheets.length, 8, "žádná záložka nezmizela");

  const codes = parsed.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("vendor_sheet_unassigned"), "záložky s účtovanými položkami bez stánku hlásí upozornění");
  assert.ok(codes.includes("vendor_empty_template_sheets"));
  assert.ok(codes.includes("vendor_sheet_unrecognized"));
  assert.equal(parsed.warnings.filter((warning) => warning.code === "vendor_sheet_unassigned").length, 2, "ostatní + 4C1-2; prázdné šablony upozornění nezahlcují");
});

test("CREATIV: nečitelné množství ani účtovaný řádek bez názvu se neztratí", () => {
  const parsed = parseCreativExpoWorkbook([creativSheet("3A27", "3A27 VYSTAVOVATEL B", { trojzásuvka: "dle dohody", "židle čalouněná": "2 ks" }, [[null, 500, 3, 1500]])]);
  const sheet = parsed.sheets[0]!;
  const unreadable = sheet.rows.find((row) => row.rawName === "trojzásuvka")!;
  assert.equal(unreadable.quantity, null);
  assert.equal(unreadable.isBilled, false);
  assert.ok(unreadable.quantityIssue);
  assert.equal(isComparableVendorRow(unreadable), true, "řádek s nečitelným množstvím jde do porovnání jako nejasný");
  assert.equal(sheet.rows.find((row) => row.rawName === "židle čalouněná")!.quantity, 2, "„2 ks“ se přečte");
  const unnamed = sheet.rows.find((row) => row.rawName === "(bez názvu)")!;
  assert.equal(unnamed.isBilled, true);
  const codes = parsed.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("vendor_quantity_unreadable"));
  assert.ok(codes.includes("vendor_billed_row_without_name"));
});

// --- synthetic ABF report ------------------------------------------------------------------------

function abfRow(cells: Readonly<Record<number, RawCellValue>>): RawSheetRow {
  const row: RawCellValue[] = Array.from({ length: 19 }, () => null);
  for (const [column, value] of Object.entries(cells)) row[Number(column) - 1] = value;
  return row;
}

const ABF_GRID: readonly RawSheetRow[] = [
  abfRow({ 1: "5. Stavby - tisk vše katalog" }),
  abfRow({ 1: "Firma: ABF, a.s." }),
  abfRow({ 2: "  Zakázka: (1): 26V253 FOR BEAUTY 2026 podzim" }),
  abfRow({ 2: "  Realizační firma: (1): '001098 CREATIV EXPO, s.r.o.'" }),
  abfRow({ 1: "Stánek", 5: "Číslo dokladu", 9: "Externí číslo" }),
  abfRow({ 1: "3A17", 6: "V253-206/202" }),
  abfRow({ 1: "VYSTAVOVATEL A s.r.o.", 8: "VYSTAVOVATEL A", 17: "R: CREATIV EXPO, s.r.o." }),
  abfRow({ 1: "Šířka:", 4: "3 m", 6: "Hloubka:", 7: "3 m", 11: "Stavba od ABF:  Ano" }),
  abfRow({ 1: "KOBEREC BAREVNÝ", 14: 9, 15: "m2" }),
  abfRow({ 3: "béžový 4962" }),
  abfRow({ 1: "TROJZÁSUVKA", 14: 1, 15: "ks" }),
  abfRow({ 1: "PARKOVACÍ KARTA - Nepřenosná", 14: 1, 15: "ks" }),
  abfRow({ 1: "PARKOVACÍ KARTA - Nepřenosná", 14: 2, 15: "ks" }),
  abfRow({ 1: "4C07", 6: "V253-75/2026" }),
  abfRow({ 1: "ABF, a.s. - ŠATNA", 8: "ABF, a.s. - ŠATNA", 17: "R: CREATIV EXPO, s.r.o." }),
  abfRow({ 1: "T09 - TYPOVÝ STÁNEK 3X3 m (STAVBA)", 14: 1, 15: "ks" }),
  abfRow({ 1: "LÍMEC - GRAFIKA", 14: 4.5, 15: "ks" }),
  abfRow({ 1: "VENKOVNÍ PLOCHA", 6: "V253-99/2026" }),
  abfRow({ 1: "Venkovní firma s.r.o.", 17: "R: CREATIV EXPO, s.r.o." }),
  abfRow({ 1: "ATYPICKÉ PRVKY", 14: 1, 15: "ks" }),
  abfRow({ 1: "POLOŽKA BEZ MNOŽSTVÍ" }),
  abfRow({ 1: "Výtisk sestavil(a)   Jan Novák", 12: "dne", 13: "12.10.2026", 18: "strana", 19: 1 }),
];

test("ABF XLSX: stánky, vystavovatel, doklad, položky, množství, jednotky, poznámky a duplicitní řádky", () => {
  const parsed = parseAbfOrdersFromSheetGrid(ABF_GRID);
  assert.equal(parsed.title, "5. Stavby - tisk vše katalog");
  assert.equal(parsed.orderLabel, "26V253 FOR BEAUTY 2026 podzim");
  assert.equal(parsed.companyLabel, "001098 CREATIV EXPO, s.r.o.");
  assert.deepEqual(parsed.stands.map((stand) => [stand.standNumberRaw, stand.standKey, stand.documentNumber]), [["3A17", "3A17", "V253-206/202"], ["4C07", "4C7", "V253-75/2026"], ["VENKOVNÍ PLOCHA", null, "V253-99/2026"]]);

  const first = parsed.stands[0]!;
  assert.equal(first.exhibitorName, "VYSTAVOVATEL A s.r.o.");
  assert.equal(first.exhibitorDisplayName, "VYSTAVOVATEL A");
  assert.match(first.dimensionsText!, /Šířka: 3 m/u);
  assert.deepEqual(first.items.map((item) => [item.rawName, item.quantity, item.unitRaw, item.sourceRow]), [
    ["KOBEREC BAREVNÝ", 9, "m2", 9],
    ["TROJZÁSUVKA", 1, "ks", 11],
    ["PARKOVACÍ KARTA - Nepřenosná", 1, "ks", 12],
    ["PARKOVACÍ KARTA - Nepřenosná", 2, "ks", 13],
  ], "dva stejně pojmenované řádky zůstávají dvěma řádky se svým původem");
  assert.equal(first.items[0]!.note, "béžový 4962", "poznámka mezi položkami patří k položce nad ní");

  const second = parsed.stands[1]!;
  assert.equal(second.items[0]!.abfCode, "T09", "kód je jen u typových stánků — přímo v textu položky");
  assert.equal(second.items[1]!.abfCode, null);
  assert.equal(second.items[1]!.quantity, 4.5);
});

test("ABF XLSX: nic se tiše nezahodí — stánek bez čitelného čísla i položka bez množství zůstávají", () => {
  const parsed = parseAbfOrdersFromSheetGrid(ABF_GRID);
  const odd = parsed.stands[2]!;
  assert.equal(odd.standKey, null);
  assert.equal(odd.exhibitorName, "Venkovní firma s.r.o.");
  assert.deepEqual(odd.items.map((item) => [item.rawName, item.quantity, Boolean(item.quantityIssue)]), [["ATYPICKÉ PRVKY", 1, false], ["POLOŽKA BEZ MNOŽSTVÍ", null, true]]);
  const codes = parsed.warnings.map((warning) => warning.code);
  assert.ok(codes.includes("abf_stand_number_unreadable"));
  assert.ok(codes.includes("abf_item_without_quantity"));
  assert.equal(parsed.stands.reduce((sum, stand) => sum + stand.items.length, 0), 8, "8 položkových řádků ve fixture = 8 importovaných položek");
  assert.ok(parseAbfOrdersFromSheetGrid([]).warnings.some((warning) => warning.code === "abf_no_stands"));
});

/** One PDF line: text runs at x positions, like pdf.js returns them. */
function pdfLine(page: number, y: number, runs: readonly (readonly [number, string])[]): PdfTextItem[] {
  return runs.map(([x, str]) => ({ str, page, x, y, width: str.length * 4, height: 8 }));
}

test("ABF PDF: stánek pokračující přes dvě strany, opakovaná hlavička, zápatí, poznámky a vystavovatel začínající číslicí", () => {
  const items: PdfTextItem[] = [
    ...pdfLine(1, 803, [[28, "5. Stavby - tisk vše katalog"]]),
    ...pdfLine(1, 757, [[34, "Zakázka: (1): 26V253 FOR BEAUTY 2026 podzim"]]),
    ...pdfLine(1, 720, [[28, "Stánek"], [113, "Číslo dokladu"], [198, "Externí číslo"]]),
    ...pdfLine(1, 691, [[28, "3B38"], [116, "V253-15/2026"]]),
    ...pdfLine(1, 677, [[28, "4 BEAUTY s.r.o."], [187, "4 Beauty Lab"], [326, "R: CREATIV EXPO, s.r.o."]]),
    ...pdfLine(1, 663, [[28, "Šířka:"], [54, "4 m"], [116, "Hloubka:"], [156, "3 m"], [224, "Stavba od ABF: Ano"]]),
    ...pdfLine(1, 652, [[28, "PLOCHA ŘADOVÁ"], [239, "12,0"], [258, "m2"]]),
    ...pdfLine(1, 641, [[28, "T12 - TYPOVÝ STÁNEK 4X3 m (STAVBA)"], [244, "1,0 ks"]]),
    ...pdfLine(1, 629, [[45, "8.7. zaslán email - zatím žádná odpověď"]]),
    ...pdfLine(1, 56, [[28, "3A27"], [116, "V253-31/2026"]]),
    ...pdfLine(1, 33, [[28, "Výtisk sestavil(a)"], [95, "Jan Novák"], [487, "strana"], [518, "1"]]),
    ...pdfLine(2, 806, [[28, "Stánek"], [113, "Číslo dokladu"], [198, "Externí číslo"]]),
    ...pdfLine(2, 795, [[28, "Vystavovatel B, a.s."], [187, "Vystavovatel B, a.s."], [326, "R: CREATIV EXPO, s.r.o."]]),
    ...pdfLine(2, 770, [[28, "STAVBA STÁNKU - OCTANORM"], [244, "4,5 m2"]]),
    ...pdfLine(2, 758, [[45, "SOK"]]),
    ...pdfLine(2, 746, [[28, "TV (55\") pronájem - vč. držáku na stěnu / den"], [244, "2,0 ks/d"]]),
    ...pdfLine(2, 33, [[28, "Výtisk sestavil(a)"], [487, "strana"], [518, "2"]]),
  ];
  // Fed in a scrambled order on purpose: the parser must rebuild lines from coordinates only.
  const parsed = parseAbfOrdersFromPdfTextItems([...items].reverse());

  assert.equal(parsed.orderLabel, "26V253 FOR BEAUTY 2026 podzim");
  assert.deepEqual(parsed.stands.map((stand) => [stand.standKey, stand.documentNumber, stand.exhibitorName, stand.sourcePage]), [
    ["3B38", "V253-15/2026", "4 BEAUTY s.r.o.", 1],
    ["3A27", "V253-31/2026", "Vystavovatel B, a.s.", 1],
  ]);
  assert.equal(parsed.stands[0]!.exhibitorDisplayName, "4 Beauty Lab", "název začínající číslicí se nečte jako množství");
  assert.deepEqual(parsed.stands[0]!.items.map((item) => [item.rawName, item.quantity, item.unitRaw, item.abfCode]), [["PLOCHA ŘADOVÁ", 12, "m2", null], ["T12 - TYPOVÝ STÁNEK 4X3 m (STAVBA)", 1, "ks", "T12"]]);
  assert.equal(parsed.stands[0]!.items[1]!.note, "8.7. zaslán email - zatím žádná odpověď");
  assert.deepEqual(parsed.stands[1]!.items.map((item) => [item.rawName, item.quantity, item.unitRaw, item.sourcePage]), [
    ["STAVBA STÁNKU - OCTANORM", 4.5, "m2", 2],
    ["TV (55\") pronájem - vč. držáku na stěnu / den", 2, "ks/d", 2],
  ], "položky ze druhé strany patří stánku, jehož hlavička byla na konci první strany");
  assert.equal(parsed.stands[1]!.items[0]!.note, "SOK");
  assert.deepEqual(parsed.warnings.filter((warning) => warning.severity === "warning"), []);
});

test("ABF PDF: PDF bez textové vrstvy vrátí srozumitelné upozornění, ne prázdný úspěch", () => {
  const parsed = parseAbfOrdersFromPdfTextItems([]);
  assert.equal(parsed.stands.length, 0);
  assert.equal(parsed.warnings[0]!.code, "abf_pdf_no_text_layer");
});

// --- REAL reference files --------------------------------------------------------------------------

test("REAL Creativ hala 3: skutečná struktura — 13 stánků, „ostatní“ a 18 nevyplněných šablon mezi nepřiřazenými", realOnly, async () => {
  const parsed = parseCreativExpoWorkbook(await readSheets(REAL_FILES.hall3));
  const stands = parsed.sheets.filter((sheet) => sheet.kind === "stand");
  assert.deepEqual(stands.map((sheet) => sheet.standKey), ["3A17", "3A27", "3A28", "3A45", "3A38a", "3B10", "3B18", "3B24", "3B29", "3B31", "3B38", "3B30", "3B9"]);
  assert.equal(parsed.sheets.filter((sheet) => sheet.kind === "summary").length, 1);

  const unassigned = parsed.sheets.filter((sheet) => sheet.kind === "unassigned");
  assert.deepEqual(unassigned.filter((sheet) => sheet.billedCount > 0).map((sheet) => [sheet.sheetName, sheet.billedCount]), [["ostatní", 15]]);
  assert.deepEqual(unassigned.filter((sheet) => sheet.billedCount === 0).map((sheet) => sheet.sheetName), ["13", "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26", "27", "28", "29", "30", "31", "32"]);
  assert.ok(unassigned.every((sheet) => sheet.standKey === null), "žádné fiktivní číslo stánku");

  const lefeen = stands[0]!;
  assert.match(lefeen.title!, /^3A17 \S/u, "nadpis = číslo stánku + vystavovatel");
  assert.deepEqual(lefeen.rows.filter((row) => row.isBilled).map((row) => [row.rawName, row.quantity, row.unit, row.sourceRow]), [["koberec jiné barvy Kč/1m2", 9, "m2", 20], ["trojzásuvka", 1, "ks", 36]]);
  assert.ok(lefeen.rows.length > 80, "celá šablona je uložená jako originál");

  const billed = parsed.sheets.reduce((sum, sheet) => sum + sheet.billedCount, 0);
  const stored = parsed.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0);
  assert.equal(billed, 108);
  assert.ok(stored > 2500 && billed / stored < 0.05, `účtovaných je ${billed} z ${stored} uložených řádků — šablona nevytváří falešné položky`);
  assert.deepEqual(parsed.warnings.filter((warning) => warning.severity === "warning").map((warning) => warning.code), ["vendor_sheet_unassigned"]);
});

test("REAL Creativ hala 4: „4C1-2“ je záložka pro dva stánky — zůstává nepřiřazená; „4c7 šatna“ je stánek 4C7", realOnly, async () => {
  const parsed = parseCreativExpoWorkbook(await readSheets(REAL_FILES.hall4));
  const byName = new Map(parsed.sheets.map((sheet) => [sheet.sheetName, sheet]));
  assert.equal(parsed.sheets.filter((sheet) => sheet.kind === "stand").length, 25);
  assert.equal(byName.get("4C1-2")!.kind, "unassigned");
  assert.equal(byName.get("4C1-2")!.billedCount, 12);
  assert.equal(byName.get("4C7")!.standKey, "4C7");
  assert.equal(byName.get("4C7")!.title, "4c7 šatna");
  assert.equal(byName.get("4C3")!.standKey, "4C3", "nadpis „soutěž 4C3“ nezačíná číslem — rozhoduje název záložky");
  assert.equal(byName.get("ostatní")!.kind, "unassigned");
});

function comparableShape(parsed: ParsedAbfOrders) {
  return parsed.stands.map((stand) => ({
    standKey: stand.standKey,
    exhibitor: stand.exhibitorName,
    items: stand.items.map((item) => `${item.rawName.replace(/\s+/gu, " ").trim()}|${item.quantity}|${item.unitRaw}|${item.note ?? ""}`),
  }));
}

test("REAL ABF: XLSX a PDF téže sestavy dávají stejné stánky, položky, množství, jednotky i poznámky", realOnly, async () => {
  const sheets = await readSheets(REAL_FILES.abfXlsx);
  const fromXlsx = parseAbfOrdersFromSheetGrid(sheets[0]!.rows);
  const fromPdf = parseAbfOrdersFromPdfTextItems(await readPdfTextItems(REAL_FILES.abfPdf));

  assert.equal(fromXlsx.stands.length, 42);
  assert.equal(fromXlsx.stands.reduce((sum, stand) => sum + stand.items.length, 0), 485);
  assert.equal(fromXlsx.orderLabel, "26V253 FOR BEAUTY 2026 podzim");
  assert.equal(fromXlsx.companyLabel, "001098 CREATIV EXPO, s.r.o.");
  assert.ok(fromXlsx.stands.every((stand) => stand.standKey && stand.documentNumber && stand.exhibitorName), "každý stánek má číslo, doklad a vystavovatele");
  assert.ok(fromXlsx.stands.every((stand) => stand.items.every((item) => item.quantity !== null && item.unitRaw)), "každá položka má množství a jednotku");
  assert.deepEqual(fromXlsx.warnings.filter((warning) => warning.severity === "warning"), []);
  assert.equal(fromXlsx.stands.find((stand) => stand.standNumberRaw === "4C07")!.standKey, "4C7");

  // The PDF was exported on another day in another stand order — compare stand by stand.
  const byKey = (parsed: ParsedAbfOrders) => new Map(comparableShape(parsed).map((stand) => [stand.standKey, stand]));
  const xlsx = byKey(fromXlsx);
  const pdf = byKey(fromPdf);
  assert.deepEqual([...pdf.keys()].sort(), [...xlsx.keys()].sort());
  for (const [key, stand] of xlsx) {
    assert.deepEqual(pdf.get(key)!.items, stand.items, `položky stánku ${key}`);
    assert.ok(pdf.get(key)!.exhibitor!.startsWith(stand.exhibitor!.slice(0, 20)), `vystavovatel stánku ${key}`);
  }
  const lefeenPdf = fromPdf.stands.find((stand) => stand.standKey === "3A17")!;
  // The report itself cuts a document number at 12 characters — in both formats.
  assert.equal(lefeenPdf.documentNumber, "V253-206/202");
  assert.equal(fromXlsx.stands[0]!.documentNumber, "V253-206/202");
  assert.deepEqual(fromPdf.warnings.filter((warning) => warning.severity === "warning"), []);
});
