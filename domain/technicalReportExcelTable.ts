/**
 * Technické rastry — an ABRA "Přehled - …" technical report exported to Excel (.xlsx) becomes the
 * SAME GenericTableParseResult the PDF path reconstructs from positioned text, so both formats end
 * in buildParsedTechnicalReportFromTable → identical ParsedTechnicalReport → identical product
 * matching and merge. Pure: reads the library-free TechnicalWorkbook model only.
 *
 * Real structure (FOR BEAUTY 2026 samples: elektřina, internet, voda, úklid — one sheet "List1"):
 *  - front matter (title, "Firma:", "Zakázka:", "Výraz:", "Třídění:") above the header;
 *  - header anchored by a "Stánek" / "Číslo stánku" cell, 1–3 stacked header rows
 *    ("Do 2kW " above "230V"; internet staggers "Pevná IP"/"Internet"/"WIFI" onto a third row);
 *  - stand rows: stand number (column C or D), company, then one NUMBER cell per service;
 *  - group/subtotal/footer rows ("** Sekce: 3A", "HALA 3", "** Mezisoučet: ", "Celkem: ",
 *    "Výtisk sestavil(a)…") and occasional free-text note rows / rows without a stand number.
 *
 * The export keeps the report's print layout, so a header cell and its values are often NOT in the
 * same Excel column (water: headers I/J/L, values H/J/K; electricity: value O sits exactly between
 * headers N and P). Nearest-column matching would therefore guess. What IS stable is the ORDER:
 * every sample has exactly as many value columns as service headers, in the same left-to-right
 * order, and pairing them by order reproduces the PDF import stand-for-stand. So headers and value
 * columns are paired by order — and only when their counts agree; otherwise nothing is imported
 * and the mismatch is reported (never a guessed column).
 */
import {
  auditTechnicalWorkbook,
  cellAddress,
  columnLetters,
  technicalWorkbookCellRawText,
  type TechnicalWorkbook,
  type TechnicalWorkbookCell,
  type TechnicalWorkbookSheet,
} from "./technicalReportWorkbook.ts";
import {
  isNonStandReportLine,
  looksLikeStandNumberToken,
  type GenericTableParseResult,
  type ParsedStandTableNote,
  type ParsedStandTableRow,
  type ParsedTableWarning,
} from "./technicalReportTableParsing.ts";
import { buildParsedTechnicalReportFromTable } from "./technicalReportParsers/technicalReportParser.ts";
import type { ParsedTechnicalReport } from "./technicalRaster.ts";

/** One service column: the header label (exactly as the PDF import builds it) and where its header and its values sit. */
export type TechnicalExcelColumnMapping = Readonly<{ label: string; headerColumn: string; valueColumn: string }>;

export type TechnicalExcelTotalsCheck =
  | Readonly<{ status: "match" }>
  | Readonly<{ status: "mismatch"; differences: readonly Readonly<{ label: string; expected: number; actual: number }>[] }>
  | Readonly<{ status: "unverifiable"; reason: string }>
  | Readonly<{ status: "missing" }>;

/** The control report shown next to the import preview — what was read from where, and whether the sums agree with the report's own "Celkem" row. */
export type TechnicalExcelImportCheck = Readonly<{
  sheetName: string;
  headerRowNumbers: readonly number[];
  columns: readonly TechnicalExcelColumnMapping[];
  standRowCount: number;
  noteCount: number;
  /** Rows carrying quantities but no stand number — reported, never imported. */
  rowsWithoutStandCount: number;
  totals: TechnicalExcelTotalsCheck;
}>;

export type TechnicalExcelTableResult = Readonly<{
  table: GenericTableParseResult;
  /** Absent when no sheet with a stand header was found. */
  check?: TechnicalExcelImportCheck;
  /** Title/front-matter text of the chosen sheet — input for the category autodetection hint only. */
  titleText: string;
}>;

const STAND_HEADER_LABELS: ReadonlySet<string> = new Set(["stánek", "číslo stánku"]);
const MAX_HEADER_ROWS = 5;
/** Largest header→value column offset seen in the real samples is 2; more than this is reported as suspicious. */
const MAX_EXPECTED_HEADER_VALUE_OFFSET = 3;

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function cellText(cell: TechnicalWorkbookCell | undefined): string | undefined {
  return cell?.kind === "text" ? collapseWhitespace(cell.value) || undefined : undefined;
}

