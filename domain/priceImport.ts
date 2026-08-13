/**
 * Pure normalization over raw workbook cell grids. Deliberately has no dependency on
 * any Excel-reading library — tests build RawSheetRow fixtures by hand, and the real
 * reader (lib/import/xlsxReader.server.ts) just adapts exceljs output into this shape.
 */

export type RawCellValue = string | number | null | undefined;
export type RawSheetRow = readonly RawCellValue[];

export type PriceStatus = "priced" | "missing";

export type ParsedPrice = Readonly<{
  amount: number | null;
  status: PriceStatus;
}>;

/**
 * "??", "ZVOL VELETRH" and blank cells all mean "we don't know the price" — never 0.
 * A literal 0 is a real price (e.g. a free/included item) and must stay priced.
 */
const MISSING_PRICE_MARKERS = new Set(["??", "ZVOL VELETRH"]);

export function parsePriceCell(raw: RawCellValue): ParsedPrice {
  if (typeof raw === "number" && Number.isFinite(raw)) return { amount: raw, status: "priced" };
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") return { amount: null, status: "missing" };
    if (MISSING_PRICE_MARKERS.has(trimmed.toUpperCase())) return { amount: null, status: "missing" };
    const numeric = Number(trimmed.replace(",", "."));
    if (Number.isFinite(numeric)) return { amount: numeric, status: "priced" };
    return { amount: null, status: "missing" };
  }
  return { amount: null, status: "missing" };
}

export type ParsedUnit = Readonly<{
  unit: string | null;
  needsReview: boolean;
}>;

// Note: no trailing \b after ² / ³ — those superscript characters are non-word chars in
// JS regex, so a \b right after them never matches when they sit at the end of the string
// (no word/non-word transition into "end of string"). Plain substring matches are safe here.
const UNIT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bm²/iu, "m²"],
  [/\bbm\b/iu, "bm"],
  [/\/\s*den\b/iu, "den"],
  [/\bm³/iu, "m³"],
];

/**
 * Section 20: only these explicit textual markers may suggest a unit. Anything else
 * stays null + needsReview — never guess a unit just because an item "looks like" ks.
 */
export function detectUnitFromName(rawName: string): ParsedUnit {
  for (const [pattern, unit] of UNIT_PATTERNS) {
    if (pattern.test(rawName)) return { unit, needsReview: false };
  }
  return { unit: null, needsReview: true };
}

export type ParsedEventDate = Readonly<{
  startDate: string | null;
  endDate: string | null;
  needsReview: boolean;
}>;

const SINGLE_MONTH_RANGE = /^(\d{1,2})\.\s*-\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})$/u;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/**
 * Handles the one unambiguous pattern actually present in the source workbook:
 * "D1 - D2. M. YYYY" (single month/year shared by both ends). Anything else — including
 * unresolved placeholders like "zatím nebylo určeno" or a cross-month range this parser
 * doesn't recognize — is reported as needsReview with null dates rather than guessed.
 */
export function parseCzechDateRange(raw: string | null | undefined): ParsedEventDate {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { startDate: null, endDate: null, needsReview: true };
  const match = SINGLE_MONTH_RANGE.exec(trimmed);
  if (!match) return { startDate: null, endDate: null, needsReview: true };
  const [, startDayRaw, endDayRaw, monthRaw, yearRaw] = match;
  const startDay = Number(startDayRaw);
  const endDay = Number(endDayRaw);
  const month = Number(monthRaw);
  const year = Number(yearRaw);
  if (month < 1 || month > 12 || startDay < 1 || startDay > 31 || endDay < 1 || endDay > 31 || endDay < startDay) {
    return { startDate: null, endDate: null, needsReview: true };
  }
  return {
    startDate: `${year}-${pad2(month)}-${pad2(startDay)}`,
    endDate: `${year}-${pad2(month)}-${pad2(endDay)}`,
    needsReview: false,
  };
}

export type PricelistRow = Readonly<{
  sourceRow: number;
  category: string;
  rawNameCz: string;
  rawNameEn: string | null;
  unit: ParsedUnit;
  saleCzk: ParsedPrice;
  saleEur: ParsedPrice;
  purchaseCzk: ParsedPrice;
}>;

function cellText(value: RawCellValue): string {
  return value === null || value === undefined ? "" : String(value).trim();
}

/**
 * PRICELIST: column A (kategorie) is only filled on the first row of each category
 * block and inherits downward; fully blank rows are spacer rows between blocks.
 */
export function normalizePricelistSheet(rows: readonly RawSheetRow[]): readonly PricelistRow[] {
  const result: PricelistRow[] = [];
  let currentCategory = "";
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]!;
    const category = cellText(row[0]);
    const nameCz = cellText(row[1]);
    if (category) currentCategory = category;
    if (!nameCz) continue;
    result.push({
      sourceRow: index + 1,
      category: currentCategory,
      rawNameCz: nameCz,
      rawNameEn: cellText(row[4]) || null,
      unit: detectUnitFromName(nameCz),
      saleCzk: parsePriceCell(row[3]),
      saleEur: parsePriceCell(row[5]),
      purchaseCzk: parsePriceCell(row[6]),
    });
  }
  return result;
}

export type EventSourceRow = Readonly<{
  sourceRow: number;
  sourceKey: string;
  name: string;
  rawDateText: string;
  date: ParsedEventDate;
}>;

/** "data sheet": column A = stable sourceKey, B = event name, C = raw CZ date range text. */
export function normalizeEventSourceSheet(rows: readonly RawSheetRow[]): readonly EventSourceRow[] {
  const result: EventSourceRow[] = [];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]!;
    const sourceKey = cellText(row[0]);
    if (!sourceKey) continue;
    const rawDateText = cellText(row[2]);
    result.push({
      sourceRow: index + 1,
      sourceKey,
      name: cellText(row[1]),
      rawDateText,
      date: parseCzechDateRange(rawDateText),
    });
  }
  return result;
}

export type EventPricingRow = Readonly<{
  sourceRow: number;
  rawName: string;
  pricesByEventKey: Readonly<Record<string, ParsedPrice>>;
}>;

/**
 * Shared shape for CZK / EUR / náklad sheets: row 1 = ["<label>", eventKey1, eventKey2, ...],
 * each following row = one technical service priced per event column.
 */
export function normalizeEventPricingSheet(rows: readonly RawSheetRow[]): readonly EventPricingRow[] {
  if (rows.length === 0) return [];
  const header = rows[0]!;
  const eventKeys = header.slice(1).map((value) => cellText(value));
  const result: EventPricingRow[] = [];
  for (let index = 1; index < rows.length; index++) {
    const row = rows[index]!;
    const rawName = cellText(row[0]);
    if (!rawName) continue;
    const pricesByEventKey: Record<string, ParsedPrice> = {};
    eventKeys.forEach((eventKey, columnIndex) => {
      if (!eventKey) return;
      pricesByEventKey[eventKey] = parsePriceCell(row[columnIndex + 1]);
    });
    result.push({ sourceRow: index + 1, rawName, pricesByEventKey });
  }
  return result;
}
