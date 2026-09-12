"use client";

import { useState } from "react";
import { loadPdfDocument } from "../../../lib/pdf/pdfDocumentLoader";
import { extractPdfTextItems } from "../../../lib/pdf/pdfTextExtraction";
import { parseSupplementalCatalogPdf } from "../../../domain/technicalRasterCatalogImport";
import { reconcileTechnicalReportAndCatalog } from "../../../domain/technicalRasterReconciliation";
import { buildPrimaryReportMentions, type TechnicalRasterProject } from "../../../domain/technicalRaster";
import { resolveRealizationDisplayState } from "../../../domain/technicalRasterRealization";

/**
 * Corrective batch (post real-file acceptance test) section 7/8/11 — the import path for the
 * SUPPLEMENTAL/CONTROL source ("5. Stavby - tisk vše katalog"), deliberately its OWN panel/upload
 * button, never folded into `TechnicalServiceImportPanel.tsx`'s "Technický report" category picker
 * (spec section 11: "Rozliš source type... Nevkládej ho do parseru elektrická energie"). Parses
 * client-side immediately (same discipline as the primary-report import) and merges straight away
 * — `mergeSupplementalCatalogImport` is a pure "latest wins" replace (see its own doc), so a
 * re-upload is always safe to just re-run, no separate undo path needed.
 *
 * Shows, per spec section 11's own explicit minimum: stand count, recognized-realization count,
 * and the full reconciliation summary (shoda/only_report/only_catalog/quantity_mismatch/conflict)
 * — recomputed LIVE from the project's current services + the last import's own catalogMentions,
 * never a stale snapshot from import time (services can change independently afterward).
 */
export function TechnicalCatalogImportPanel({
  project,
  onImport,
}: {
  project: TechnicalRasterProject;
  /** Receives the freshly-parsed catalog import — the caller is expected to call `mergeSupplementalCatalogImport(current, parsed, file.name)` inside its own project updater, exactly like every other project mutation in this editor. */
  onImport: (parsed: ReturnType<typeof parseSupplementalCatalogPdf>, filename: string) => void;
}) {
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState("");

  async function handleFileSelected(file: File) {
    setError("");
    setIsParsing(true);
    try {
      const buffer = await file.arrayBuffer();
      const document = await loadPdfDocument({ data: buffer });
      let items;
      try {
        items = await extractPdfTextItems(document);
      } finally {
        void document.destroy();
      }
      const parsed = parseSupplementalCatalogPdf(items);
      onImport(parsed, file.name);
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : "PDF se nepodařilo zpracovat.");
    } finally {
      setIsParsing(false);
    }
  }

  const meta = project.catalogImportMeta;
  // CORRECTIVE BATCH (3rd) section 16 — "recognized realization" means a stand with a CONFIRMED
  // catalog build record whose R: value resolved to a NAMED group (GENDAI/CREATIV EXPO/MAC PRAHA) —
  // never every stand that merely has SOME realizationCompany text, and never an OSTATNÍ/red stand
  // (that's a confirmed build with an UNRECOGNIZED contractor, the opposite of "recognized").
  const recognizedRealizationCount = project.stands.filter((stand) => {
    const displayState = resolveRealizationDisplayState(stand.hasCatalogBuildRecord, stand.realizationCompany);
    return displayState.shouldShow && displayState.group !== "ostatni";
  }).length;
  const reconciliation = project.catalogMentions ? reconcileTechnicalReportAndCatalog(buildPrimaryReportMentions(project), project.catalogMentions) : [];
  const summary = { shoda: 0, only_report: 0, only_catalog: 0, quantity_mismatch: 0, conflict: 0 };
  for (const outcome of reconciliation) summary[outcome.status] += 1;
  const toReview = reconciliation.filter((outcome) => outcome.status === "conflict" || outcome.status === "quantity_mismatch");

  return (
    <div className="workflowCard technicalCatalogImportPanel">
      <div className="workflowCardHeader"><div><span>KONTROLNÍ DATA</span><strong>Stavby — tisk vše katalog</strong></div></div>
      <p className="fieldHint">Doplňkový/kontrolní zdroj — nikdy nenahrazuje primární technické reporty, jen doplňuje realizační firmu a porovnává množství se skutečně umístěnými službami.</p>
      <label className="filePicker">
        <span>{isParsing ? "Zpracovávám…" : "Nahrát katalog PDF"}</span>
        <input
          type="file"
          accept="application/pdf"
          disabled={isParsing}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void handleFileSelected(file);
            event.target.value = "";
          }}
        />
      </label>
      {error && <p className="uploadError">{error}</p>}

      {meta && (
        <div className="technicalCatalogImportSummary">
          <p className="fieldHint">
            Soubor: {meta.filename} · Nalezeno záznamů Stavby: <strong>{meta.standCount}</strong> · Spárováno s rastrem: <strong>{meta.matchedStandCount}</strong>
            {meta.standlessRecordCount > 0 && <> · Bez čísla stánku: <strong>{meta.standlessRecordCount}</strong></>}
            {meta.outsideCurrentRasterCount > 0 && <> · <span className="technicalImportPreviewSummaryInfo">Mimo aktuální rastr: <strong>{meta.outsideCurrentRasterCount}</strong></span></>}
          </p>
          <p className="fieldHint">Rozpoznané realizační firmy: <strong>{recognizedRealizationCount}</strong></p>

          {meta.warnings.length > 0 && (
            <details className="technicalImportPreviewDetails">
              <summary>Upozornění při importu ({meta.warnings.length})</summary>
              <ul>{meta.warnings.map((warning) => <li key={warning.id}>{warning.message}</li>)}</ul>
            </details>
          )}

          <div className="technicalRasterReconciliationSummary">
            <span>Shoda: <strong>{summary.shoda}</strong></span>
            <span>Pouze report: <strong>{summary.only_report}</strong></span>
            <span>Pouze katalog: <strong>{summary.only_catalog}</strong></span>
            <span>Rozdílné množství: <strong>{summary.quantity_mismatch}</strong></span>
            <span className={summary.conflict > 0 ? "technicalRasterReconciliationConflict" : undefined}>Konflikt: <strong>{summary.conflict}</strong></span>
          </div>

          {toReview.length > 0 && (
            <details className="technicalImportPreviewDetails" open>
              <summary>Ke kontrole ({toReview.length})</summary>
              <ul>
                {toReview.map((outcome, index) => (
                  <li key={index}>
                    <strong>{outcome.standNumber}</strong> ({outcome.category}):{" "}
                    {outcome.status === "conflict"
                      ? `report="${outcome.reportVariants.join(", ") || "—"}" vs katalog="${outcome.catalogVariants.join(", ") || "—"}"${outcome.reason === "catalog_negates_report" ? " (katalog uvádí BEZ)" : ""}`
                      : `report=${outcome.reportQuantity}× vs katalog=${outcome.catalogQuantity}× (${outcome.variant})`}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
