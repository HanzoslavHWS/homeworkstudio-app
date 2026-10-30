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

export type ParsedAbraOrderForm = Readonly<{
  orders: readonly AbraOrder[];
  pageCount: number;
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

export function parseAbraOrderFormPdf(items: readonly PdfTextItem[]): ParsedAbraOrderForm {
  const warnings: AbraOrderFormWarning[] = [];
  const byPage = new Map<number, PdfTextItem[]>();
  for (const item of items) {
    const list = byPage.get(item.page) ?? [];
    list.push(item);
    byPage.set(item.page, list);
  }
  const pages = [...byPage.keys()].sort((a, b) => a - b);

  type MutableOrder = { orderNumber: string; customerNumber?: string; companyName?: string; standNumber?: string; issueDate?: string; pages: number[]; items: (Omit<AbraOrderItem, "notes"> & { notes: string[] })[]; documentReferences: string[]; orderNotes: string[]; totalToPay?: number };
  const orders = new Map<string, MutableOrder>();
  const orderSequence: string[] = [];

  for (const page of pages) {
    const lines = linesOf(byPage.get(page)!);
    const numberCell = lines.flatMap((line) => line.cells).find((cell) => ORDER_NUMBER_PATTERN.test(text(cell)));
    if (!numberCell) {
      warnings.push({ page, message: "Strana bez čísla objednávky — přeskočena." });
      continue;
    }
    const orderNumber = text(numberCell);
    let order = orders.get(orderNumber);
    if (!order) {
      order = { orderNumber, pages: [], items: [], documentReferences: [], orderNotes: [] };
      orders.set(orderNumber, order);
      orderSequence.push(orderNumber);
    } else if (orderSequence.at(-1) !== orderNumber) {
      warnings.push({ page, orderNumber, message: `Objednávka ${orderNumber} pokračuje na nesouvislé straně ${page}.` });
    }
    order.pages.push(page);

    // Customer block (first page only).
    const customerLine = lines.find((line) => line.cells.some((cell) => text(cell) === "Odběratel:"));
    const tableHeaderLine = lines.find((line) => line.cells.some((cell) => /^Předmět zdanitelného plnění/u.test(text(cell))));
    if (customerLine) {
      const customerNumberText = customerLine.cells.map(text).join(" ").match(/Zákaznické číslo:\s*(\S+)/u);
      if (customerNumberText) order.customerNumber = customerNumberText[1];
      const blockLines = lines.filter((line) => line.y < customerLine.y && line.y > customerLine.y - 60);
      const companyCell = blockLines.flatMap((line) => line.cells).find((cell) => cell.x > 270 && cell.x < 420 && !/^\d{3} \d{2}$/u.test(text(cell)));
      if (companyCell) order.companyName = text(companyCell);
      const standCells = lines.filter((line) => line.y < customerLine.y && line.y > (companyCell?.y ?? customerLine.y - 45)).flatMap((line) => line.cells).filter((cell) => cell.x > 440);
      const standText = standCells.map(text).join(" ").trim();
      if (standText) {
        if (STAND_PATTERN.test(standText)) order.standNumber = standText;
        else warnings.push({ page, orderNumber, message: `Číslo stánku „${standText}“ nemá očekávaný tvar — objednávka se zpracuje jako bez stánku.`, rawText: standText });
      }
      const dateLine = lines.find((line) => /Datum vystavení dokladu:/u.test(lineText(line)));
      const date = dateLine ? lineText(dateLine).match(/(\d{2}\.\d{2}\.\d{4})/u)?.[1] : undefined;
      if (date) order.issueDate = date;
    }

    if (!tableHeaderLine) {
      warnings.push({ page, orderNumber, message: "Strana bez hlavičky tabulky položek — položky nelze číst." });
      continue;
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
        if (references) order.documentReferences.push(...references);
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
        if (quantity === undefined) warnings.push({ page, orderNumber, message: `Položka ${coded ? firstText : "bez kódu"}: nečitelné množství „${quantityRaw}“.`, rawText: lineText(line) });
        order.items.push({
          lineNumber: order.items.length + 1,
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
        const previous = order.items.at(-1);
        if (previous) previous.notes.push(lineText(line));
        else order.orderNotes.push(lineText(line));
        continue;
      }
      warnings.push({ page, orderNumber, message: "Neočekávaný řádek v tabulce položek.", rawText: lineText(line) });
    }

    const toPayLine = lines.find((line) => /^Částka k úhradě/u.test(lineText(line)));
    if (toPayLine) {
      const amountLine = lines.find((line) => line.y > toPayLine.y && line.y - toPayLine.y <= 3 && line !== toPayLine) ?? toPayLine;
      const amount = amountLine.cells.map(text).map(parseCzechNumber).filter((value) => value !== undefined).at(-1);
      if (amount !== undefined) order.totalToPay = amount;
    }
  }

  const parsedOrders: AbraOrder[] = orderSequence.map((number) => {
    const order = orders.get(number)!;
    if (!order.customerNumber && !order.companyName) warnings.push({ orderNumber: number, page: order.pages[0], message: `Objednávka ${number}: nenalezen blok odběratele.` });
    return { ...order, orderNotes: [...order.orderNotes], items: order.items.map((item) => ({ ...item, notes: [...item.notes] })) };
  });
  return { orders: parsedOrders, pageCount: pages.length, warnings };
}