function hasContent(cell: TechnicalWorkbookCell): boolean {
  return cell.kind !== "empty" && cell.kind !== "mergedContinuation";
}

function rowLabelText(row: readonly TechnicalWorkbookCell[]): string {
  return row.map(cellText).filter(Boolean).join(" ");
}

function rowNumberColumns(row: readonly TechnicalWorkbookCell[], afterColumn: number): number[] {
  const columns: number[] = [];
  row.forEach((cell, index) => {
    if (index + 1 > afterColumn && cell.kind === "number") columns.push(index + 1);
  });
  return columns;
}

function firstContentColumn(row: readonly TechnicalWorkbookCell[]): number | undefined {
  const index = row.findIndex(hasContent);
  return index === -1 ? undefined : index + 1;
}

function standNumberOf(row: readonly TechnicalWorkbookCell[]): Readonly<{ standNumber: string; column: number }> | undefined {
  const column = firstContentColumn(row);
  if (column === undefined) return undefined;
  const text = cellText(row[column - 1]);
  if (!text) return undefined;
  const compact = text.replace(/\s+/gu, "");
  return looksLikeStandNumberToken(compact) ? { standNumber: compact, column } : undefined;
}

function rowRawText(rowNumber: number, row: readonly TechnicalWorkbookCell[]): string {
  const parts = row.map((cell) => {
    const text = technicalWorkbookCellRawText(cell);
    return text.ok ? collapseWhitespace(text.text) : "?";
  });
  return `řádek ${rowNumber}: ${parts.filter((part, index) => part && hasContent(row[index]!)).join(" ")}`;
}

function findHeaderRowIndex(sheet: TechnicalWorkbookSheet): Readonly<{ rowIndex: number; anchorColumn: number }> | undefined {
  for (let rowIndex = 0; rowIndex < sheet.rows.length; rowIndex += 1) {
    const row = sheet.rows[rowIndex]!;
    const columnIndex = row.findIndex((cell) => {
      const text = cellText(cell);
      return text !== undefined && STAND_HEADER_LABELS.has(text.replace(/:$/u, "").toLocaleLowerCase("cs"));
    });
    if (columnIndex !== -1) return { rowIndex, anchorColumn: columnIndex + 1 };
  }
  return undefined;
}

function sheetPrefix(sheet: TechnicalWorkbookSheet, rowNumber?: number): string {
  return rowNumber === undefined ? `List „${sheet.name}“` : `List „${sheet.name}“, řádek ${rowNumber}`;
}

/** Merged-range strings ("B2:D2") whose bottom row reaches into the data area — header merges are harmless, a merged stand/value cell is not. */
function mergedRangeTouchesRows(range: string, fromRowNumber: number): boolean {
  const bottom = Number(range.split(":")[1]?.match(/\d+$/u)?.[0] ?? range.match(/\d+$/u)?.[0] ?? 0);
  return bottom >= fromRowNumber;
}

type StandRowDraft = { rowNumber: number; standNumber: string; standColumn: number; row: readonly TechnicalWorkbookCell[] };
type QuantityRowDraft = { rowNumber: number; label: string; row: readonly TechnicalWorkbookCell[] };

/**
 * Turns the report sheet of a technical-report workbook into the shared stand table. Every
 * problem becomes a warning with the sheet name and row/cell address; nothing is dropped silently.
 */
