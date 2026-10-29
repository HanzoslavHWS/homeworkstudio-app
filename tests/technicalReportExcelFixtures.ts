import type ExcelJS from "exceljs";
import type { TechnicalWorkbookCell, TechnicalWorkbookSheet } from "../domain/technicalReportWorkbook.ts";

// =========================================================================================
// Technické rastry — Excel import fixtures. Each layout reproduces the EXACT cell addresses of a
// real ABRA "Přehled - …" .xlsx export (FOR BEAUTY 2026 samples, analysed 29. 10. 2026): front
// matter, stacked header rows, header cells that sit in a different column than their values,
// group/subtotal/footer rows, a wrapped "Celkem" line, a row without a stand number. Company
// names, the order number and people are ANONYMIZED, and each report is shortened to a few
// stands — the real exports are never committed (the repository is public).
// =========================================================================================

export type CellLayout = Readonly<Record<string, string | number>>;

const FRONT_MATTER = (title: string, expression: string): CellLayout => ({
  A1: title,
  A2: "Firma: ABF, a.s.",
  A3: "Výběrové podmínky pro sestavení tisku",
  B4: "  Zakázka: (1): 26V000 TESTOVACÍ VELETRH 2026 [dotázat se]",
  B5: `  Výraz: ${expression}`,
  B6: "  Včetně revizí: Ne",
  // Contains the word "stánku" — must never be mistaken for the column header.
  B7: "  Třídění: +Skutečné umístění stánku, +Umístění stánku, +Název firmy",
});

const FOOTER = (row: number, pageColumn: string, pageNumberColumn: string): CellLayout => ({
  [`A${row}`]: "Výtisk sestavil(a)   Jan Novák",
  [`F${row}`]: "dne",
  [`G${row}`]: "29.10.2026",
  [`${pageColumn}${row}`]: "strana",
  [`${pageNumberColumn}${row}`]: 1,
});

/** Voda, odpad, bazény — the complete real layout (3 stands). Headers I/J/L, values H/J/K. */
export const WATER_LAYOUT: CellLayout = {
  ...FRONT_MATTER("Přehled - voda, odpad, bazény", "VO Voda, odpady, bazény"),
  A8: "Číslo stánku", D8: "Firma", I8: "Voda, ", J8: "Bazén - ", L8: "Bazén - ",
  I9: "odpad", J9: "přípojka", L9: "objem",
  A10: "** Sekce: 3A",
  C11: "3A03", E11: "Firma Alfa s.r.o.", H11: 1, J11: 0, K11: 0,
  C12: "3A11", E12: "Firma Beta s.r.o.", H12: 0, J12: 1, K12: 1,
  C13: "3A45", E13: "Firma Gama s.r.o.", H13: 1, J13: 0, K13: 0,
  A14: "** Mezisoučet: ", H14: 2, J14: 1, K14: 1,
  A15: "Celkem: ", H15: 2, J15: 1, K15: 1,
  ...FOOTER(16, "M", "N"),
};

/**
 * Úklid — the real top of the report: an empty "** Hala: " group whose only row has a quantity
 * but NO stand number, followed by a free-text note; then regular stands. Headers J/L, values I/L.
 * "Celkem" counts the row without a stand too (18 + 8 + 24 = 50).
 */
export const CLEANING_LAYOUT: CellLayout = {
  ...FRONT_MATTER("Přehled - úklid", "UK Úklid"),
  A8: "Číslo stánku", D8: "Firma", J8: "Denní úklid", L8: "Generální úklid",
  A9: "** Hala: ",
  E10: "Pořadatel - propagace", I10: 18, L10: 0,
  H11: "doobjednávka úklidu",
  A12: "** Mezisoučet: ", I12: 18, L12: 0,
  A13: "** Hala: 3",
  C14: "3A02", E14: "Firma Alfa s.r.o.", I14: 8, L14: 0,
  C15: "3B01", E15: "Firma Beta s.r.o.", I15: 0, L15: 15,
  C16: "3C01", E16: "Firma Gama s.r.o.", I16: 24, L16: 0,
  A17: "** Mezisoučet: ", I17: 32, L17: 15,
  A18: "Celkem: ", I18: 50, L18: 15,
  ...FOOTER(19, "K", "M"),
};

