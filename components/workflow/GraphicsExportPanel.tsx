"use client";

import { useMemo, useState } from "react";
import type { BoothType, ComponentDefinition } from "../../domain/models";
import type { GraphicFileReference, PrintSurfaceAssignment } from "../../domain/project";
import type { PricingContext } from "../../domain/catalog";
import {
  buildAssignedArtworkExportRows,
  buildGraphicsDimensionExportRows,
  buildGraphicsExportRows,
  graphicsExportSubtotal,
  groupGraphicsExportRows,
  type GraphicsExportRow,
} from "../../domain/graphicsExport";
import { isRasterArtworkFile } from "../../lib/printArtworkOverlays";
import { printDocument } from "../../lib/planExport";
import { useAssetUrl } from "../../hooks/useAssetUrl";

const EMPTY_PRINT_SURFACES: Pick<BoothType, "printSurfaces" | "packageContents"> = { printSurfaces: [], packageContents: [] };

type GraphicsExportPanelProps = Readonly<{
  booth: BoothType | undefined;
  printSurfaceAssignments: readonly PrintSurfaceAssignment[];
  graphicsFiles: readonly GraphicFileReference[];
  realizationProfileId: string;
  realizationLabel: string;
  projectName: string;
  company: string;
  eventName: string;
  catalogItems: readonly ComponentDefinition[];
  pricingContext: PricingContext;
}>;

function formatMoney(amount: number, currency: string): string {
  return `${amount.toLocaleString("cs-CZ")} ${currency}`;
}

type ExportMode = "dimensions" | "artwork";

function toggleInSet(current: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(current);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return next;
}

function placementSummaryLabel(row: GraphicsExportRow): string {
  if (!row.artworkPlacement) return "Stretch · 100 % · X 0 mm · Y 0 mm";
  const modeLabel = row.artworkPlacement.mode === "stretch" ? "Stretch" : row.artworkPlacement.mode === "fit" ? "Fit" : "Fill";
  return `${modeLabel} · ${Math.round(row.artworkPlacement.scale * 100)} % · X ${row.artworkPlacement.offsetXmm} mm · Y ${row.artworkPlacement.offsetYmm} mm`;
}

/** Report section 9: the main production figure is "Data dodat" only when a real allowance applies; when production === canonical, a single "Rozměr" line is shown instead of duplicating the same number twice (design section 16). */
function DimensionFigure({ row }: { row: GraphicsExportRow }) {
  const hasAllowance = row.productionWidthMm !== row.canonicalWidthMm || row.productionHeightMm !== row.canonicalHeightMm;
  if (!hasAllowance) {
    return <div className="graphicsExportDimension"><span>Rozměr</span><strong>{row.canonicalWidthMm} × {row.canonicalHeightMm} mm</strong></div>;
  }
  const hasBleed = row.bleedLeftMm || row.bleedRightMm || row.bleedTopMm || row.bleedBottomMm;
  return (
    <div className="graphicsExportDimension">
      <span>Data dodat / Výrobní rozměr</span>
      <strong>{row.productionWidthMm} × {row.productionHeightMm} mm</strong>
      <small>Pohledová plocha: {row.canonicalWidthMm} × {row.canonicalHeightMm} mm</small>
      {hasBleed && <small>Přesahy: L{row.bleedLeftMm} / P{row.bleedRightMm} / H{row.bleedTopMm} / D{row.bleedBottomMm} mm</small>}
    </div>
  );
}

/**
 * Report sections 2/15-18: per-surface graphics price, driven entirely by row.pricing
 * (resolveGraphicsSurfacePricing) — never a second m²/bm formula in this component. A missing
 * PricingEntry never invents a rate: "Cena není nastavena" instead (section 18).
 */
function PricingFigure({ row, currency }: { row: GraphicsExportRow; currency: string }) {
  const unit = row.pricing.pricingBasis;
  const quantityLabel = `${row.pricing.quantity.toLocaleString("cs-CZ", { maximumFractionDigits: 3 })} ${unit}`;
  if (row.pricing.status === "included") {
    return (
      <div className="graphicsExportPricing">
        <span>{unit === "bm" ? "Grafika límce" : "Cena grafiky"}</span>
        <strong>V ceně stánku</strong>
        <small>{quantityLabel}</small>
      </div>
    );
  }
  if (row.pricing.status === "needs-quote" || row.pricing.unitPriceNet === undefined || row.pricing.totalNet === undefined) {
    return (
      <div className="graphicsExportPricing">
        <span>Cena grafiky</span>
        <strong className="graphicsExportMissingPrice">Cena není nastavena</strong>
        <small>{quantityLabel}</small>
      </div>
    );
  }
  return (
    <div className="graphicsExportPricing">
      <span>Cena grafiky</span>
      <strong>{quantityLabel} × {formatMoney(row.pricing.unitPriceNet, currency)}/{unit} = {formatMoney(row.pricing.totalNet, currency)}</strong>
    </div>
  );
}

