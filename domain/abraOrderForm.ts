/**
 * ABRA report "3. Formulář objednávky přijaté ABF" — a GENERIC parser of the order form PDF.
 *
 * It reads EVERY order and EVERY item (ABF code, name as printed, quantity, unit, prices, VAT, notes),
 * not only technical services: the same structure is meant to be reused later (DEV v1.0 orders,
 * component catalog). Which items become technical-raster services is decided separately
 * (domain/abraOrderTechnicalImport.ts).
 *
 * Layout (verified on the real export, 127 orders / 151 pages): every page starts with
 * "Objednávka přijatá č." + the ABRA order number ("V238-12/2026") and the order's own page number;
 * only an order's FIRST page carries the customer block ("Odběratel:", "Zákaznické číslo: …", the
 * stand number right under it, the company name). Items are rows with the ABF code in the first
 * column; a row with text in the name column but no code is a NOTE of the item above it. An item
 * table ends with "Zálohové listy:" / "Dodací listy:" / "Částky v CZK" (totals) or with "Tento
 * doklad má pokračování" (continued on the next page).
 *
 * Input is pdf.js text (domain/technicalReportTableParsing.ts PdfTextItem, page coordinates). Column
 * boundaries are derived from the table header of each page, never fixed page coordinates, with the
 * measured offsets as fallback. Nothing is dropped silently: anything unexpected becomes a warning.
 *
 * The ABRA Excel export of this report is NOT supported: in the real export it holds only fragments
 * of 3 of 127 orders and mixes the header of one order with the items and stand of another (see
 * docs/ABRA_ORDER_IMPORT.md) — it cannot be read safely.
 */
import type { PdfTextItem } from "./technicalReportTableParsing.ts";

export type AbraOrderItem = Readonly<{
  /** 1-based position within the order. */
  lineNumber: number;
  /** ABF code ("L03", "M97", "P1"), exactly as printed; "" for a free-text item ABRA printed without a code. */
  code: string;
  /** Item name as printed (ABRA truncates it to the column width). */
  name: string;
  /** Parsed quantity (Czech decimal comma: "1,800" -> 1.8); undefined when the cell is missing or unreadable. */
  quantity?: number;
  quantityRaw: string;
  unit: string;
  unitPrice?: number;
  totalPrice?: number;
  vatRaw: string;
  /** Note lines printed under the item, verbatim, in order. */
  notes: readonly string[];
  page: number;
}>;

export type AbraOrder = Readonly<{
  /** ABRA document number, e.g. "V238-12/2026" — the order's identity. */
  orderNumber: string;
  customerNumber?: string;
  companyName?: string;
  /** Stand number from the customer block; undefined when the order has none. */
  standNumber?: string;
  issueDate?: string;
  pages: readonly number[];
  items: readonly AbraOrderItem[];
  /** Footer references ("ZLV-4237/2026", "DL-23246/2026"). */
  documentReferences: readonly string[];
  /** Text printed in the item table before the first item (e.g. a customer PO reference). */
  orderNotes: readonly string[];
  totalToPay?: number;
}>;

export type AbraOrderFormWarning = Readonly<{ message: string; page?: number; orderNumber?: string; rawText?: string }>;

/** A page that could not be assigned to an order with certainty — reported, its items NOT loaded. */
export type AbraAmbiguousPage = Readonly<{ page: number; orderNumber?: string; pageOfOrder?: number; reason: string; itemCount: number; itemCodes: readonly string[] }>;

export type ParsedAbraOrderForm = Readonly<{
  orders: readonly AbraOrder[];
  pageCount: number;
  /** Pages not assigned to any order (see parseAbraOrderFormPdf). */
  ambiguousPages: readonly AbraAmbiguousPage[];
  warnings: readonly AbraOrderFormWarning[];
}>;