/**
 * Internet, WiFi — THREE stacked header rows ("Pevná IP"/"Internet"/"WIFI" staggered onto row 10)
 * and the real quirk of the totals line: the "WIFI" total is printed in O although its values are
 * in N. Headers H K L P Q S U W, values I J M N R T V Y.
 */
export const INTERNET_LAYOUT: CellLayout = {
  ...FRONT_MATTER("Přehled - internet, WiFi", "INT internet"),
  A8: "Číslo stánku", E8: "Firma", L8: "Další ", Q8: "Další WIFI ", S8: "RJ 2 ", U8: "WIFI 2 ", W8: "Router ",
  L9: "přípojka", Q9: "přípojka", S9: "EEt", U9: "EEt", W9: "zapůjčení",
  H10: "Pevná IP", K10: "Internet", P10: "WIFI",
  A11: "** Sekce: 3A",
  C12: "3A21", D12: "Firma Alfa a.s.", I12: 0, J12: 0, M12: 0, N12: 1, R12: 0, T12: 0, V12: 0, Y12: 0,
  C13: "3A45", D13: "Firma Beta spol. s r.o.", I13: 1, J13: 1, M13: 0, N13: 0, R13: 0, T13: 0, V13: 0, Y13: 1,
  A14: "** Mezisoučet: ", I14: 1, J14: 1, M14: 0, N14: 1, R14: 0, T14: 0, V14: 0, Y14: 1,
  A15: "** Sekce: 4A",
  C16: "4A19", D16: "Firma  Gama  s.r.o.", I16: 0, J16: 1, M16: 1, N16: 0, R16: 0, T16: 0, V16: 0, Y16: 0,
  A17: "** Mezisoučet: ", I17: 0, J17: 1, M17: 1, N17: 0, R17: 0, T17: 0, V17: 0, Y17: 0,
  A18: "Celkem: ", I18: 1, J18: 2, M18: 1, O18: 1, R18: 0, T18: 0, V18: 0, Y18: 1,
  ...FOOTER(19, "V", "X"),
};

const ELECTRICITY_VALUE_COLUMNS = ["I", "K", "M", "N", "O", "Q", "S", "U", "X", "Z", "AA", "AC", "AD", "AE", "AG", "AI", "AJ"] as const;

function electricityRow(row: number, stand: string, company: string, ordered: Partial<Record<(typeof ELECTRICITY_VALUE_COLUMNS)[number], number>>): CellLayout {
  const cells: Record<string, string | number> = { [`D${row}`]: stand, [`F${row}`]: company };
  for (const column of ELECTRICITY_VALUE_COLUMNS) cells[`${column}${row}`] = ordered[column] ?? 0;
  return cells;
}

/**
 * Elektrická energie — 17 services over two header rows; value column O sits exactly between
 * headers N ("Do 3kW") and P ("Do 5kW"), so only the ORDER identifies it. Hall/sector group rows,
 * and the real wrapped "Celkem": its first 8 totals sit in an unlabeled row above "Celkem: ".
 */
