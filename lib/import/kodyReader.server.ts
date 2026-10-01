import { extractSheetGrid, readWorkbookFromBufferTolerant } from "./xlsxReader.server.ts";
import { KODY_SOURCE_SHEET, KodyFormatError, parseKodyPricelist, type KodyRow } from "../../domain/catalogAbfImport.ts";

/** Reads the PRICELIST sheet of a KODY.xlsm-style workbook into plain rows (read-only, macros never run). */
export async function readKodyRowsFromBuffer(buffer: Buffer): Promise<readonly KodyRow[]> {
  const workbook = await readWorkbookFromBufferTolerant(buffer);
  if (!workbook.getWorksheet(KODY_SOURCE_SHEET)) throw new KodyFormatError(`Soubor neobsahuje list ${KODY_SOURCE_SHEET}.`);
  return parseKodyPricelist(extractSheetGrid(workbook, KODY_SOURCE_SHEET));
}