const ORDER_NUMBER_PATTERN = /^V\d+-\d+\/\d{4}$/u;
const CODE_PATTERN = /^[A-Z0-9]{1,4}$/u;
const QUANTITY_PATTERN = /^-?\d{1,3}(?: \d{3})*(?:,\d+)?$/u;
const STAND_PATTERN = /^[0-9]{1,2}[A-Z]{1,2}[0-9]{1,3}[A-Z]?$/u;

/** "1 653,000" -> 1653, "1,800" -> 1.8; undefined for anything else. */
export function parseCzechNumber(raw: string): number | undefined {
  const text = raw.replace(/ /gu, " ").trim();
  if (!QUANTITY_PATTERN.test(text)) return undefined;
  const value = Number(text.replace(/ /gu, "").replace(",", "."));
  return Number.isFinite(value) ? value : undefined;
}

type Line = { y: number; cells: PdfTextItem[] };

/** Groups a page's items into visual lines (same baseline ±2 pt), top to bottom, cells left to right. */
function linesOf(items: readonly PdfTextItem[]): Line[] {
  const lines: Line[] = [];
  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    if (!item.str.trim()) continue;
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= 2);
    if (line) line.cells.push(item);
    else lines.push({ y: item.y, cells: [item] });
  }
  for (const line of lines) line.cells.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => b.y - a.y);
}

const text = (cell: PdfTextItem) => cell.str.trim();
const lineText = (line: Line) => line.cells.map(text).join(" ");

type Columns = { nameX: number; quantityX: number; unitX: number; unitPriceX: number; totalX: number; vatX: number };

/** Column anchors from the page's own table header ("Předmět…", "Množství / j.", "Cena za jedn.", "Cena celkem", "Sazba"). */
function columnsOf(lines: readonly Line[]): Columns {
  const cellX = (pattern: RegExp, fallback: number) => lines.flatMap((line) => line.cells).find((cell) => pattern.test(text(cell)))?.x ?? fallback;
  const quantityHeaderX = cellX(/^Množství/u, 311);
  return {
    nameX: 139,
    quantityX: quantityHeaderX,
    unitX: quantityHeaderX + 46,
    unitPriceX: cellX(/^Cena za jedn/u, 389),
    totalX: cellX(/^Cena celkem/u, 460),
    vatX: cellX(/^Sazba/u, 532),
  };
}

const FOOTER_PATTERN = /^(Zálohové listy:|Dodací listy:|Částky v CZK|Tento doklad má pokračování|Vystavil\(a\)|Základem pro výpočet|Vystaveno v systému|Telefon:|Mobilní telefon:)/u;

type MutableItem = Omit<AbraOrderItem, "notes" | "lineNumber"> & { notes: string[] };

/** One page read on its own, before it is assigned to an order. */
type PageParse = {
  page: number;
  orderNumber?: string;
  /** The order's own page number ("č. 2"). */
  pageOfOrder?: number;
  /** "Tento doklad má pokračování na stránce č. N". */
  continuesOnPage?: number;
  customer?: { customerNumber?: string; companyName?: string; standNumber?: string; issueDate?: string };
  /** Note lines before the page's first item — on a continuation page they belong to the previous page's last item. */
  leadingNotes: string[];
  items: MutableItem[];
  references: string[];
  totalToPay?: number;
  warnings: AbraOrderFormWarning[];
};