export const ELECTRICITY_LAYOUT: CellLayout = {
  ...FRONT_MATTER("Přehled - elektrická energie", "EN Energie"),
  A8: "Stánek", E8: "Firma", I8: "Rozvaděč", L8: "EET ", M8: "Do 2kW ", N8: "Do 3kW ", P8: "Do 5kW ", R8: "Do 6kW ", T8: "Do 9kW ",
  V8: "Do 15kW ", X8: "Do 21kW ", Z8: "Do 40kW ", AA8: "+ kW", AB8: "Lednicový", AD8: "Vrchní ", AF8: "Jistič ", AH8: "Jistič ", AI8: "Osvětlení", AJ8: "Non stop",
  I9: "9-21kW", L9: "0.5KW", M9: "230V", N9: "230V", P9: "230V", R9: "230V", T9: "400V", V9: "400V", X9: "400V", Z9: "400V", AB9: "okruh", AD9: "přívod", AF9: "C", AH9: "D",
  A10: "HALA 3",
  C11: "**  SEKTOR 3A",
  ...electricityRow(12, "3A01", "Firma Alfa", { Q: 1, AE: 1 }),
  ...electricityRow(13, "3A02", "Firma Beta z.s.", {}),
  ...electricityRow(14, "3A03", "Firma Gama s.r.o.", { O: 1 }),
  C15: "**  Mezisoučet SEKTOR 3A", ...Object.fromEntries(ELECTRICITY_VALUE_COLUMNS.map((column) => [`${column}15`, { Q: 1, AE: 1, O: 1 }[column as string] ?? 0])),
  A16: "Mezisoučet HALA 3", ...Object.fromEntries(ELECTRICITY_VALUE_COLUMNS.map((column) => [`${column}16`, { Q: 1, AE: 1, O: 1 }[column as string] ?? 0])),
  A17: "HALA 4",
  C18: "**  SEKTOR 4C",
  ...electricityRow(19, "4C06", "Firma Delta - HLAVNÍ PODIUM", { I: 2, X: 2, Z: 1, AG: 1 }),
  C20: "**  Mezisoučet SEKTOR 4C", ...Object.fromEntries(ELECTRICITY_VALUE_COLUMNS.map((column) => [`${column}20`, { I: 2, X: 2, Z: 1, AG: 1 }[column as string] ?? 0])),
  I21: 2, K21: 0, M21: 0, N21: 0, O21: 1, Q21: 1, S21: 0, U21: 0,
  A22: "Celkem: ", X22: 2, Z22: 1, AA22: 0, AC22: 0, AD22: 0, AE22: 1, AG22: 1, AI22: 0, AJ22: 0,
  A23: "Výtisk sestavil(a)   Jan Novák", H23: "dne", J23: "29.10.2026", W23: "strana", Y23: 1,
};

function columnNumber(letters: string): number {
  return [...letters].reduce((sum, char) => sum * 26 + char.charCodeAt(0) - 64, 0);
}

function parseAddress(address: string): Readonly<{ row: number; column: number }> {
  const match = address.match(/^([A-Z]+)(\d+)$/u);
  if (!match) throw new Error(`Bad address ${address}`);
  return { row: Number(match[2]), column: columnNumber(match[1]!) };
}

/** Layout → the library-free sheet model, typed exactly like the exceljs reader types the real file (strings are text cells, numbers are number cells). */
export function layoutToSheet(layout: CellLayout, overrides: Partial<TechnicalWorkbookSheet> = {}, extraCells: Readonly<Record<string, TechnicalWorkbookCell>> = {}): TechnicalWorkbookSheet {
  const rows: TechnicalWorkbookCell[][] = [];
  const put = (address: string, cell: TechnicalWorkbookCell) => {
    const { row, column } = parseAddress(address);
    while (rows.length < row) rows.push([]);
    const target = rows[row - 1]!;
    while (target.length < column) target.push({ kind: "empty" });
    target[column - 1] = cell;
  };
  for (const [address, value] of Object.entries(layout)) put(address, typeof value === "number" ? { kind: "number", value } : { kind: "text", value });
  for (const [address, cell] of Object.entries(extraCells)) put(address, cell);
  return { name: "List1", position: 1, visibility: "visible", rows, hiddenRowNumbers: [], hiddenColumnNumbers: [], mergedRanges: [], ...overrides };
}

/** Writes a layout into an exceljs worksheet — for the reader/route tests that go through a real .xlsx buffer. */
export function writeLayout(worksheet: ExcelJS.Worksheet, layout: CellLayout): void {
  for (const [address, value] of Object.entries(layout)) worksheet.getCell(address).value = value;
}