export function buildTechnicalStandTableFromWorkbook(workbook: TechnicalWorkbook): TechnicalExcelTableResult {
  const warnings: ParsedTableWarning[] = [];
  const empty = (titleText = ""): TechnicalExcelTableResult => ({ table: { rows: [], notes: [], warnings, headerFound: false }, titleText });

  if (workbook.sheets.length === 0) {
    warnings.push({ message: "Soubor Excel neobsahuje žádný list." });
    return empty();
  }

  const candidates = workbook.sheets
    .map((sheet) => ({ sheet, header: findHeaderRowIndex(sheet) }))
    .filter((candidate): candidate is { sheet: TechnicalWorkbookSheet; header: NonNullable<ReturnType<typeof findHeaderRowIndex>> } => candidate.header !== undefined);
  const chosen = candidates.find((candidate) => candidate.sheet.visibility === "visible") ?? candidates[0];
  if (!chosen) {
    warnings.push({ message: "V souboru Excel nebyla nalezena hlavička výjezdu (buňka „Stánek“ nebo „Číslo stánku“) — soubor nevypadá jako přehled technických služeb z ABRA." });
    return empty();
  }
  const { sheet, header } = chosen;
  if (sheet.visibility !== "visible") warnings.push({ message: `${sheetPrefix(sheet)} je skrytý, přesto byl použit — žádný viditelný list s hlavičkou výjezdu nebyl nalezen.` });
  for (const other of workbook.sheets) {
    if (other !== sheet && other.rows.some((row) => row.some(hasContent))) {
      warnings.push({ message: `${sheetPrefix(other)} obsahuje data, ale nebyl importován — import čte jen list „${sheet.name}“.` });
    }
  }

  const titleText = sheet.rows.slice(0, header.rowIndex).map(rowLabelText).filter(Boolean).join(" ");

  // ---- Header block: the anchor row plus the stacked rows below it, up to the first data/group row.
  let headerEnd = header.rowIndex + 1;
  while (headerEnd < sheet.rows.length && headerEnd - header.rowIndex < MAX_HEADER_ROWS) {
    const row = sheet.rows[headerEnd]!;
    const label = rowLabelText(row);
    if (row.some((cell) => cell.kind === "number") || standNumberOf(row) || (label && isNonStandReportLine(label))) break;
    headerEnd += 1;
  }
  const headerTexts = new Map<number, string[]>();
  for (let rowIndex = header.rowIndex; rowIndex < headerEnd; rowIndex += 1) {
    sheet.rows[rowIndex]!.forEach((cell, columnIndex) => {
      const text = cellText(cell);
      if (text) headerTexts.set(columnIndex + 1, [...(headerTexts.get(columnIndex + 1) ?? []), text]);
      else if (!technicalWorkbookCellRawText(cell).ok) {
        warnings.push({ message: `${sheetPrefix(sheet, rowIndex + 1)}: buňka hlavičky ${cellAddress(rowIndex + 1, columnIndex + 1)} nemá čitelnou hodnotu.` });
      }
    });
  }
  const headerColumns = [...headerTexts.entries()]
    .map(([column, parts]) => ({ column, label: collapseWhitespace(parts.join(" ")) }))
    .sort((a, b) => a.column - b.column);
  const companyHeaderColumn = headerColumns.find((entry) => entry.label.toLocaleLowerCase("cs") === "firma")?.column;
  const serviceHeaders = headerColumns.filter((entry) => entry.column > (companyHeaderColumn ?? header.anchorColumn));
  const headerRowNumbers = Array.from({ length: headerEnd - header.rowIndex }, (_, offset) => header.rowIndex + 1 + offset);

  // ---- Pass 1: classify every row below the header.
  const standRows: StandRowDraft[] = [];
  const rowsWithoutStand: QuantityRowDraft[] = [];
  const notes: ParsedStandTableNote[] = [];
  let lastContext: Readonly<{ kind: "stand"; standNumber: string }> | Readonly<{ kind: "rowWithoutStand"; rowNumber: number }> | undefined;
  let totalsRows: { rowNumber: number; row: readonly TechnicalWorkbookCell[] }[] | undefined;
  let unlabeledNumericRows: { rowNumber: number; row: readonly TechnicalWorkbookCell[] }[] = [];

  const flushUnlabeledNumericRows = () => {
    for (const unlabeled of unlabeledNumericRows) {
      if (unlabeled.row.some((cell) => cell.kind === "number" && cell.value !== 0)) {
        warnings.push({ message: `${sheetPrefix(sheet, unlabeled.rowNumber)}: řádek obsahuje čísla bez popisu a bez čísla stánku — nebyl importován.`, rawText: rowRawText(unlabeled.rowNumber, unlabeled.row) });
      }
    }
    unlabeledNumericRows = [];
  };

  for (let rowIndex = headerEnd; rowIndex < sheet.rows.length; rowIndex += 1) {
    const row = sheet.rows[rowIndex]!;
    const rowNumber = rowIndex + 1;
    if (!row.some(hasContent)) continue;
    const label = rowLabelText(row);
    const hasNumbers = row.some((cell) => cell.kind === "number");

    if (hasNumbers && !label) {
      // ABRA wraps a long "Celkem" line: the first half of the totals lands in an unlabeled row right above it.
      unlabeledNumericRows.push({ rowNumber, row });
      continue;
    }
    if (label && /^celkem\b/iu.test(label) && hasNumbers) {
      totalsRows = [...unlabeledNumericRows, { rowNumber, row }];
      unlabeledNumericRows = [];
      continue;
    }
    flushUnlabeledNumericRows();

    const stand = standNumberOf(row);
    if (stand) {
      standRows.push({ rowNumber, standNumber: stand.standNumber, standColumn: stand.column, row });
      lastContext = { kind: "stand", standNumber: stand.standNumber };
      continue;
    }
    if (label && isNonStandReportLine(label)) continue;
    if (hasNumbers) {
      rowsWithoutStand.push({ rowNumber, label, row });
      lastContext = { kind: "rowWithoutStand", rowNumber };
      continue;
    }
    if (!label) {
      warnings.push({ message: `${sheetPrefix(sheet, rowNumber)}: řádek obsahuje buňky bez čitelné hodnoty.`, rawText: rowRawText(rowNumber, row) });
      continue;
    }
    if (lastContext?.kind === "stand") {
      notes.push({ afterStandNumber: lastContext.standNumber, text: label, page: sheet.position, rawRow: `řádek ${rowNumber}: ${label}` });
    } else if (lastContext?.kind === "rowWithoutStand") {
      warnings.push({ message: `${sheetPrefix(sheet, rowNumber)}: poznámka patří k řádku ${lastContext.rowNumber} bez čísla stánku — nebyla přiřazena.`, rawText: label });
    } else {
      warnings.push({ message: `${sheetPrefix(sheet, rowNumber)}: řádek se nepodařilo přiřadit k žádnému stánku (před prvním stánkem).`, rawText: label });
    }
  }
  flushUnlabeledNumericRows();

  // ---- Value columns: every column holding a number in a stand row, paired with the headers by order.
  const standColumn = Math.min(...standRows.map((draft) => draft.standColumn), Number.POSITIVE_INFINITY);
  const valueColumns = [...new Set(standRows.flatMap((draft) => rowNumberColumns(draft.row, draft.standColumn)))].sort((a, b) => a - b);

  const base = { sheetName: sheet.name, headerRowNumbers, standRowCount: standRows.length, noteCount: notes.length, rowsWithoutStandCount: rowsWithoutStand.length };
  if (standRows.length === 0) {
    warnings.push({ message: `${sheetPrefix(sheet)}: pod hlavičkou nebyl nalezen žádný řádek s číslem stánku.` });
    return { table: { rows: [], notes: [], warnings, headerFound: true }, check: { ...base, columns: [], totals: { status: "missing" } }, titleText };
  }
  if (valueColumns.length !== serviceHeaders.length) {
    warnings.push({
      message: `${sheetPrefix(sheet)}: počet sloupců s množstvím (${valueColumns.length}: ${valueColumns.map(columnLetters).join(", ") || "žádný"}) neodpovídá počtu služeb v hlavičce (${serviceHeaders.length}: ${serviceHeaders.map((entry) => entry.label).join(", ") || "žádná"}). Sloupce nelze jednoznačně přiřadit, z Excelu proto nebylo nic importováno — použijte PDF výjezd.`,
    });
    return { table: { rows: [], notes: [], warnings, headerFound: false }, check: { ...base, standRowCount: 0, noteCount: 0, columns: [], totals: { status: "missing" } }, titleText };
  }

  const usedLabels = new Map<string, number>();
  const columns: TechnicalExcelColumnMapping[] = serviceHeaders.map((entry, index) => {
    const valueColumn = valueColumns[index]!;
    if (Math.abs(valueColumn - entry.column) > MAX_EXPECTED_HEADER_VALUE_OFFSET) {
      warnings.push({ message: `${sheetPrefix(sheet)}: hodnoty služby „${entry.label}“ (hlavička ve sloupci ${columnLetters(entry.column)}) leží ve vzdáleném sloupci ${columnLetters(valueColumn)} — zkontrolujte přiřazení.` });
    }
    const seen = usedLabels.get(entry.label) ?? 0;
    usedLabels.set(entry.label, seen + 1);
    const label = seen === 0 ? entry.label : `${entry.label} (sloupec ${columnLetters(valueColumn)})`;
    if (seen > 0) warnings.push({ message: `${sheetPrefix(sheet)}: název služby „${entry.label}“ je v hlavičce vícekrát — druhý výskyt veden jako „${label}“.` });
    return { label, headerColumn: columnLetters(entry.column), valueColumn: columnLetters(valueColumn) };
  });
  const valueColumnSet = new Set(valueColumns);

  // ---- Pass 2: stand rows → ParsedStandTableRow (company, column values, inline text as notes).
  const rows: ParsedStandTableRow[] = [];
  const seenStands = new Map<string, number>();
  for (const draft of standRows) {
    const previousRow = seenStands.get(draft.standNumber);
    if (previousRow !== undefined) {
      warnings.push({ message: `${sheetPrefix(sheet, draft.rowNumber)}: stánek ${draft.standNumber} je v souboru vícekrát (také řádek ${previousRow}) — služby obou řádků se sečtou.` });
    } else {
      seenStands.set(draft.standNumber, draft.rowNumber);
    }

    const companyParts: string[] = [];
    draft.row.forEach((cell, index) => {
      const column = index + 1;
      if (column <= draft.standColumn || valueColumnSet.has(column)) return;
      const text = cellText(cell);
      if (!text) return;
      if (column < valueColumns[0]!) companyParts.push(text);
      else notes.push({ afterStandNumber: draft.standNumber, text, page: sheet.position, rawRow: `řádek ${draft.rowNumber}: ${text}` });
    });

    const columnValues = new Map<string, string>();
    columns.forEach((mapping, index) => {
      const column = valueColumns[index]!;
      const cell = draft.row[column - 1] ?? { kind: "empty" as const };
      const address = cellAddress(draft.rowNumber, column);
      const where = `${sheetPrefix(sheet, draft.rowNumber)}, stánek ${draft.standNumber}, služba „${mapping.label}“ (buňka ${address})`;
      const raw = technicalWorkbookCellRawText(cell);
      if (raw.ok === false) {
        warnings.push({ message: `${where}: ${raw.reason} — hodnota nebyla importována.` });
        return;
      }
      if (cell.kind === "number") {
        if (cell.value < 0) {
          warnings.push({ message: `${where}: záporné množství ${cell.value} — hodnota nebyla importována.` });
          return;
        }
        if (!Number.isInteger(cell.value)) warnings.push({ message: `${where}: neceločíselné množství ${cell.value} — zkontrolujte.` });
      } else if (raw.text && !/^\d+(?:[.,]\d+)?$/u.test(raw.text)) {
        warnings.push({ message: `${where}: místo čísla obsahuje „${raw.text}“ — hodnota nebyla importována.` });
        return;
      }
      columnValues.set(mapping.label, raw.text);
    });

    rows.push({
      standNumber: draft.standNumber,
      companyName: companyParts.join(" ") || undefined,
      page: sheet.position,
      rawRow: rowRawText(draft.rowNumber, draft.row),
      columnValues,
    });
  }

  for (const withoutStand of rowsWithoutStand) {
    const ordered = columns
      .map((mapping, index) => {
        const cell = withoutStand.row[valueColumns[index]! - 1];
        return cell?.kind === "number" && cell.value !== 0 ? `${mapping.label} ${cell.value}` : undefined;
      })
      .filter(Boolean);
    if (ordered.length > 0) {
      warnings.push({
        message: `${sheetPrefix(sheet, withoutStand.rowNumber)}: řádek „${withoutStand.label}“ má objednané služby (${ordered.join(", ")}), ale nemá číslo stánku — nebyl importován, doplňte ho ručně.`,
        rawText: rowRawText(withoutStand.rowNumber, withoutStand.row),
      });
    }
  }

  // ---- Structural workbook issues on the imported sheet's data area (hidden rows/columns, merges, truncation).
  const firstDataRowNumber = headerEnd + 1;
  for (const issue of auditTechnicalWorkbook({ sheets: [sheet] })) {
    if (issue.code === "HIDDEN_ROW_WITH_DATA" || issue.code === "HIDDEN_COLUMN_WITH_DATA" || issue.code === "SHEET_TRUNCATED") warnings.push({ message: issue.message });
    if (issue.code === "MERGED_RANGE" && issue.address && mergedRangeTouchesRows(issue.address, firstDataRowNumber)) warnings.push({ message: issue.message });
  }

  const totals = checkTotals(sheet, totalsRows, standColumn, columns, valueColumns, [...standRows, ...rowsWithoutStand].map((draft) => draft.row));
  if (totals.status === "mismatch") {
    warnings.push({
      message: `${sheetPrefix(sheet)}: součet načtených řádků nesouhlasí s řádkem „Celkem“ — ${totals.differences.map((difference) => `${difference.label}: načteno ${difference.actual}, v souboru ${difference.expected}`).join("; ")}.`,
    });
  } else if (totals.status === "unverifiable") {
    warnings.push({ message: `${sheetPrefix(sheet)}: kontrolní součet nelze ověřit — ${totals.reason}.` });
  }

  return {
    table: { rows, notes, warnings, headerFound: true },
    check: { ...base, noteCount: notes.length, columns, totals },
    titleText,
  };
}

