"use client";

import { useState } from "react";
import { TECHNICAL_SERVICE_CATEGORIES } from "../../../domain/technicalServiceCatalog";
import { categoryCanHaveExportableSymbol } from "../../../domain/technicalRasterServicePresentation";
import { effectiveIncludeRealizationsInExport, effectiveWhiteFillOpacity, type TechnicalRasterProject } from "../../../domain/technicalRaster";
import { resolveRealizationDisplayState, technicalRealizationGroupInfo } from "../../../domain/technicalRasterRealization";
import { computeRealizationUnderlineGeometry } from "../../../domain/technicalRasterRealizationUnderline";
import type { TechnicalRasterExportRealizationUnderlineItem } from "../../../lib/technicalRasterVectorPdf";
import {
  buildTechnicalRasterExportFileName,
  buildTechnicalRasterExportHeaderLine,
  buildTechnicalRasterExportLegend,
  buildTechnicalRasterExportPlacements,
  computeTechnicalRasterExportWarnings,
  computeTechnicalRasterStatusSummary,
} from "../../../domain/technicalRasterExport";
import { buildTechnicalRasterMultiPageVectorExportPdf } from "../../../lib/technicalRasterVectorPdf";
import { resolveWhiteModeAvailability } from "../../../lib/pdf/technicalRasterWhiteRender";
import { downloadDataUrl } from "../../../lib/planExport";

/** Export "Zahrnout" filter (manual acceptance batch section 43): waste/cleaning never produce an exportable POINT symbol for any real label (see categoryCanHaveExportableSymbol's own doc) — excluded here so the export dialog never offers a checkbox that can't affect the output. The editor's own "TECHNICKÉ ZNAČKY" view filters are untouched and still list every category — this is export-only, per spec's explicit "NEMĚŇ service semantics". */
const EXPORTABLE_CATEGORIES = TECHNICAL_SERVICE_CATEGORIES.filter((category) => categoryCanHaveExportableSymbol(category.id));

/**
 * VÝSTUPY (spec batch 9, "TRUE VECTOR PDF EXPORT") — the source raster is copied into the export
 * PDF as real PDF/vector content (lib/technicalRasterVectorPdf.ts), never rasterized. This
 * replaced the earlier hybrid (rasterized-background + vector-overlay, spec batch 7) after real
 * manual review rejected the rasterized background as unacceptable for a final technical export.
 *
 * "Rastr" (corrective batch section 4, superseding the earlier "Originální barvy is the only mode"
 * decision): the export now MIRRORS the editor's own "Pracovní — bílé" project setting exactly —
 * never a separate export-only toggle. When `project.rasterSettings.viewMode === "work"` and the
 * stand layer is unambiguously detected (the SAME `resolveWhiteModeAvailability` the editor's own
 * canvas uses), the export rewrites the copied page's own content stream via
 * `lib/technicalRasterVectorPdf.ts`'s vector white-mode transform at the SAME "Krytí bílé" opacity
 * (`effectiveWhiteFillOpacity`) — genuinely vector, never a raster of any kind.
 *
 * POLICY (post real-file acceptance test, corrective batch section 2 — supersedes the earlier
 * "falls back to original colors" behavior): if white mode is requested and the transform can't be
 * safely applied to some page, `buildTechnicalRasterMultiPageVectorExportPdf` now THROWS a
 * `TechnicalRasterVectorExportError` (`code: "WHITE_MODE_UNSUPPORTED"`) instead of completing with
 * that page's original colors — the user must never get a different visual result than what they
 * asked for. `runExport`'s own catch block surfaces that error's message (page number + reason)
 * via `exportError`; nothing downloads when this happens.
 * This row is a plain, non-interactive informational value — there is still no separate export-only
 * white-mode control to keep in sync with the editor's own.
 *
 * Every source PAGE is included 1:1 (spec section 38: "všechny source pages zachovej 1:1"), each
 * with its own overlay symbols, followed by ONE legend page appended after the last source page —
 * never resized/rescaled, never a footer squeezed onto page 1 (spec section 34-37).
 *
 * Never uploads/emails anything (V1 scope, unchanged) and never touches the source PDF asset —
 * every export produces a brand-new, in-memory PDF blob; `rasterUrl` is only ever fetched and read.
 */
