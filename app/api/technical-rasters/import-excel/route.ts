import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../lib/auth/requestAuth.ts";
import { readTechnicalReportWorkbook } from "../../../../lib/import/technicalReportWorkbookReader.server.ts";
import { parseTechnicalReportWorkbook } from "../../../../domain/technicalReportExcelTable.ts";
import { detectLikelyTechnicalReportCategory, getTechnicalReportParser } from "../../../../domain/technicalReportParsers/index.ts";

/**
 * Parses an uploaded technical-report XLSX (ABRA "Přehled - …" export) for the chosen category and
 * returns the same ParsedTechnicalReport the client-side PDF parse produces, plus the Excel control
 * report — it never persists anything. exceljs needs Node's Buffer, so this can only run
 * server-side (see lib/import/xlsxReader.server.ts); the caller keeps using its own preview and
 * confirm flow (components/workflow/technicalRasters/TechnicalServiceImportPanel.tsx).
 */
export async function handleTechnicalReportExcelImport(request: NextRequest): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro import technického výjezdu je vyžadováno přihlášení." }, { status: 401 });
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
  const category = formData.get("category");
  if (typeof category !== "string" || !getTechnicalReportParser(category)) {
    return NextResponse.json({ error: "Neznámý typ technického výjezdu." }, { status: 400 });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: "Soubor se nepodařilo přečíst." }, { status: 400 });
  }

  let workbook;
  try {
    workbook = await readTechnicalReportWorkbook(buffer);
  } catch {
    return NextResponse.json({ error: "Soubor se nepodařilo zpracovat jako XLSX." }, { status: 422 });
  }
  const { report, check, titleText } = parseTechnicalReportWorkbook(category, workbook);
  return NextResponse.json({ report, check, detectedCategory: detectLikelyTechnicalReportCategory(titleText) });
}

export async function POST(request: NextRequest) {
  return handleTechnicalReportExcelImport(request);
}