/**
 * Cross-checks the per-service sums of every data row (stand rows AND rows without a stand number
 * — the report's own total counts both) against the report's "Celkem" row. The totals row is
 * paired with the services by order too: its cells are not always in the data columns (internet:
 * total of column N is printed in O), and a long one wraps into an unlabeled row above it.
 */
function checkTotals(
  sheet: TechnicalWorkbookSheet,
  totalsRows: readonly { rowNumber: number; row: readonly TechnicalWorkbookCell[] }[] | undefined,
  standColumn: number,
  columns: readonly TechnicalExcelColumnMapping[],
  valueColumns: readonly number[],
  dataRows: readonly (readonly TechnicalWorkbookCell[])[],
): TechnicalExcelTotalsCheck {
  if (!totalsRows) return { status: "missing" };
  const totalCells = new Map<number, number>();
  for (const { row } of totalsRows) {
    for (const column of rowNumberColumns(row, standColumn)) {
      if (totalCells.has(column)) return { status: "unverifiable", reason: `řádek „Celkem“ má ve sloupci ${columnLetters(column)} více hodnot` };
      totalCells.set(column, (row[column - 1] as Extract<TechnicalWorkbookCell, { kind: "number" }>).value);
    }
  }
  const expected = [...totalCells.entries()].sort((a, b) => a[0] - b[0]).map(([, value]) => value);
  if (expected.length !== columns.length) {
    return { status: "unverifiable", reason: `řádek „Celkem“ (${sheet.name}, řádek ${totalsRows.at(-1)!.rowNumber}) má ${expected.length} hodnot, služeb je ${columns.length}` };
  }
  const differences = columns
    .map((mapping, index) => {
      const actual = dataRows.reduce((sum, row) => {
        const cell = row[valueColumns[index]! - 1];
        return cell?.kind === "number" ? sum + cell.value : sum;
      }, 0);
      return { label: mapping.label, expected: expected[index]!, actual };
    })
    .filter((entry) => Math.abs(entry.expected - entry.actual) > 1e-9);
  return differences.length === 0 ? { status: "match" } : { status: "mismatch", differences };
}

/** Excel counterpart of TechnicalReportParser.parse: workbook → the shared ParsedTechnicalReport, plus the Excel control report. */
export function parseTechnicalReportWorkbook(
  category: string,
  workbook: TechnicalWorkbook,
): Readonly<{ report: ParsedTechnicalReport; check?: TechnicalExcelImportCheck; titleText: string }> {
  const { table, check, titleText } = buildTechnicalStandTableFromWorkbook(workbook);
  return { report: buildParsedTechnicalReportFromTable(category, table), check, titleText };
}