export function TechnicalRasterOutputsPanel({
  project,
  rasterUrl,
  pageCount,
  hiddenServiceCategories,
}: {
  project: TechnicalRasterProject;
  rasterUrl: string | undefined;
  /** Total page count of the source raster (manual acceptance batch section 38) — every page 1..pageCount is included 1:1 in the export (never just whichever one happens to be active in the editor), with the legend appended after the last one. */
  pageCount: number;
  /** The project's CURRENT "TECHNICKÉ ZNAČKY" visibility (spec section 37) — seeds this dialog's own "Zahrnout" checkboxes, which the user may still override for one export without changing the live editor setting. */
  hiddenServiceCategories: ReadonlySet<string>;
}) {
  const [includeCategories, setIncludeCategories] = useState<ReadonlySet<string>>(
    new Set(EXPORTABLE_CATEGORIES.map((category) => category.id).filter((id) => !hiddenServiceCategories.has(id))),
  );
  const [showLegend, setShowLegend] = useState(true);
  // Seeded from the project's own persisted preference, but a plain LOCAL dialog toggle from then
  // on — same discipline as includeCategories above, which seeds from hiddenServiceCategories but
  // never writes back to the project either (spec never asked for this export dialog to persist
  // its own choices).
  const [includeRealizations, setIncludeRealizations] = useState(effectiveIncludeRealizationsInExport(project.rasterSettings));
  const [showWarningConfirm, setShowWarningConfirm] = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [exportError, setExportError] = useState("");

  const statusSummary = computeTechnicalRasterStatusSummary(project);
  const warnings = computeTechnicalRasterExportWarnings(project);
  const hasWarnings = warnings.unplacedPointCount > 0 || warnings.unmatchedStandsWithServices.length > 0;

  // Mirrors the editor's OWN "Pracovní — bílé" project setting exactly — never a separate export-
  // only toggle (spec section 4: "60 % v editoru = 60 % v exportu"). Same availability check the
  // editor's canvas already uses (resolveWhiteModeAvailability), so this can never disagree with
  // what the user is actually looking at while placing symbols.
  const whiteModeAvailability = resolveWhiteModeAvailability(project.rasterLayers);
  const whiteModeOpacity = effectiveWhiteFillOpacity(project.rasterSettings);
  const whiteModeRequested = project.rasterSettings.viewMode === "work" && whiteModeAvailability.status === "available";

  function toggleCategory(categoryId: string) {
    setIncludeCategories((current) => {
      const next = new Set(current);
      if (next.has(categoryId)) next.delete(categoryId); else next.add(categoryId);
      return next;
    });
  }

  async function runExport() {
    if (!rasterUrl) { setExportError("Rastr není k dispozici."); return; }
    setIsExporting(true);
    setExportError("");
    try {
      const excludedCategories = new Set(TECHNICAL_SERVICE_CATEGORIES.map((category) => category.id).filter((id) => !includeCategories.has(id)));

      // Every source page 1..pageCount, each with its OWN placements (spec section 38) — never
      // just the currently active one. A project whose raster hasn't reported a page count yet
      // (pageCount <= 0, e.g. before the canvas finished its first render) still exports the one
      // page this dialog already knows about, rather than producing an empty document.
      const resolvedPageCount = Math.max(1, pageCount);
      // Corrective batch (post real-file acceptance test) section 4/5 — every MATCHED stand's own
      // underline, grouped by page, anchored to its known label position exactly like the editor's
      // own realizationUnderlineMarkers (same shared geometry function). CORRECTIVE BATCH (3rd)
      // section 2/4: gated through `resolveRealizationDisplayState` exactly like the editor — a
      // stand with no confirmed catalog build record gets no underline in the export either.
      const underlinesByPage = new Map<number, TechnicalRasterExportRealizationUnderlineItem[]>();
      if (includeRealizations) {
        for (const stand of project.stands) {
          if (stand.placement.status !== "matched_auto" && stand.placement.status !== "matched_manual") continue;
          if (stand.placement.rasterPage === undefined) continue;
          const displayState = resolveRealizationDisplayState(stand.hasCatalogBuildRecord, stand.realizationCompany);
          if (!displayState.shouldShow) continue;
          const label = project.rasterStandLabels.find((candidate) => candidate.id === stand.placement.matchedLabelId);
          const anchorXNormalized = label?.xNormalized ?? stand.placement.anchorXNormalized;
          const anchorYNormalized = label?.yNormalized ?? stand.placement.anchorYNormalized;
          if (anchorXNormalized === undefined || anchorYNormalized === undefined) continue;
          const geometry = computeRealizationUnderlineGeometry(
            { xNormalized: anchorXNormalized, yNormalized: anchorYNormalized },
            label ? { widthNormalized: label.widthNormalized, heightNormalized: label.heightNormalized } : undefined,
          );
          const underline: TechnicalRasterExportRealizationUnderlineItem = {
            standId: stand.id,
            xNormalized: geometry.xNormalized,
            yNormalized: geometry.yNormalized,
            widthNormalized: geometry.widthNormalized,
            color: technicalRealizationGroupInfo(displayState.group).color,
          };
          const list = underlinesByPage.get(stand.placement.rasterPage) ?? [];
          list.push(underline);
          underlinesByPage.set(stand.placement.rasterPage, list);
        }
      }
      const pages = Array.from({ length: resolvedPageCount }, (_, index) => index + 1).map((pageNumber) => ({
        page: pageNumber,
        placements: buildTechnicalRasterExportPlacements(project, pageNumber, excludedCategories),
        realizationUnderlines: underlinesByPage.get(pageNumber) ?? [],
      }));
      const legend = buildTechnicalRasterExportLegend(pages.flatMap((pageInput) => pageInput.placements));

      const response = await fetch(rasterUrl);
      if (!response.ok) throw new Error("Rastr se nepodařilo stáhnout pro export.");
      const sourcePdfBytes = new Uint8Array(await response.arrayBuffer());

      // No separate event-name resolution exists for this module (unlike Tiskové plochy's
      // eventBranding lookup) — project.hall is only appended when it isn't already part of
      // project.name, so real data is never duplicated and nothing is ever invented (spec section 45).
      const hall = project.hall && !project.name.includes(project.hall) ? project.hall : undefined;
      const headerLine = buildTechnicalRasterExportHeaderLine({ eventName: project.name, hall });
      const fileName = buildTechnicalRasterExportFileName({ eventName: project.name, hall });

      // POLICY (post real-file acceptance test, corrective batch section 2): white mode is either
      // correctly applied to EVERY page it's requested for, or the whole export throws — never a
      // silent per-page fallback to original colors. buildTechnicalRasterMultiPageVectorExportPdf
      // itself enforces this (throws TechnicalRasterVectorExportError with code
      // "WHITE_MODE_UNSUPPORTED" and the offending page number), so nothing extra is checked here;
      // a thrown error lands in the catch block below with a ready-to-show Czech message.
      const { bytes } = await buildTechnicalRasterMultiPageVectorExportPdf({
        sourcePdfBytes,
        pages,
        legend,
        showLegend,
        headerLine,
        whiteMode: whiteModeRequested ? { opacity: whiteModeOpacity } : undefined,
        includeRealizationKey: includeRealizations,
      });

      const blobUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type: "application/pdf" }));
      downloadDataUrl(blobUrl, fileName);
      URL.revokeObjectURL(blobUrl);
      setShowWarningConfirm(false);
    } catch (error) {
      setExportError(error instanceof Error ? error.message : "Export se nezdařil.");
    } finally {
      setIsExporting(false);
    }
  }

  function handleExportClick() {
    if (hasWarnings && !showWarningConfirm) { setShowWarningConfirm(true); return; }
    void runExport();
  }

  return (
    <div className="workflowCard technicalRasterOutputsPanel">
      <div className="workflowCardHeader"><div><span>VÝSTUPY</span><strong>Technický export</strong></div></div>

      <div className="technicalRasterOutputsStatusSummary">
        <span>Formát: <strong>Vektorové PDF</strong></span>
        <span>Spárování: <strong>{statusSummary.matchedStandCount}/{statusSummary.totalStandCount}</strong></span>
        <span>Technické body: <strong>{statusSummary.placedPointCount}/{statusSummary.totalPointCount}</strong> umístěno</span>
      </div>

      {!rasterUrl && <p className="workspaceEmpty">Nejprve nahrajte PDF vyměřovacího rastru (krok „Rastr").</p>}

      {rasterUrl && (
        <>
          {showWarningConfirm && hasWarnings && (
            <div className="technicalRasterOutputsWarning">
              {warnings.unplacedPointCount > 0 && (
                <p>Některé technické služby ještě nejsou umístěné — {warnings.unplacedServiceCount} {warnings.unplacedServiceCount === 1 ? "služba" : "služby"} / {warnings.unplacedPointCount} {warnings.unplacedPointCount === 1 ? "bod" : "body"} nejsou umístěné.</p>
              )}
              {warnings.unmatchedStandsWithServices.length > 0 && (
                <p>{warnings.unmatchedStandsWithServices.length} {warnings.unmatchedStandsWithServices.length === 1 ? "stánek s technickými službami není spárován" : "stánků s technickými službami není spárováno"} ({warnings.unmatchedStandsWithServices.map((stand) => stand.standNumber).join(", ")}).</p>
              )}
              <div className="technicalRasterOutputsWarningActions">
                <button type="button" onClick={() => setShowWarningConfirm(false)}>Zpět k umístění</button>
                <button type="button" className="primaryButton" onClick={() => void runExport()} disabled={isExporting}>Exportovat i tak</button>
              </div>
            </div>
          )}

          <div className="technicalRasterOutputsForm">
            <div className="technicalRasterOutputsFormRow">
              <span>Rastr</span>
              <span className="technicalRasterOutputsRasterModeValue">
                {whiteModeRequested ? `Pracovní — bílé (${Math.round(whiteModeOpacity * 100)} %)` : "Originální barvy"}
              </span>
            </div>
            {project.rasterSettings.viewMode === "work" && whiteModeAvailability.status !== "available" && (
              <p className="fieldHint">Export použije originální barvy — {whiteModeAvailability.reason}</p>
            )}

            <div className="technicalRasterOutputsFormRow">
              <label>Zahrnout</label>
              <div className="technicalRasterOutputsIncludeRow">
                {EXPORTABLE_CATEGORIES.map((category) => (
                  <label key={category.id}>
                    <input type="checkbox" checked={includeCategories.has(category.id)} onChange={() => toggleCategory(category.id)} />
                    {category.labelCz}
                  </label>
                ))}
              </div>
            </div>

            <div className="technicalRasterOutputsFormRow">
              <label>
                <input type="checkbox" checked={showLegend} onChange={(event) => setShowLegend(event.target.checked)} style={{ width: "auto", height: "auto", marginRight: 6 }} />
                Legenda: Zobrazit
              </label>
            </div>

            <div className="technicalRasterOutputsFormRow">
              <label>
                <input type="checkbox" checked={includeRealizations} onChange={(event) => setIncludeRealizations(event.target.checked)} style={{ width: "auto", height: "auto", marginRight: 6 }} />
                Zahrnout realizačky do exportu
              </label>
            </div>

            {exportError && <p className="uploadError">{exportError}</p>}

            <div className="printSurfaceCreateFormActions">
              <button type="button" className="primaryButton" onClick={handleExportClick} disabled={isExporting}>
                {isExporting ? "Vytvářím PDF…" : "Vytvořit PDF"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
