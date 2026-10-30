/**
 * ABRA "3. Formulář objednávky přijaté ABF" — real-file check of the order import. Parses the PDF
 * (domain/abraOrderForm.ts), prints the technical-raster control overview
 * (domain/abraOrderTechnicalImport.ts) and compares the Excel export of the same report with the PDF:
 * every item block of the Excel is located among the PDF orders, and its order header/stand is
 * checked against the order the items really belong to.
 *
 * Real customer data — never committed (_IMPORT/ is git-ignored) and NEVER part of `npm test`.
 * SKIP-SAFE: exits 0 with a message when the folder is missing.
 *
 * Usage:
 *   npm run test:abra-orders-real
 *   node --no-warnings scripts/abraOrderFormRealDiagnostic.ts [dir]
 * Default dir: _IMPORT/FORMULARE
 */
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import ExcelJS from "exceljs";
import { existsSync, readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseAbraOrderFormPdf, parseCzechNumber, type AbraOrder } from "../domain/abraOrderForm.ts";
import { buildAbraOrderTechnicalImport } from "../domain/abraOrderTechnicalImport.ts";
import type { PdfTextItem } from "../domain/technicalReportTableParsing.ts";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.resolve(repoRoot, process.argv[2] ?? "_IMPORT/FORMULARE");

async function pdfItems(filePath: string): Promise<PdfTextItem[]> {
  const task = pdfjsLib.getDocument({ data: new Uint8Array(await readFile(filePath)), verbosity: 0 });
  const doc = await task.promise;
  const items: PdfTextItem[] = [];
  for (let page = 1; page <= doc.numPages; page += 1) {
    const content = await (await doc.getPage(page)).getTextContent();
    for (const item of content.items as { str: string; width: number; height: number; transform: number[] }[]) {
      if (item.str.trim()) items.push({ str: item.str, page, x: item.transform[4]!, y: item.transform[5]!, width: item.width, height: item.height || Math.abs(item.transform[3]!) });
    }
  }
  await task.destroy();
  return items;
}

const cellText = (value: ExcelJS.CellValue) => (value === null || value === undefined ? "" : typeof value === "object" && "richText" in value ? value.richText.map((part) => part.text).join("") : String(value)).trim();

type ExcelBlock = { rows: number[]; items: { code: string; quantity?: number }[] };

/** Item rows (ABF code in column C + a number right of the name) grouped into blocks ending at "Zálohové listy:" / "Částky v CZK". */
async function excelBlocks(filePath: string): Promise<{ blocks: ExcelBlock[]; headerNumbers: string[]; stands: string[] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const sheet = workbook.worksheets[0]!;
  const blocks: ExcelBlock[] = [];
  let current: ExcelBlock = { rows: [], items: [] };
  const headerNumbers: string[] = [];
  const stands: string[] = [];
  sheet.eachRow((row, rowNumber) => {
    const cells = (row.values as ExcelJS.CellValue[]).map(cellText);
    const joined = cells.filter(Boolean).join(" ");
    headerNumbers.push(...(joined.match(/V\d+-\d+\/\d{4}/gu) ?? []));
    const stand = cells.slice(30).find((value) => /^[0-9]{1,2}[A-Z]{1,2}[0-9]{1,3}$/u.test(value));
    if (stand) stands.push(`${stand} (ř. ${rowNumber})`);
    const code = cellText(row.getCell("C").value);
    if (/^[A-Z0-9]{1,4}$/u.test(code)) {
      const quantity = cells.slice(12).map(parseCzechNumber).find((value) => value !== undefined);
      current.items.push({ code, quantity });
      current.rows.push(rowNumber);
    }
    if (/^(Zálohové listy:|Částky v CZK)/u.test(joined) && current.items.length > 0) {
      blocks.push(current);
      current = { rows: [], items: [] };
    }
  });
  if (current.items.length > 0) blocks.push(current);
  return { blocks, headerNumbers: [...new Set(headerNumbers)], stands };
}

function findOrder(orders: readonly AbraOrder[], block: ExcelBlock): AbraOrder | undefined {
  const signature = block.items.map((item) => `${item.code}=${item.quantity}`).join(",");
  return orders.find((order) => order.items.map((item) => `${item.code}=${item.quantity}`).join(",").includes(signature));
}

