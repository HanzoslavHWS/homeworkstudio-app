/**
 * Technické rastry — table reconstruction from PDF-positioned text. Deliberately decoupled from
 * pdfjs-dist's own item shape: `PdfTextItem` below is this module's own minimal contract (str +
 * x/y/width/height, in PDF page-coordinate space, y measured from the BOTTOM like PDF.js's own
 * `getTextContent()` transform does), so this file is pure and unit-testable without ever loading
 * a real PDF. The browser-side adapter that turns a pdfjs-dist page into `PdfTextItem[]` lives in
 * lib/pdf/pdfTextExtraction.ts (client-only, thin, not re-implementing this logic).
 *
 * Never relies on getTextContent()'s own item ORDER (spec section 10: "PDF export může vracet
 * text po blocích") — every reconstruction here groups purely by Y (rows) then X (columns).
 */

export type PdfTextItem = Readonly<{
  str: string;
  page: number;
  /** Left edge, PDF page units (pt), page-coordinate space. */
  x: number;
  /** Baseline Y, PDF page units (pt), measured from the page's bottom-left origin (pdfjs-dist's own convention). */
  y: number;
  width: number;
  height: number;
}>;

export type PdfTextRow = Readonly<{
  page: number;
  /** Representative Y for the row (the average of its items' y) — used only for row ordering/grouping, never persisted as a stand's own position. */
  y: number;
  items: readonly PdfTextItem[];
}>;

/**
 * Groups same-page items into rows by Y proximity (within `toleranceEm` of the item's own height,
 * so it scales with the document's actual font size instead of a fixed pt value). Rows are
 * returned reading-order: page ascending, then Y descending (PDF y grows upward), then items
 * within a row sorted by X ascending.
 */
export function groupTextItemsIntoRows(items: readonly PdfTextItem[], toleranceEm = 0.5): readonly PdfTextRow[] {
  const byPage = new Map<number, PdfTextItem[]>();
  for (const item of items) {
    if (!item.str.trim()) continue;
    if (!byPage.has(item.page)) byPage.set(item.page, []);
    byPage.get(item.page)!.push(item);
  }

  const rows: PdfTextRow[] = [];
  for (const [page, pageItems] of [...byPage.entries()].sort((a, b) => a[0] - b[0])) {
    const sorted = [...pageItems].sort((a, b) => b.y - a.y);
    let current: PdfTextItem[] = [];
    let currentY: number | undefined;
    const flush = () => {
      if (current.length === 0) return;
      const avgY = current.reduce((sum, item) => sum + item.y, 0) / current.length;
      rows.push({ page, y: avgY, items: [...current].sort((a, b) => a.x - b.x) });
      current = [];
    };
    for (const item of sorted) {
      const tolerance = Math.max(1, item.height * toleranceEm);
      if (currentY === undefined || Math.abs(item.y - currentY) <= tolerance) {
        current.push(item);
        currentY = current.reduce((sum, entry) => sum + entry.y, 0) / current.length;
      } else {
        flush();
        current.push(item);
        currentY = item.y;
      }
    }
    flush();
  }
  return rows;
}

/** Joins a row's items left-to-right into one text line, single-spaced — never relies on the original getTextContent() item order. */
export function rowText(row: PdfTextRow): string {
  return row.items.map((item) => item.str).join(" ").replace(/\s+/gu, " ").trim();
}

export type TableColumn = Readonly<{
  header: string;
  /** Center X of the header cell — column values are assigned to the nearest header center. */
  centerX: number;
}>;

/**
 * Detects column headers from a row whose items look like a header line (spec section 10/11: the
 * report's own column header row, e.g. "Do 2 kW 230V", "Rozvaděč 9-21 kW", ...). Callers identify
 * the header row themselves (report structure differs per category — see each parser) and pass
 * its items here; this just turns them into {header, centerX} anchors for assignValuesToColumns.
 */
export function buildTableColumns(headerItems: readonly PdfTextItem[]): readonly TableColumn[] {
  return headerItems
    .filter((item) => item.str.trim())
    .map((item) => ({ header: item.str.trim(), centerX: item.x + item.width / 2 }))
    .sort((a, b) => a.centerX - b.centerX);
}

/**
 * Real ABF technical reports often split one logical column header across TWO stacked PDF text
 * lines (e.g. "Rozvaděč" directly above "9-21kW", or "Další WIFI" above "přípojka") — a single
 * column's header is only complete once both lines are read together. This combines an upper
 * (farther from the data) and lower (nearer to the data) header-candidate row into one column
 * set: a lower item is merged with the nearest upper item directly above it (small X distance —
 * true stacked pairs land within a point or two of each other; unrelated columns are typically
 * 30+pt apart, see the tests), text joined "upper lower"; an item with no close counterpart on
 * the other line becomes its own column. Never guesses a pairing across a real column gap.
 */
