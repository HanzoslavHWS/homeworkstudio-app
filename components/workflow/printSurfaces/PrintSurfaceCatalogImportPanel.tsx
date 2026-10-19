"use client";

import { useState } from "react";
import type { PrintSurfaceExcelImportResult } from "../../../domain/printSurfaceExcelImport";
import type { PrintSurfaceCatalogSyncOptions, PrintSurfaceCatalogSyncPlan } from "../../../domain/printSurfaceCatalogSync";
import { printSurfaceCatalogSyncApi } from "../../../lib/db/realizationCompanyRepository.remoteApi.client";

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
 * "Data tiskových ploch" — synchronizace katalogu (realizačky/presety/výrobní rozměry) ze
 * skutečného Excelu (V1-DATA-02, B1). Parsing běží server-side (app/api/print-surfaces/import),
 * náhled i zápis počítá server proti aktuální databázi (app/api/print-surfaces/catalog/sync).
 * Nic se nemaže: nové záznamy se vloží, změněné aktualizují, chybějící zůstanou. Zápis je jedna
 * transakce — buď celý, nebo nic.
 */
export function PrintSurfaceCatalogImportPanel({ onImported }: { onImported: () => void }) {
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [imported, setImported] = useState<PrintSurfaceExcelImportResult | null>(null);
  const [plan, setPlan] = useState<PrintSurfaceCatalogSyncPlan | null>(null);
  const [options, setOptions] = useState<PrintSurfaceCatalogSyncOptions>({ deactivateMissingPresets: false, deactivateMissingCompanies: false });
  const [isApplying, setIsApplying] = useState(false);
  const [appliedMessage, setAppliedMessage] = useState("");

  async function refreshPlan(result: PrintSurfaceExcelImportResult, nextOptions: PrintSurfaceCatalogSyncOptions) {
    setPlan(null);
    try {
      setPlan(await printSurfaceCatalogSyncApi.preview(result, nextOptions));
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Náhled synchronizace se nepodařilo připravit.");
    }
  }

  async function handleFileSelected(file: File) {
    setPreviewError("");
    setImported(null);
    setPlan(null);
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
      setImported(body.result);
      if (body.result.counts.errors === 0) await refreshPlan(body.result, options);
    } catch {
      setPreviewError("Import se nezdařil.");
    } finally {
      setIsLoadingPreview(false);
    }
  }

  function changeOption(patch: PrintSurfaceCatalogSyncOptions) {
    const nextOptions = { ...options, ...patch };
    setOptions(nextOptions);
    if (imported && imported.counts.errors === 0) void refreshPlan(imported, nextOptions);
  }

  async function handleApply() {
    if (!imported || !plan?.canApply || isApplying) return;
    setIsApplying(true);
    try {
      await printSurfaceCatalogSyncApi.apply(imported, options);
      setAppliedMessage("Synchronizace proběhla. Nic nebylo smazáno.");
      setImported(null);
      setPlan(null);
      onImported();
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : "Synchronizace selhala, nic nebylo změněno.");
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

      {imported && (
        <div className="printSurfaceImportSummary">
          <p className="fieldHint">
            Realizačky: {imported.counts.realizationCompanies} · Presety: {imported.counts.presets} ·
            {" "}Dostupné rozměry: {imported.counts.available} · Nedostupné kombinace: {imported.counts.unavailable} ·
            {" "}Nedefinované/neúplné: {imported.counts.notDefinedOrIncomplete} ·
            {" "}Varování: {imported.counts.warnings} · Chyby: {imported.counts.errors}
          </p>

          {imported.issues.length > 0 && (
            <ul className="printSurfaceImportIssues">
              {imported.issues.map((issue, index) => (
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

          {imported.counts.errors > 0 && <p className="uploadError">Import obsahuje chyby — data nebyla aplikována. Opravte Excel a zkuste import znovu.</p>}

          {plan && (
            <>
              <p className="fieldHint"><strong>Náhled změn</strong> (nic se nemaže)</p>
              <ul className="printSurfaceImportIssues">
                {plan.companies.map((company) => (
                  <li key={company.excelName}>
                    Sloupec „{company.excelName}“ →{" "}
                    {company.action === "create"
                      ? <>nová firma <code>{company.id}</code></>
                      : <>existující firma „{company.companyName}“ (<code>{company.id}</code>{company.matchedBy === "name" ? ", podle názvu" : ""}{company.inactive ? ", neaktivní" : ""})</>}
                  </li>
                ))}
              </ul>
              <p className="fieldHint">
                Presety: nové {plan.presets.create} · změněné {plan.presets.update} · beze změny {plan.presets.unchanged} ·
                {" "}Rozměry: nové {plan.productionDimensions.create} · změněné {plan.productionDimensions.update} · beze změny {plan.productionDimensions.unchanged} ·
                {" "}Ponechané rozměry mimo soubor: {plan.keptDimensionCount}
              </p>
              {(plan.missingPresetIds.length > 0 || plan.missingCompanyIds.length > 0) && (
                <p className="fieldHint">
                  V souboru chybí: {plan.missingPresetIds.length} presetů, {plan.missingCompanyIds.length} firem. Ve výchozím stavu zůstanou beze změny.
                </p>
              )}
              <label className="checkLabel">
                <input type="checkbox" checked={Boolean(options.deactivateMissingPresets)} onChange={(event) => changeOption({ deactivateMissingPresets: event.target.checked })} />
                {" "}Deaktivovat presety, které v souboru chybí ({plan.payload.deactivatePresetIds.length})
              </label>
              <label className="checkLabel">
                <input type="checkbox" checked={Boolean(options.deactivateMissingCompanies)} onChange={(event) => changeOption({ deactivateMissingCompanies: event.target.checked })} />
                {" "}Deaktivovat importované firmy, které v souboru chybí ({plan.payload.deactivateCompanyIds.length}; ručně založené firmy se nikdy nedeaktivují)
              </label>
              {plan.issues.length > 0 && (
                <ul className="printSurfaceImportIssues">
                  {plan.issues.map((issue, index) => (
                    <li key={index} className={issue.severity === "error" ? "error" : "warning"}>{issue.message}</li>
                  ))}
                </ul>
              )}
              {plan.canApply ? (
                <button type="button" className="primaryButton" onClick={handleApply} disabled={isApplying}>
                  {isApplying ? "Ukládám…" : "Aplikovat synchronizaci"}
                </button>
              ) : (
                <p className="uploadError">Synchronizace obsahuje blokující chyby — nic nebylo zapsáno.</p>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
