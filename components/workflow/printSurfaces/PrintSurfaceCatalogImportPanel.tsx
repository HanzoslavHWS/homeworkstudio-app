"use client";

import { useState } from "react";
import type { PrintSurfaceExcelImportResult } from "../../../domain/printSurfaceExcelImport";
import type { RealizationCompanyRepository } from "../../../domain/realizationCompany";
import type { PrintSurfacePresetRepository } from "../../../domain/printSurfacePreset";
import type { PrintSurfaceProductionDimensionRepository } from "../../../domain/printSurfaceProductionDimension";

const ISSUE_CODE_LABELS: Record<string, string> = {
  DUPLICATE_INTERNAL_ID: "Duplicitní interní ID",
  UNKNOWN_PARENT_ID: "Neznámý parent_id",
  UNKNOWN_TYPE: "Neznámý/nejednoznačný typ",
  EMPTY_NAME: "Prázdný název",
  INVALID_DIMENSION: "Neplatný rozměr",
  INCOMPLETE_DIMENSION: "Neúplný rozměr",
  INVALID_NO_VALUE: "Neplatné NO",
  DUPLICATE_COMPANY_PRESET: "Duplicitní kombinace realizačka + plocha",
};

/**
 * "Data tiskových ploch" — import katalogu (realizačky/presety/výrobní rozměry) ze skutečného
 * Excelu. Parsing běží server-side (app/api/print-surfaces/import, exceljs potřebuje Node Buffer —
 * viz lib/import/xlsxReader.server.ts) a vrací jen strukturovaný náhled; teprve po potvrzení se
 * výsledek zapíše do repozitářů (replaceAll) — nikdy se nic nepřepíše tiše ani při chybách.
 */
export function PrintSurfaceCatalogImportPanel({
  companyRepository,
  presetRepository,
  productionDimensionRepository,
  hasExistingData,
  onImported,
}: {
  companyRepository: RealizationCompanyRepository;
  presetRepository: PrintSurfacePresetRepository;
  productionDimensionRepository: PrintSurfaceProductionDimensionRepository;
  hasExistingData: boolean;
  onImported: () => void;
}) {
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [preview, setPreview] = useState<PrintSurfaceExcelImportResult | null>(null);
  const [isApplying, setIsApplying] = useState(false);
  const [appliedMessage, setAppliedMessage] = useState("");

  async function handleFileSelected(file: File) {
    setPreviewError("");
    setPreview(null);
    setAppliedMessage("");
    setIsLoadingPreview(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      const response = await fetch("/api/print-surfaces/import", {
        method: "POST",
        credentials: "same-origin",
        body: formData,
      });
      const body = (await response.json()) as { result?: PrintSurfaceExcelImportResult; error?: string };
      if (!response.ok || !body.result) {
        setPreviewError(body.error ?? "Import se nezdařil.");
        return;
      }
      setPreview(body.result);
    } catch {
      setPreviewError("Import se nezdařil.");
    } finally {
      setIsLoadingPreview(false);
    }
  }

  async function handleApply() {
    if (!preview || preview.counts.errors > 0 || isApplying) return;
    if (hasExistingData && !window.confirm("Import přepíše aktuální katalog realizaček, presetů a výrobních rozměrů tiskových ploch. Pokračovat?")) {
      return;
    }
    setIsApplying(true);
    try {
      await companyRepository.replaceAll(preview.companies);
      await presetRepository.replaceAll(preview.presets);
      await productionDimensionRepository.replaceAll(preview.productionDimensions);
      setAppliedMessage("Import byl úspěšně aplikován.");
      setPreview(null);
      onImported();
    } catch {
      setPreviewError("Uložení importu se nezdařilo.");
    } finally {
      setIsApplying(false);
    }
  }

  return (
    <div className="printSurfaceImportPanel">
      <label className="filePicker compact">
        <span>{isLoadingPreview ? "Načítám…" : "Importovat Excel"}</span>
        <input
          type="file"
          accept=".xlsx"
          disabled={isLoadingPreview}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFileSelected(file);
            event.target.value = "";
          }}
        />
      </label>

      {previewError && <p className="uploadError">{previewError}</p>}
      {appliedMessage && <p className="emailsConfirmation">{appliedMessage}</p>}

      {preview && (
        <div className="printSurfaceImportSummary">
          <p className="fieldHint">
            Realizačky: {preview.counts.realizationCompanies} · Presety: {preview.counts.presets} ·
            {" "}Dostupné rozměry: {preview.counts.available} · Nedostupné kombinace: {preview.counts.unavailable} ·
            {" "}Nedefinované/neúplné: {preview.counts.notDefinedOrIncomplete} ·
            {" "}Varování: {preview.counts.warnings} · Chyby: {preview.counts.errors}
          </p>

          {preview.issues.length > 0 && (
            <ul className="printSurfaceImportIssues">
              {preview.issues.map((issue, index) => (
                <li key={index} className={issue.severity === "error" ? "error" : "warning"}>
                  <strong>{ISSUE_CODE_LABELS[issue.code] ?? issue.code}</strong>
                  {issue.internalId && ` — ${issue.internalId}`}
                  {issue.companyName && ` (${issue.companyName})`}
                  {issue.sourceRow && ` [řádek ${issue.sourceRow}]`}
                  : {issue.message}
                </li>
              ))}
            </ul>
          )}

          {preview.counts.errors > 0 ? (
            <p className="uploadError">Import obsahuje chyby — data nebyla aplikována. Opravte Excel a zkuste import znovu.</p>
          ) : (
            <button type="button" className="primaryButton" onClick={handleApply} disabled={isApplying}>
              {isApplying ? "Ukládám…" : "Aplikovat import"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