function buildTwoLineHeaderColumns(upperItems: readonly PdfTextItem[], lowerItems: readonly PdfTextItem[]): readonly TableColumn[] {
  const HEADER_LINE_PAIR_TOLERANCE_PT = 10;
  const upperCenters = upperItems.map((item) => ({ item, centerX: item.x + item.width / 2 }));
  const claimed = new Set<number>();
  const columns: TableColumn[] = [];

  for (const lowerItem of lowerItems) {
    if (!lowerItem.str.trim()) continue;
    const lowerCenterX = lowerItem.x + lowerItem.width / 2;
    let bestIndex = -1;
    let bestDistance = HEADER_LINE_PAIR_TOLERANCE_PT;
    upperCenters.forEach((candidate, index) => {
      if (claimed.has(index)) return;
      const distance = Math.abs(candidate.centerX - lowerCenterX);
      if (distance <= bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    if (bestIndex !== -1) {
      claimed.add(bestIndex);
      const upper = upperCenters[bestIndex]!;
      columns.push({ header: `${upper.item.str.trim()} ${lowerItem.str.trim()}`.trim(), centerX: (upper.centerX + lowerCenterX) / 2 });
    } else {
      columns.push({ header: lowerItem.str.trim(), centerX: lowerCenterX });
    }
  }
  upperCenters.forEach((candidate, index) => {
    if (!claimed.has(index) && candidate.item.str.trim()) columns.push({ header: candidate.item.str.trim(), centerX: candidate.centerX });
  });

  return columns.sort((a, b) => a.centerX - b.centerX);
}

/** Assigns each item in a data row to the column whose centerX is closest — this is the "use X position, not getTextContent() order" mechanism spec section 10/11 requires. */
export function assignRowToColumns(row: PdfTextRow, columns: readonly TableColumn[]): ReadonlyMap<string, string> {
  const byColumn = new Map<string, string[]>();
  for (const item of row.items) {
    if (!item.str.trim() || columns.length === 0) continue;
    let closest = columns[0]!;
    let closestDistance = Math.abs(item.x + item.width / 2 - closest.centerX);
    for (const column of columns.slice(1)) {
      const distance = Math.abs(item.x + item.width / 2 - column.centerX);
      if (distance < closestDistance) {
        closest = column;
        closestDistance = distance;
      }
    }
    if (!byColumn.has(closest.header)) byColumn.set(closest.header, []);
    byColumn.get(closest.header)!.push(item.str.trim());
  }
  return new Map([...byColumn.entries()].map(([header, parts]) => [header, parts.join(" ").trim()]));
}

/**
 * A single logical column cell's raw text, after `assignRowToColumns`. Almost always one plain
 * number ("0", "1", "40", "2"). Real ABF reports occasionally fuse TWO adjacent report columns
 * into one PDF text run (spec section 2/3 — e.g. "Osvětlení"+"Non stop" sharing one header cell,
 * so both columns' values land in the same bucket as "0 0" or "1 0") — a compound cell.
 */
export type NumericCellEvaluation =
  | Readonly<{ kind: "zero" }>
  | Readonly<{ kind: "single"; quantity: number }>
  | Readonly<{ kind: "ambiguousCompound"; parts: readonly string[] }>;

/**
 * The ONE central place a column's raw cell text is turned into a quantity (spec section 3:
 * "implementuj bezpečné centrální vyhodnocení"). A cell with more than one whitespace-separated
 * token is a COMPOUND value — two or more original report columns collapsed into one PDF text run
 * upstream of us (never something we caused; see buildTwoLineHeaderColumns's own doc). We can
 * never know deterministically which token belongs to which real column, so:
 *  - every part is exactly "0" (or unparsable-as-nonzero) -> "zero": genuinely not ordered, no
 *    service should ever be created for it, compound or not.
 *  - any part is non-zero -> "ambiguousCompound": NEVER guess a quantity; the caller must record
 *    this as a warning (raw label/value/source preserved) rather than inventing a TechnicalService.
 * A single-token cell keeps today's existing simple-number behavior (never becomes "1" as a
 * silent fallback for genuinely unparsable text — that too is now "ambiguousCompound").
 */
export function evaluateNumericCellValue(raw: string): NumericCellEvaluation {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "-") return { kind: "zero" };
  const parts = trimmed.split(/\s+/u).filter(Boolean);

  if (parts.length <= 1) {
    const numeric = Number(trimmed.replace(",", "."));
    if (!Number.isFinite(numeric)) return { kind: "ambiguousCompound", parts };
    return numeric === 0 ? { kind: "zero" } : { kind: "single", quantity: numeric };
  }

  const numericParts = parts.map((part) => Number(part.replace(",", ".")));
  if (!numericParts.every((value) => Number.isFinite(value))) return { kind: "ambiguousCompound", parts };
  return numericParts.every((value) => value === 0) ? { kind: "zero" } : { kind: "ambiguousCompound", parts };
}

/**
 * Lines that are structural report noise, never a stand data row (spec section 9: "HALA 1",
 * "SEKTOR 1A", "Mezisoučet", "Celkem" and their common variants must be ignored, never turned
 * into a TechnicalStand). Matches the WHOLE line loosely (case/diacritics-insensitive prefix),
 * not a substring, so a real company name that happens to contain "hala" is never excluded.
 * Real ABF exports also group by "Sekce:" (distinct from "Sektor") — e.g. "** Sekce: 1B".
 */
const NON_STAND_ROW_PATTERNS: readonly RegExp[] = [
  /^hala\b/iu,
  /^sektor\b/iu,
  /^sekce:/iu,
  /^mezisou[čc]et\b/iu,
  /^celkem\b/iu,
  /^p[řr]ehled\b/iu,
  /^firma:/iu,
  /^zak[áa]zka:/iu,
  /^strana\s+\d+/iu,
  // The report generator's own one-per-document print footer ("Výtisk sestavil(a) Jan Polánek
  // dne 25.08.2026 strana 1") — appears once at the very end of EVERY real ABF export (found
  // across all 4 real technical-report categories), never a note about a specific stand. Without
  // this it silently attached itself to whichever stand happened to be last in the document.
  /^v[ýy]tisk sestavil/iu,
];

/**
 * Real ABF report exports prefix several of these boilerplate lines with a "**" bullet marker
 * (e.g. "** SEKTOR 1A", "** Mezisoučet: ..."), which sits in front of the keyword the patterns
 * above match on. Stripped here so a marker never masks an otherwise-recognized boilerplate line.
 */
export function isNonStandReportLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  const withoutBulletMarker = trimmed.replace(/^\*+\s*/u, "");
  return NON_STAND_ROW_PATTERNS.some((pattern) => pattern.test(withoutBulletMarker));
}

/**
 * A row whose items are mostly plain numbers (spec section 9: real reports also carry
 * company/hall/grand-total SUBTOTAL rows that share a data row's shape — a label followed by a
 * run of quantities — but carry no boilerplate keyword at all, e.g. the exporting company's own
 * "ABF, a.s. 0 0 1 0 0 ..." grand-total line). Such a row must never be mistaken for the column
 * header when walking backward from the first real data row.
 */
function isMostlyNumericRow(row: PdfTextRow): boolean {
  if (row.items.length === 0) return false;
  const numericCount = row.items.filter((item) => /^\d+(?:[.,]\d+)?$/u.test(item.str.trim())).length;
  return numericCount / row.items.length >= 0.5;
}

/** digit(s) + letter + digit(s) + optional lowercase suffix letter — "1A01", "1A11b", "1B02b", "1C01" (spec section 3/26). Deliberately narrow: never matches a bare number or a bare word, so it can't misfire on a quantity column or a company-name word. */
export function looksLikeStandNumberToken(token: string): boolean {
  return /^\d+[A-Za-z]\d{1,4}[a-z]?$/u.test(token.trim());
}

/**
 * Tries joining the row's first 1-3 items WITHOUT a space (a stand number is always one
 * contiguous token in the source text; pdf.js occasionally splits one token across multiple
 * positioned runs, e.g. "1" + "A01") — the first combination that matches
 * looksLikeStandNumberToken wins. Never joins across a real space in the source, since row
 * items are only ever merged here without inserting one.
 */
function extractLeadingStandNumber(row: PdfTextRow): Readonly<{ standNumber: string; consumedCount: number }> | undefined {
  for (let count = 1; count <= Math.min(3, row.items.length); count += 1) {
    const accumulated = row.items.slice(0, count).map((item) => item.str).join("").trim();
    if (looksLikeStandNumberToken(accumulated)) return { standNumber: accumulated, consumedCount: count };
  }
  return undefined;
}

export type ParsedStandTableRow = Readonly<{
  standNumber: string;
  companyName?: string;
  page: number;
  rawRow: string;
  columnValues: ReadonlyMap<string, string>;
}>;

/** A free-text line found between two stand rows (spec section 13) — attached to whichever stand row came immediately before it. */
export type ParsedStandTableNote = Readonly<{
  afterStandNumber: string;
  text: string;
  page: number;
  rawRow: string;
}>;

export type ParsedTableWarning = Readonly<{ message: string; page?: number; rawText?: string }>;

export type GenericTableParseResult = Readonly<{
  rows: readonly ParsedStandTableRow[];
  notes: readonly ParsedStandTableNote[];
  warnings: readonly ParsedTableWarning[];
  headerFound: boolean;
}>;

/**
 * Category-agnostic table reconstruction (spec section 10/40): every technical-report parser
 * (Electricity/Internet/Water/Waste/Cleaning/...) delegates to this ONE shared implementation —
 * a report's category only decides how each column's raw value later becomes a TechnicalService
 * (see domain/technicalReportParsers/), never how the table itself is found and read.
 *
 * Algorithm: find the first row that starts with a stand-number-shaped token (spec section 7/26)
 * — everything before it is front matter (title/"Firma:"/"Zakázka:" — spec section 9), skipped.
 * The header row is the nearest earlier non-boilerplate row with >= 2 items — its items become
 * column anchors (buildTableColumns) reused for the WHOLE document (a multi-page report repeats
 * the same columns; v1 does not re-detect per page). From the first data row onward: a row whose
 * leading token is stand-number-shaped starts a new stand row (company name = the text between
 * the stand number and the first purely-numeric token; remaining numeric tokens are column-
 * assigned by X position); any other, non-boilerplate row is a NOTE attached to the previous
 * stand (spec section 13) — never silently dropped either way (spec section 25).
 */
export function parseGenericStandTable(items: readonly PdfTextItem[]): GenericTableParseResult {
  const rows = groupTextItemsIntoRows(items);
  const warnings: ParsedTableWarning[] = [];

  const dataStartIndex = rows.findIndex((row) => {
    const text = rowText(row);
    if (isNonStandReportLine(text)) return false;
    return extractLeadingStandNumber(row) !== undefined;
  });

  if (dataStartIndex === -1) {
    warnings.push({ message: "V PDF nebyl nalezen žádný řádek začínající číslem stánku." });
    return { rows: [], notes: [], warnings, headerFound: false };
  }

  const dataStartPage = rows[dataStartIndex]!.page;
  let headerRow: PdfTextRow | undefined;
  let headerRowIndex = -1;
  for (let index = dataStartIndex - 1; index >= 0; index -= 1) {
    const candidate = rows[index]!;
    if (candidate.page !== dataStartPage) break;
    if (isNonStandReportLine(rowText(candidate))) continue;
    if (candidate.items.length < 2 || isMostlyNumericRow(candidate)) continue;
    headerRow = candidate;
    headerRowIndex = index;
    break;
  }

  let columns: readonly TableColumn[] = [];
  if (headerRow) {
    const aboveRow = headerRowIndex > 0 ? rows[headerRowIndex - 1] : undefined;
    const aboveIsContinuation =
      aboveRow !== undefined &&
      aboveRow.page === headerRow.page &&
      aboveRow.items.length >= 2 &&
      !isNonStandReportLine(rowText(aboveRow)) &&
      !isMostlyNumericRow(aboveRow);
    columns = aboveIsContinuation ? buildTwoLineHeaderColumns(aboveRow!.items, headerRow.items) : buildTableColumns(headerRow.items);
  } else {
    warnings.push({ message: "Hlavička sloupců nebyla rozpoznána — hodnoty budou uloženy jen jako raw text bez přiřazení ke konkrétní službě.", page: dataStartPage });
  }

  const parsedRows: ParsedStandTableRow[] = [];
  const notes: ParsedStandTableNote[] = [];
  let lastStandNumber: string | undefined;

  for (let index = dataStartIndex; index < rows.length; index += 1) {
    const row = rows[index]!;
    const text = rowText(row);
    if (isNonStandReportLine(text)) continue;

    const leading = extractLeadingStandNumber(row);
    if (leading) {
      const rest = row.items.slice(leading.consumedCount);
      let valueStartIndex = rest.findIndex((item) => /^\d+(?:[.,]\d+)?$/u.test(item.str.trim()));
      if (valueStartIndex === -1) valueStartIndex = rest.length;
      const companyItems = rest.slice(0, valueStartIndex);
      const valueItems = rest.slice(valueStartIndex);
      const companyName = companyItems.map((item) => item.str).join(" ").replace(/\s+/gu, " ").trim() || undefined;
      const columnValues = assignRowToColumns({ page: row.page, y: row.y, items: valueItems }, columns);
      parsedRows.push({ standNumber: leading.standNumber, companyName, page: row.page, rawRow: text, columnValues });
      lastStandNumber = leading.standNumber;
    } else if (lastStandNumber) {
      notes.push({ afterStandNumber: lastStandNumber, text, page: row.page, rawRow: text });
    } else {
      warnings.push({ message: "Řádek se nepodařilo přiřadit k žádnému stánku (žádný předchozí stánek v dokumentu).", page: row.page, rawText: text });
    }
  }

  return { rows: parsedRows, notes, warnings, headerFound: Boolean(headerRow) };
}
