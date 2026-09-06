import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../lib/auth/requestAuth.ts";
import { readWorkbookFromBuffer, extractSheetGrid } from "../../../../lib/import/xlsxReader.server.ts";
import { importPrintSurfaceExcel, PRINT_SURFACE_EXCEL_SHEET_NAME } from "../../../../domain/printSurfaceExcelImport.ts";

/**
 * Parses an uploaded "Tiskové plochy" catalog XLSX and returns the structured import result
 * (companies/presets/productionDimensions + validation issues) — it never persists anything.
 * exceljs needs Node's Buffer, so this parsing can only happen server-side (see
 * lib/import/xlsxReader.server.ts); the caller applies the result client-side by writing it into
 * the three catalog repositories (see components/workflow/printSurfaces/PrintSurfaceCatalogImportPanel.tsx).
 */
export async function handlePrintSurfaceExcelImport(request: NextRequest): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro import katalogu tiskových ploch je vyžadováno přihlášení." }, { status: 401 });
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Neplatný požadavek — očekáván nahraný soubor." }, { status: 400 });
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Chybí soubor k importu." }, { status: 400 });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "Soubor se nepodařilo přečíst." }, { status: 400 });
  }

  try {
    const workbook = await readWorkbookFromBuffer(buffer);
    const rows = extractSheetGrid(workbook, PRINT_SURFACE_EXCEL_SHEET_NAME);
    const outcome = importPrintSurfaceExcel(rows);
    if (outcome.ok === false) {
      return NextResponse.json({ error: outcome.error.message }, { status: 422 });
    }
    return NextResponse.json({ result: outcome.result });
  } catch {
    return NextResponse.json({ error: "Soubor se nepodařilo zpracovat jako XLSX." }, { status: 422 });
  }
}

export async function POST(request: NextRequest) {
  return handlePrintSurfaceExcelImport(request);
}