function parsePage(page: number, pageItems: readonly PdfTextItem[]): PageParse {
  const lines = linesOf(pageItems);
  const result: PageParse = { page, leadingNotes: [], items: [], references: [], warnings: [] };
  const allCells = lines.flatMap((line) => line.cells);
  const numberCell = allCells.find((cell) => ORDER_NUMBER_PATTERN.test(text(cell)));
  if (numberCell) {
    result.orderNumber = text(numberCell);
    // The order's page number sits right of the "č." label, just below the order number.
    const pageLabel = allCells.find((cell) => text(cell) === "č." && cell.x > numberCell.x && Math.abs(cell.y - numberCell.y) < 20);
    const pageCell = pageLabel ? allCells.find((cell) => cell !== pageLabel && /^\d{1,3}$/u.test(text(cell)) && cell.x > pageLabel.x && Math.abs(cell.y - pageLabel.y) <= 3) : undefined;
    if (pageCell) result.pageOfOrder = Number(text(pageCell));
  }
  const continuation = lines.map(lineText).join(" ").match(/Tento doklad má pokračování na stránce č\.\s*(\d+)/u);
  if (continuation) result.continuesOnPage = Number(continuation[1]);
  const orderNumber = result.orderNumber;

  // Customer block (an order's first page only).
  const customerLine = lines.find((line) => line.cells.some((cell) => text(cell) === "Odběratel:"));
  if (customerLine) {
    const customer: NonNullable<PageParse["customer"]> = {};
    const customerNumberText = customerLine.cells.map(text).join(" ").match(/Zákaznické číslo:\s*(\S+)/u);
    if (customerNumberText) customer.customerNumber = customerNumberText[1];
    const blockLines = lines.filter((line) => line.y < customerLine.y && line.y > customerLine.y - 60);
    const companyCell = blockLines.flatMap((line) => line.cells).find((cell) => cell.x > 270 && cell.x < 420 && !/^\d{3} \d{2}$/u.test(text(cell)));
    if (companyCell) customer.companyName = text(companyCell);
    const standCells = lines.filter((line) => line.y < customerLine.y && line.y > (companyCell?.y ?? customerLine.y - 45)).flatMap((line) => line.cells).filter((cell) => cell.x > 440);
    const standText = standCells.map(text).join(" ").trim();
    if (standText) {
      if (STAND_PATTERN.test(standText)) customer.standNumber = standText;
      else result.warnings.push({ page, orderNumber, message: `Číslo stánku „${standText}“ nemá očekávaný tvar — objednávka se zpracuje jako bez stánku.`, rawText: standText });
    }
    const dateLine = lines.find((line) => /Datum vystavení dokladu:/u.test(lineText(line)));
    const date = dateLine ? lineText(dateLine).match(/(\d{2}\.\d{2}\.\d{4})/u)?.[1] : undefined;
    if (date) customer.issueDate = date;
    result.customer = customer;
  }

  const tableHeaderLine = lines.find((line) => line.cells.some((cell) => /^Předmět zdanitelného plnění/u.test(text(cell))));
  if (!tableHeaderLine) {
    result.warnings.push({ page, orderNumber, message: "Strana bez hlavičky tabulky položek — položky nelze číst." });
    return result;
  }
  const columns = columnsOf(lines);
  /** Value columns by left edge, between the header anchors (numbers are right-aligned inside them). */
  const columnOf = (cell: PdfTextItem): keyof Columns => {
    if (cell.x < columns.unitX - 5) return "quantityX";
    if (cell.x < columns.unitPriceX - 10) return "unitX";
    if (cell.x < columns.totalX + 10) return "unitPriceX";
    if (cell.x < columns.vatX) return "totalX";
    return "vatX";
  };

  // The header line itself spans 3 baselines ("Cena za jedn." … "v CZK bez DPH"): items start below the lowest.
  const headerBottom = Math.min(...lines.filter((line) => line.y <= tableHeaderLine.y + 8 && line.y >= tableHeaderLine.y - 8).map((line) => line.y));
  let inTable = true;
  for (const line of lines) {
    if (line.y >= headerBottom) continue;
    const first = line.cells[0]!;
    const firstText = text(first);
    if (FOOTER_PATTERN.test(lineText(line)) || FOOTER_PATTERN.test(firstText)) {
      const references = lineText(line).match(/\b(?:ZLV|DL)-\d+\/\d{4}\b/gu);
      if (references) result.references.push(...references);
      inTable = false;
      continue;
    }
    if (/^Částka k úhradě/u.test(lineText(line))) continue;
    if (!inTable) continue;

    const coded = first.x < columns.nameX - 30 && CODE_PATTERN.test(firstText);
    const hasValues = line.cells.some((cell) => cell.x >= columns.quantityX - 15);
    // A coded row is an item; an uncoded row WITH values in the quantity/price columns is a free-text
    // item ABRA printed without an ABF code (kept, code ""); an uncoded row without values is a note.
    if (coded || hasValues) {
      const nameCells = line.cells.filter((cell) => (coded ? cell !== first && cell.x >= columns.nameX - 5 : true) && cell.x < columns.quantityX - 15);
      const valueCells = line.cells.filter((cell) => cell !== first && cell.x >= columns.quantityX - 15);
      const byColumn = new Map<keyof Columns, string>();
      for (const cell of valueCells) byColumn.set(columnOf(cell), [byColumn.get(columnOf(cell)), text(cell)].filter(Boolean).join(" "));
      const quantityRaw = byColumn.get("quantityX") ?? "";
      const quantity = parseCzechNumber(quantityRaw);
      if (quantity === undefined) result.warnings.push({ page, orderNumber, message: `Položka ${coded ? firstText : "bez kódu"}: nečitelné množství „${quantityRaw}“.`, rawText: lineText(line) });
      result.items.push({
        code: coded ? firstText : "",
        name: nameCells.map(text).join(" "),
        quantity,
        quantityRaw,
        unit: byColumn.get("unitX") ?? "",
        unitPrice: parseCzechNumber(byColumn.get("unitPriceX") ?? ""),
        totalPrice: parseCzechNumber(byColumn.get("totalX") ?? ""),
        vatRaw: byColumn.get("vatX") ?? "",
        notes: [],
        page,
      });
      continue;
    }
    if (first.x >= columns.nameX - 5 && first.x < columns.quantityX - 15) {
      const previous = result.items.at(-1);
      if (previous) previous.notes.push(lineText(line));
      else result.leadingNotes.push(lineText(line));
      continue;
    }
    result.warnings.push({ page, orderNumber, message: "Neočekávaný řádek v tabulce položek.", rawText: lineText(line) });
  }

  const toPayLine = lines.find((line) => /^Částka k úhradě/u.test(lineText(line)));
  if (toPayLine) {
    const amountLine = lines.find((line) => line.y > toPayLine.y && line.y - toPayLine.y <= 3 && line !== toPayLine) ?? toPayLine;
    const amount = amountLine.cells.map(text).map(parseCzechNumber).filter((value) => value !== undefined).at(-1);
    if (amount !== undefined) result.totalToPay = amount;
  }
  return result;
}

