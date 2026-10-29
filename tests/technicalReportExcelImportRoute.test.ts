import assert from "node:assert/strict";
import test from "node:test";
import ExcelJS from "exceljs";
import { NextRequest } from "next/server.js";
import { handleTechnicalReportExcelImport } from "../app/api/technical-rasters/import-excel/route.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import { validateUploadInput } from "../domain/assets.ts";
import type { ParsedTechnicalReport } from "../domain/technicalRaster.ts";
import type { TechnicalExcelImportCheck } from "../domain/technicalReportExcelTable.ts";
import { ELECTRICITY_LAYOUT, INTERNET_LAYOUT, writeLayout, type CellLayout } from "./technicalReportExcelFixtures.ts";

// =========================================================================================
// Technické rastry — the parse-only Excel import route, end to end through a real .xlsx buffer
// (exceljs write → readTechnicalReportWorkbook → mapping), on the real ABRA export structures.
// =========================================================================================

const SECRET = "technical-report-excel-route-test-secret-32ch";
(process.env as Record<string, string | undefined>).APP_SESSION_SECRET = SECRET;
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function xlsxFile(layout: CellLayout, name = "Přehled - test.xlsx"): Promise<File> {
  const workbook = new ExcelJS.Workbook();
  writeLayout(workbook.addWorksheet("List1"), layout);
  return new File([await workbook.xlsx.writeBuffer()], name, { type: XLSX_MIME });
}

async function post(file: File | undefined, category: string | undefined, token: string | undefined) {
  const formData = new FormData();
  if (file) formData.append("file", file);
  if (category) formData.append("category", category);
  const headers: Record<string, string> = {};
  if (token) headers.Cookie = `homeworkstudio_session=${token}`;
  return handleTechnicalReportExcelImport(new NextRequest("http://localhost/api/technical-rasters/import-excel", { method: "POST", headers, body: formData }));
}

test("excel import route: requires a session", async () => {
  const response = await post(await xlsxFile(INTERNET_LAYOUT), "internet", undefined);
  assert.equal(response.status, 401);
});

test("excel import route: rejects a missing file, an unknown category and a non-xlsx file", async () => {
  const token = await createSessionToken(SECRET);
  assert.equal((await post(undefined, "internet", token)).status, 400);
  assert.equal((await post(await xlsxFile(INTERNET_LAYOUT), "neexistuje", token)).status, 400);
  const notXlsx = await post(new File(["Stánek;Firma"], "vyjezd.xlsx", { type: XLSX_MIME }), "internet", token);
  assert.equal(notXlsx.status, 422);
  assert.match(((await notXlsx.json()) as { error: string }).error, /XLSX/u);
});

test("excel import route: internet export → the same ParsedTechnicalReport shape the PDF path gives, plus check and category hint", async () => {
  const token = await createSessionToken(SECRET);
  const response = await post(await xlsxFile(INTERNET_LAYOUT), "internet", token);
  assert.equal(response.status, 200);
  const body = await response.json() as { report: ParsedTechnicalReport; check: TechnicalExcelImportCheck; detectedCategory?: string };
  assert.equal(body.report.category, "internet");
  assert.deepEqual(body.report.rows.map((row) => [row.standNumber, row.companyName, row.services.map((service) => `${service.externalLabel}=${service.quantity}`)]), [
    ["3A21", "Firma Alfa a.s.", ["WIFI=1"]],
    ["3A45", "Firma Beta spol. s r.o.", ["Pevná IP=1", "Internet=1", "Router zapůjčení=1"]],
    ["4A19", "Firma Gama s.r.o.", ["Internet=1", "Další přípojka=1"]],
  ]);
  assert.deepEqual(body.report.warnings, []);
  assert.deepEqual(body.check.totals, { status: "match" });
  assert.equal(body.detectedCategory, "internet");
});

test("excel import route: electricity export keeps the explicit „BEZ“ normalization of an all-zero row", async () => {
  const token = await createSessionToken(SECRET);
  const response = await post(await xlsxFile(ELECTRICITY_LAYOUT), "electricity", token);
  const body = await response.json() as { report: ParsedTechnicalReport; check: TechnicalExcelImportCheck };
  assert.deepEqual(body.report.rows.filter((row) => row.explicitNoServiceAssignment).map((row) => row.standNumber), ["3A02"]);
  assert.equal(body.check.columns.length, 17);
  assert.deepEqual(body.check.totals, { status: "match" });
});

test("the import asset category accepts the Excel export next to the PDF, nothing else", () => {
  const base = { category: "technical-raster-import", ownerId: "raster-1", size: 20_000 };
  assert.doesNotThrow(() => validateUploadInput({ ...base, originalFileName: "Přehled - elektrická energie.xlsx", mimeType: XLSX_MIME }));
  assert.doesNotThrow(() => validateUploadInput({ ...base, originalFileName: "Přehled - elektrická energie.pdf", mimeType: "application/pdf" }));
  assert.throws(() => validateUploadInput({ ...base, originalFileName: "Přehled.xls", mimeType: "application/vnd.ms-excel" }));
});
