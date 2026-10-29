"use client";

import { useState } from "react";
import { TECHNICAL_SERVICE_CATEGORIES, technicalServiceCategoryLabel } from "../../../domain/technicalServiceCatalog";
import type { ParsedTechnicalReport, TechnicalRasterImport } from "../../../domain/technicalRaster";
import type { TechnicalExcelImportCheck } from "../../../domain/technicalReportExcelTable";
import { getTechnicalReportParser, detectLikelyTechnicalReportCategory } from "../../../domain/technicalReportParsers";
import { loadPdfDocument } from "../../../lib/pdf/pdfDocumentLoader";
import { extractPdfTextItems } from "../../../lib/pdf/pdfTextExtraction";

export type TechnicalImportSourceFormat = "pdf" | "xlsx";

export type PendingTechnicalImport = Readonly<{
  category: string;
  file: File;
  sourceFormat: TechnicalImportSourceFormat;
  report: ParsedTechnicalReport;
  /** Excel only: what was read from which sheet/columns and whether the sums match the report's own "Celkem" row. */
  excelCheck?: TechnicalExcelImportCheck;
  /** Set when an import of this SAME category already exists — user must explicitly confirm replacing it (spec section 24). */
  replaceImportId?: string;
}>;

export const TECHNICAL_IMPORT_PARSER_VERSIONS: Readonly<Record<TechnicalImportSourceFormat, string>> = { pdf: "v1", xlsx: "xlsx-v1" };

const XLSX_MIME_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function sourceFormatOf(file: File): TechnicalImportSourceFormat | "csv" | "xls" | undefined {
  const extension = file.name.toLowerCase().split(".").pop();
  if (extension === "pdf" || file.type === "application/pdf") return "pdf";
  if (extension === "xlsx" || file.type === XLSX_MIME_TYPE) return "xlsx";
  if (extension === "csv") return "csv";
  if (extension === "xls") return "xls";
  return undefined;
}

type ParsedTechnicalFile = Readonly<{ report: ParsedTechnicalReport; check?: TechnicalExcelImportCheck; hint?: string }>;

async function parsePdfReport(file: File, category: string): Promise<ParsedTechnicalFile> {
  const buffer = await file.arrayBuffer();
  const document = await loadPdfDocument({ data: buffer });
  let items;
  try {
    items = await extractPdfTextItems(document);
  } finally {
    // A short-lived, never-stored document used only for this one-time parse preview — must
    // be destroyed here or its worker/WASM resources leak (spec batch 2.5 section 21).
    void document.destroy();
  }

  const sampleText = items.slice(0, 200).map((item) => item.str).join(" ");
  const parser = getTechnicalReportParser(category);
  if (!parser) throw new Error(`Pro kategorii "${technicalServiceCategoryLabel(category)}" zatím neexistuje parser.`);
  return { report: parser.parse(items), hint: detectLikelyTechnicalReportCategory(sampleText) };
}

/** Excel is parsed server-side (exceljs needs Node) — the route only parses, nothing is stored until the user confirms the preview. */
async function parseExcelReport(file: File, category: string): Promise<ParsedTechnicalFile> {
  const formData = new FormData();
  formData.append("file", file);
  formData.append("category", category);
  const response = await fetch("/api/technical-rasters/import-excel", { method: "POST", body: formData });
  const body = await response.json().catch(() => ({})) as { report?: ParsedTechnicalReport; check?: TechnicalExcelImportCheck; detectedCategory?: string; error?: string };
  if (!response.ok || !body.report) throw new Error(body.error ?? "Excel se nepodařilo zpracovat.");
  return { report: body.report, check: body.check, hint: body.detectedCategory };
}

/**
 * "Nahrát technický výjezd" (spec section 8/9): user picks a category (manual — autodetection is
 * only ever a hint, spec section 8) and a PDF or the ABRA Excel export (.xlsx) of the same report.
 * The file is parsed IMMEDIATELY (PDF client-side, Excel by the parse-only route; no upload yet)
 * so parse stats/warnings can be reviewed before anything is committed (spec section 25: "Fail
 * loudly, not silently" — every problem is shown, nothing is silently dropped).
 */
export function TechnicalServiceImportPanel({
  existingImportsByCategory,
  onPendingImportReady,
}: {
  existingImportsByCategory: ReadonlyMap<string, TechnicalRasterImport>;
  onPendingImportReady: (pending: PendingTechnicalImport) => void;
}) {
  const [category, setCategory] = useState(TECHNICAL_SERVICE_CATEGORIES[0]!.id);
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState("");
  const [detectedHint, setDetectedHint] = useState<string | undefined>(undefined);

  async function handleFileSelected(file: File) {
    setError("");
    setDetectedHint(undefined);
    const format = sourceFormatOf(file);
    if (format === "csv") {
      setError("CSV export z ABRA zatím není podporován (chybné kódování a rozpadlé uvozovky u názvů firem) — nahrajte stejný přehled jako Excel (.xlsx) nebo PDF.");
      return;
    }
    if (format === "xls") {
      setError("Starý formát Excelu (.xls) není podporován — uložte přehled jako .xlsx nebo nahrajte PDF.");
      return;
    }
    if (!format) {
      setError("Nepodporovaný typ souboru — nahrajte PDF nebo Excel (.xlsx).");
      return;
    }

    setIsParsing(true);
    try {
      const parsed = format === "xlsx" ? await parseExcelReport(file, category) : await parsePdfReport(file, category);
      if (parsed.hint && parsed.hint !== category) setDetectedHint(parsed.hint);

      const existing = existingImportsByCategory.get(category);
      onPendingImportReady({
        category,
        file,
        sourceFormat: format,
        report: parsed.report,
        excelCheck: parsed.check,
        replaceImportId: existing?.id,
      });
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : format === "xlsx" ? "Excel se nepodařilo zpracovat." : "PDF se nepodařilo zpracovat.");
    } finally {
      setIsParsing(false);
    }
  }

  return (
    <div className="workflowCard technicalServiceImportPanel">
      <div className="workflowCardHeader"><div><span>IMPORT</span><strong>Nahrát technický výjezd</strong></div></div>
      <div className="workspaceFormRow">
        <label>
          <span>Typ</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            {TECHNICAL_SERVICE_CATEGORIES.map((option) => <option key={option.id} value={option.id}>{option.labelCz}</option>)}
          </select>
        </label>
        <label className="filePicker">
          <span>{isParsing ? "Zpracovávám…" : "Vybrat PDF nebo Excel"}</span>
          <input
            type="file"
            accept={`application/pdf,.pdf,${XLSX_MIME_TYPE},.xlsx`}
            disabled={isParsing}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void handleFileSelected(file);
              event.target.value = "";
            }}
          />
        </label>
      </div>
      {detectedHint && <p className="fieldHint">Podle obsahu souboru vypadá spíš jako: {technicalServiceCategoryLabel(detectedHint)} — zkontrolujte vybraný typ.</p>}
      {existingImportsByCategory.has(category) && <p className="fieldHint">Pro tuto kategorii už existuje dřívější import — nahrání nového souboru nabídne jeho nahrazení.</p>}
      {error && <p className="uploadError">{error}</p>}
    </div>
  );
}
