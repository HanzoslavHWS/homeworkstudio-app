import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { RawCellValue, RawSheetRow } from "../../domain/priceImport.ts";
import type { PdfTextItem } from "../../domain/technicalReportTableParsing.ts";
import type { VendorSheetGrid } from "../../domain/settlementCreativExpoImport.ts";
import { extractSheetGrid, readWorkbookFromBufferTolerant } from "../../lib/import/xlsxReader.server.ts";

/**
 * Shared fixtures for the settlement tests: the REAL reference files (present only in the
 * git-ignored _IMPORT/vyuctovani_creativ/ folder) and a synthetic Creativ Expo sheet with the
 * exact layout of the real template.
 */
export const REAL_DIR = fileURLToPath(new URL("../../_IMPORT/vyuctovani_creativ/", import.meta.url));
export const REAL_FILES = {
  hall3: `${REAL_DIR}Beauty podzim 2026 hala 3.xlsx`,
  hall4: `${REAL_DIR}Beauty podzim 2026 hala 4.xlsx`,
  abfXlsx: `${REAL_DIR}creativ_stavby.xlsx`,
  abfPdf: `${REAL_DIR}creativ_stavby.pdf`,
};

export async function readSheets(path: string): Promise<readonly VendorSheetGrid[]> {
  const workbook = await readWorkbookFromBufferTolerant(readFileSync(path));
  return workbook.worksheets.map((sheet) => ({ name: sheet.name, rows: extractSheetGrid(workbook, sheet.name) }));
}

export async function readPdfTextItems(path: string): Promise<readonly PdfTextItem[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const document = await pdfjs.getDocument({ data: new Uint8Array(readFileSync(path)), verbosity: 0 }).promise;
  const items: PdfTextItem[] = [];
  for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
    const content = await (await document.getPage(pageNumber)).getTextContent();
    for (const item of content.items as readonly { str: string; width: number; height: number; transform: number[] }[]) {
      if (item.str.trim()) items.push({ str: item.str, page: pageNumber, x: item.transform[4]!, y: item.transform[5]!, width: item.width, height: item.height || Math.abs(item.transform[3]!) });
    }
  }
  return items;
}

/** Prices are neutral placeholders — never the realization company's real price list (the repository is public). */
export const CREATIV_TEMPLATE: readonly (readonly [string, number])[] = [
  ["typový stánek octanorm - T9", 100],
  ["stavba octanorm 1 m2", 200],
  ["stěna plná - octanorm (výška 250 cm) - 1 bm", 300],
  ["koberec šedý Kč/1m2", 400],
  ["koberec jiné barvy Kč/1m2", 500],
  ["límec, výška 30 cm Kč/bm", 600],
  ["stropní podhled bílý Kč/1m", 700],
  ["trojzásuvka", 800],
  ["židle čalouněná", 900],
  ["drátěný program/chrom/1x1,5m", 1000],
  ["zapůjčení TV (40\")/den", 1100],
];

export function creativSheet(name: string, title: string | null, quantities: Readonly<Record<string, RawCellValue>> = {}, extraRows: readonly RawSheetRow[] = []): VendorSheetGrid {
  const event = "Beauty podzim 2026 hala 3";
  const rows: RawSheetRow[] = [
    [event, event, event, event],
    [title, "Cena pro ABF"],
    ["Položka ", "Cena/kus/m2/bm", "Kusy/m2/bm", "Cena /položku"],
    ...CREATIV_TEMPLATE.map(([item, price]): RawSheetRow => {
      const quantity = quantities[item] ?? null;
      return [item, price, quantity, typeof quantity === "number" ? price * quantity : null];
    }),
    ...extraRows,
    [null, null, null, null],
    ["přirážka jen vybavení 40%", 44, null, null, "pokud je, napiš do kolonky \"kusy\" 1"],
    ["Celková cena bez DPH ", null, null, 1595],
  ];
  return { name, rows };
}