function ArtworkPreview({ row }: { row: GraphicsExportRow }) {
  const resolved = useAssetUrl(row.artworkAsset, undefined);
  const isRaster = row.artworkOriginalFileName ? isRasterArtworkFile({ mimeType: row.artworkAsset?.mimeType ?? "", name: row.artworkOriginalFileName }) : false;
  if (isRaster && resolved.url) {
    return <img className="graphicsExportPreviewImage" src={resolved.url} alt={row.artworkDisplayName ?? row.name} />;
  }
  return <div className="graphicsExportPreviewPlaceholder" aria-hidden="true">{isRaster ? "…" : "PDF"}</div>;
}

/**
 * Graphics Export v1 — two independent modes over the SAME generic row builder (report section
 * 14): "Export rozměrů tiskových ploch" (every available surface, user-selected) and "Přehled
 * ploch s přiřazenou grafikou" (only surfaces that already have artwork). Selection is local
 * component state only — never written to ProjectRecord (report section 18). Printing reuses the
 * exact #id-scoped `@media print` mechanism the existing customer calculation export already uses
 * (app/globals.css) — no new PDF library.
 */
export function GraphicsExportPanel({
  booth,
  printSurfaceAssignments,
  graphicsFiles,
  realizationProfileId,
  realizationLabel,
  projectName,
  company,
  eventName,
  catalogItems,
  pricingContext,
}: GraphicsExportPanelProps) {
  const [mode, setMode] = useState<ExportMode>("dimensions");
  const [selectedDimensionIds, setSelectedDimensionIds] = useState<ReadonlySet<string>>(() => new Set());
  const [excludedArtworkIds, setExcludedArtworkIds] = useState<ReadonlySet<string>>(() => new Set());

  const rows = useMemo(
    () => buildGraphicsExportRows(booth ?? EMPTY_PRINT_SURFACES, printSurfaceAssignments, graphicsFiles, realizationProfileId, catalogItems, pricingContext),
    [booth, printSurfaceAssignments, graphicsFiles, realizationProfileId, catalogItems, pricingContext],
  );
  const groups = useMemo(() => groupGraphicsExportRows(rows), [rows]);
  const artworkRowIds = useMemo(() => new Set(rows.filter((row) => row.artworkFileId).map((row) => row.printSurfaceId)), [rows]);

  const dimensionExportRows = buildGraphicsDimensionExportRows(rows, selectedDimensionIds);
  const enabledArtworkIds = new Set([...artworkRowIds].filter((id) => !excludedArtworkIds.has(id)));
  const artworkExportRows = buildAssignedArtworkExportRows(rows, enabledArtworkIds);
  const exportRows = mode === "dimensions" ? dimensionExportRows : artworkExportRows;

  function toggleDimensionSurface(printSurfaceId: string) {
    setSelectedDimensionIds((current) => toggleInSet(current, printSurfaceId));
  }
  function toggleDimensionGroup(groupId: string) {
    const groupIds = groups.find((group) => group.id === groupId)?.rows.map((row) => row.printSurfaceId) ?? [];
    const allSelected = groupIds.every((id) => selectedDimensionIds.has(id));
    setSelectedDimensionIds((current) => {
      const next = new Set(current);
      groupIds.forEach((id) => (allSelected ? next.delete(id) : next.add(id)));
      return next;
    });
  }
  function selectAllDimensions() { setSelectedDimensionIds(new Set(rows.map((row) => row.printSurfaceId))); }
  function clearAllDimensions() { setSelectedDimensionIds(new Set()); }
  function toggleArtworkRow(printSurfaceId: string) {
    setExcludedArtworkIds((current) => toggleInSet(current, printSurfaceId));
  }

  if (!groups.length) return null;

  return (
    <section className="workflowCard graphicsExportPanel">
      <div className="workflowCardHeader">
        <div><span>GRAPHICS EXPORT</span><strong>{mode === "dimensions" ? "Rozměry tiskových ploch" : "Přehled použitých grafik"}</strong></div>
      </div>
      <div className="graphicsExportModeToggle" role="group" aria-label="Režim exportu grafiky">
        <button type="button" className={mode === "dimensions" ? "active" : ""} onClick={() => setMode("dimensions")}>Export rozměrů</button>
        <button type="button" className={mode === "artwork" ? "active" : ""} onClick={() => setMode("artwork")}>Přehled grafik</button>
      </div>

      {mode === "dimensions" && (
        <div className="graphicsExportSelectionBar">
          <button type="button" onClick={selectAllDimensions}>Vybrat vše</button>
          <button type="button" onClick={clearAllDimensions}>Zrušit vše</button>
        </div>
      )}

      <div className="graphicsExportGroups">
        {groups.map((group) => {
          const groupIds = group.rows.map((row) => row.printSurfaceId);
          const groupSelected = mode === "dimensions" && groupIds.every((id) => selectedDimensionIds.has(id));
          return (
            <div className="graphicsExportGroup" key={group.id}>
              <div className="graphicsExportGroupHeader">
                <strong>{group.name}</strong>
                {mode === "dimensions" && (
                  <button type="button" onClick={() => toggleDimensionGroup(group.id)}>
                    {groupSelected ? "Zrušit skupinu" : "Vybrat skupinu"}
                  </button>
                )}
              </div>
              {group.rows.filter((row) => mode === "dimensions" || row.artworkFileId).map((row) => (
                <label className="graphicsExportRow" key={row.printSurfaceId}>
                  <input
                    type="checkbox"
                    checked={mode === "dimensions" ? selectedDimensionIds.has(row.printSurfaceId) : enabledArtworkIds.has(row.printSurfaceId)}
                    onChange={() => (mode === "dimensions" ? toggleDimensionSurface(row.printSurfaceId) : toggleArtworkRow(row.printSurfaceId))}
                  />
                  <span className="graphicsExportRowName">{row.name} – {row.face === "back" ? "Zadní" : "Přední"}</span>
                  {mode === "dimensions"
                    ? <DimensionFigure row={row} />
                    : (
                      <span className="graphicsExportArtworkSummary">
                        <span>{row.artworkDisplayName}</span>
                        {row.artworkUsageRole !== "print-data" && <em className="graphicsExportPreviewOnlyBadge">Pouze náhled</em>}
                      </span>
                    )}
                  <PricingFigure row={row} currency={pricingContext.currency} />
                </label>
              ))}
            </div>
          );
        })}
      </div>

      <div className="graphicsExportSubtotal">
        <span>GRAFIKA CELKEM</span>
        <strong>{formatMoney(graphicsExportSubtotal(exportRows), pricingContext.currency)}</strong>
      </div>

      <button type="button" className="primaryButton" onClick={() => printDocument("graphics-export")} disabled={exportRows.length === 0}>
        Vytisknout / uložit jako PDF
      </button>

      <article id="graphics-export-document" className="graphicsExportDocument">
        <header>
          <span>GRAPHICS EXPORT</span>
          <h2>{mode === "dimensions" ? "Rozměry tiskových ploch" : "Přehled použitých grafik"}</h2>
          <dl>
            <div><dt>Projekt</dt><dd>{projectName || "—"}</dd></div>
            <div><dt>Firma</dt><dd>{company || "—"}</dd></div>
            <div><dt>Veletrh / event</dt><dd>{eventName || "—"}</dd></div>
            <div><dt>Realizace</dt><dd>{realizationLabel}</dd></div>
            <div><dt>Datum</dt><dd>{new Date().toLocaleDateString("cs-CZ")}</dd></div>
          </dl>
        </header>
        {exportRows.length === 0 && <p>Nebyla vybrána žádná plocha.</p>}
        {groupGraphicsExportRows(exportRows).map((group) => (
          <section key={group.id} className="graphicsExportDocumentGroup">
            <h3>{group.name.toUpperCase()}</h3>
            {group.rows.map((row) => (
              <article className="graphicsExportCard" key={row.printSurfaceId}>
                <strong>{row.name} – {row.face === "back" ? "Zadní" : "Přední"}</strong>
                {mode === "dimensions" ? (
                  <>
                    <DimensionFigure row={row} />
                    <PricingFigure row={row} currency={pricingContext.currency} />
                  </>
                ) : (
                  <>
                    <ArtworkPreview row={row} />
                    <div><span>Soubor</span><strong>{row.artworkDisplayName}</strong></div>
                    {row.artworkOriginalFileName && row.artworkOriginalFileName !== row.artworkDisplayName && (
                      <div><span>Původní soubor</span><strong>{row.artworkOriginalFileName}</strong></div>
                    )}
                    <div><span>Exportní název</span><strong>{row.exportFileName}</strong></div>
                    {row.artworkUsageRole === "print-data"
                      ? <em className="graphicsExportPrintDataBadge">Tisková data</em>
                      : <em className="graphicsExportPreviewOnlyBadge">POUZE NÁHLED – není označeno jako tisková data</em>}
                    <DimensionFigure row={row} />
                    <PricingFigure row={row} currency={pricingContext.currency} />
                    <div><span>Placement</span><strong>{placementSummaryLabel(row)}</strong></div>
                  </>
                )}
              </article>
            ))}
          </section>
        ))}
        {exportRows.length > 0 && (
          <footer className="graphicsExportDocumentSubtotal">
            <span>GRAFIKA CELKEM</span>
            <strong>{formatMoney(graphicsExportSubtotal(exportRows), pricingContext.currency)}</strong>
          </footer>
        )}
      </article>
    </section>
  );
}