async function main(): Promise<number> {
  if (!existsSync(dir)) {
    console.log(`SKIP: ${dir} nenalezen — reálné objednávky nejsou k dispozici (nejsou v Gitu).`);
    return 0;
  }
  const files = readdirSync(dir);
  const pdfName = files.find((name) => name.toLowerCase().endsWith(".pdf"));
  const xlsxName = files.find((name) => name.toLowerCase().endsWith(".xlsx"));
  if (!pdfName) {
    console.log("SKIP: v adresáři není PDF formuláře objednávek.");
    return 0;
  }

  const parsed = parseAbraOrderFormPdf(await pdfItems(path.join(dir, pdfName)));
  const result = buildAbraOrderTechnicalImport(parsed);
  console.log(`PDF ${pdfName}`);
  console.log(`  ${JSON.stringify(result.counts)}`);
  const pagesPerOrder = new Map<number, number>();
  for (const order of parsed.orders) pagesPerOrder.set(order.pages.length, (pagesPerOrder.get(order.pages.length) ?? 0) + 1);
  console.log(`  orders by page count: ${[...pagesPerOrder].sort(([a], [b]) => a - b).map(([pages, count]) => `${pages} str. ×${count}`).join(", ")}; pages assigned: ${parsed.orders.reduce((sum, order) => sum + order.pages.length, 0)}/${parsed.pageCount}`);
  console.log(`  ambiguous pages: ${parsed.ambiguousPages.length}`);
  for (const page of parsed.ambiguousPages) console.log(`    ⚠ s.${page.page} ${page.orderNumber ?? "?"} č.${page.pageOfOrder ?? "?"}: ${page.reason} — ${page.itemCount} položek (${page.itemCodes.join(", ")})`);
  console.log(`  parser warnings: ${parsed.warnings.length}`);
  for (const warning of parsed.warnings) console.log(`    ⚠ ${warning.orderNumber ?? ""} s.${warning.page}: ${warning.message} ${warning.rawText ?? ""}`);
  console.log(`  services without stand: ${result.servicesWithoutStand.length}`);
  for (const line of result.servicesWithoutStand) console.log(`    ${line.orderNumber} | ${line.companyName} | ${line.code} ${line.name} | ${line.quantityRaw} ${line.unit}`);
  console.log(`  L63 BEZ ELEKTRICKÉ ENERGIE: ${result.noElectricityLines.map((line) => `${line.orderNumber} ${line.standNumber ?? "(bez stánku)"}`).join("; ") || "—"}`);
  console.log(`  unknown technical codes: ${result.unknownTechnicalCodes.map((code) => `${code.code} ${code.name} ×${code.itemCount} (${code.orderNumbers.join(", ")})`).join("; ") || "—"}`);
  for (const item of result.reviewItems.filter((entry) => entry.kind !== "unknownTechnicalCode")) console.log(`    review ${item.kind}: ${item.orderNumber} ${item.standNumber ?? "-"} ${item.code || "(bez kódu)"} ${item.name} ${item.quantityRaw}`);
  const perCategory = new Map<string, number>();
  for (const line of result.importedLines) perCategory.set(line.category, (perCategory.get(line.category) ?? 0) + 1);
  console.log(`  imported per category: ${JSON.stringify(Object.fromEntries(perCategory))}`);

  if (!xlsxName) return 0;
  const excel = await excelBlocks(path.join(dir, xlsxName));
  console.log(`\nExcel ${xlsxName}: ${excel.blocks.length} blok(y) položek, hlavičky objednávek: ${excel.headerNumbers.join(", ") || "—"}, stánky: ${excel.stands.join(", ") || "—"}`);
  let problems = 0;
  excel.blocks.forEach((block, index) => {
    const order = findOrder(parsed.orders, block);
    console.log(`  blok ${index + 1} (ř. ${block.rows[0]}–${block.rows.at(-1)}, ${block.items.length} položek) = ${order ? `${order.orderNumber} (stánek ${order.standNumber ?? "—"}, ${order.items.length} položek v PDF)` : "NENALEZEN v PDF"}`);
    if (!order || order.items.length !== block.items.length || (index === 0 && excel.headerNumbers[0] !== order.orderNumber)) problems += 1;
  });
  console.log(problems === 0 ? "  ✔ Excel odpovídá PDF" : `  ✖ Excel NEodpovídá PDF (${problems} problémů) — ${excel.blocks.length} z ${parsed.orders.length} objednávek, hlavička ${excel.headerNumbers[0] ?? "—"} patří k jiným položkám → Excel nelze importovat`);
  return 0;
}

process.exitCode = await main();