/**
 * Pages are assigned to orders ONLY on positive evidence: the page's own order number AND its own page
 * number. A first page ("č. 1") must carry the customer block and start a new order; a continuation
 * page ("č. N", N > 1) must follow page N-1 of the SAME order directly. Anything else (no order number,
 * a missing or repeated page number, a gap, a first page of an already started order, a continuation
 * page of an order that is not the current one) is NOT guessed: the page is reported in
 * `ambiguousPages` with its items, and none of them is added to any order.
 */
export function parseAbraOrderFormPdf(items: readonly PdfTextItem[]): ParsedAbraOrderForm {
  const warnings: AbraOrderFormWarning[] = [];
  const byPage = new Map<number, PdfTextItem[]>();
  for (const item of items) {
    const list = byPage.get(item.page) ?? [];
    list.push(item);
    byPage.set(item.page, list);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);

  type MutableOrder = { orderNumber: string; customerNumber?: string; companyName?: string; standNumber?: string; issueDate?: string; pages: number[]; pagesOfOrder: number[]; items: MutableItem[]; documentReferences: string[]; orderNotes: string[]; totalToPay?: number; expectsPage?: number };
  const orders = new Map<string, MutableOrder>();
  const orderSequence: string[] = [];
  const ambiguousPages: AbraAmbiguousPage[] = [];
  let current: MutableOrder | undefined;

  const reject = (parsed: PageParse, reason: string) => {
    ambiguousPages.push({ page: parsed.page, orderNumber: parsed.orderNumber, pageOfOrder: parsed.pageOfOrder, reason, itemCount: parsed.items.length, itemCodes: parsed.items.map((item) => item.code || "(bez kódu)") });
    warnings.push({ page: parsed.page, orderNumber: parsed.orderNumber, message: `Strana ${parsed.page} nejde jednoznačně přiřadit (${reason}) — ${parsed.items.length} položek se nenačetlo, zkontrolujte PDF.` });
  };

  for (const page of pages) {
    const parsed = parsePage(page, byPage.get(page)!);
    warnings.push(...parsed.warnings);
    if (!parsed.orderNumber) { reject(parsed, "chybí číslo objednávky"); continue; }
    if (parsed.pageOfOrder === undefined) { reject(parsed, "chybí číslo strany dokladu"); continue; }

    let order: MutableOrder;
    if (parsed.pageOfOrder === 1) {
      if (orders.has(parsed.orderNumber)) { reject(parsed, `objednávka ${parsed.orderNumber} už začala na straně ${orders.get(parsed.orderNumber)!.pages[0]}`); continue; }
      if (!parsed.customer) { reject(parsed, "první strana bez bloku odběratele"); continue; }
      if (current?.expectsPage !== undefined) warnings.push({ page, orderNumber: current.orderNumber, message: `Objednávce ${current.orderNumber} chybí pokračovací strana č. ${current.expectsPage}.` });
      order = { orderNumber: parsed.orderNumber, ...parsed.customer, pages: [], pagesOfOrder: [], items: [], documentReferences: [], orderNotes: [] };
      orders.set(order.orderNumber, order);
      orderSequence.push(order.orderNumber);
      order.orderNotes.push(...parsed.leadingNotes);
    } else {
      if (!current || current.orderNumber !== parsed.orderNumber) { reject(parsed, `pokračovací strana č. ${parsed.pageOfOrder} nenavazuje na předchozí stranu stejné objednávky`); continue; }
      const expected = current.pagesOfOrder.at(-1)! + 1;
      if (parsed.pageOfOrder !== expected) { reject(parsed, `očekávána strana č. ${expected} objednávky ${current.orderNumber}, nalezena č. ${parsed.pageOfOrder}`); continue; }
      order = current;
      // Notes at the top of a continuation page continue the previous page's last item.
      const previous = order.items.at(-1);
      if (previous) previous.notes.push(...parsed.leadingNotes);
      else order.orderNotes.push(...parsed.leadingNotes);
    }
    order.pages.push(page);
    order.pagesOfOrder.push(parsed.pageOfOrder);
    order.items.push(...parsed.items);
    order.documentReferences.push(...parsed.references);
    if (parsed.totalToPay !== undefined) order.totalToPay = parsed.totalToPay;
    order.expectsPage = parsed.continuesOnPage;
    current = order;
  }
  if (current?.expectsPage !== undefined) warnings.push({ orderNumber: current.orderNumber, message: `Objednávce ${current.orderNumber} chybí pokračovací strana č. ${current.expectsPage}.` });

  const parsedOrders: AbraOrder[] = orderSequence.map((number) => {
    const order = orders.get(number)!;
    if (!order.customerNumber && !order.companyName) warnings.push({ orderNumber: number, page: order.pages[0], message: `Objednávka ${number}: nenalezen blok odběratele.` });
    const { pagesOfOrder: _pagesOfOrder, expectsPage: _expectsPage, ...rest } = order;
    void _pagesOfOrder;
    void _expectsPage;
    return { ...rest, orderNotes: [...order.orderNotes], items: order.items.map((item, index) => ({ ...item, lineNumber: index + 1, notes: [...item.notes] })) };
  });
  return { orders: parsedOrders, pageCount: pages.length, ambiguousPages, warnings };
}
