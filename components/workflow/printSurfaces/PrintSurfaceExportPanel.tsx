"use client";

import { useState } from "react";
import {
  buildPrintSurfaceExportViewModel,
  nextPrintSurfaceExportRevision,
  type PrintSurfaceExportImage,
  type PrintSurfaceExportRepository,
  type PrintSurfaceExportViewModel,
} from "../../../domain/printSurfaceExport";
import type { PrintSurfaceProject, PrintSurfaceView } from "../../../domain/printSurfaceProject";
import type { PrintSurfacePreset } from "../../../domain/printSurfacePreset";
import type { PrintSurfaceProductionDimension } from "../../../domain/printSurfaceProductionDimension";
import type { PrintSurfacePriceResolution } from "../../../domain/printSurfacePricing";
import { getAssetDownloadUrl } from "../../../lib/storage/assetClient";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

function markerOverlayHtml(image: PrintSurfaceExportImage): string {
  return image.markers
    .map((marker) => `<div class="ps-marker" style="left:${(marker.xNormalized * 100).toFixed(3)}%;top:${(marker.yNormalized * 100).toFixed(3)}%">${escapeHtml(marker.label)}</div>`)
    .join("");
}

function imageBlockHtml(image: PrintSurfaceExportImage, sizeClass: string): string {
  return `<div class="ps-image-block ${sizeClass}">
  <div class="ps-image-label">${escapeHtml(image.viewLabel)}</div>
  <div class="ps-image-frame">
    ${image.imageUrl ? `<img src="${escapeHtml(image.imageUrl)}" alt="">` : `<div class="ps-image-missing">Obrázek není k dispozici</div>`}
    ${markerOverlayHtml(image)}
  </div>
</div>`;
}

/**
 * A4 portrait "Tiskový přehled" — header/metadata/visual(s)-with-marker-overlay/summary/table/
 * footer (spec section 4). One or two images side-by-side-ish depending on how many views the
 * project has; a single image is dominant. No PDF library — the browser's own print-to-PDF
 * renders this real, fully-computed HTML (spec section 11: real print CSS + explicit page breaks
 * so the table never gets cut mid-row across a page boundary).
 */
function buildPrintableHtml(viewModel: PrintSurfaceExportViewModel): string {
  const metadataCards: Array<[string, string | undefined]> = [
    ["Veletrh", viewModel.eventName],
    ["Vystavovatel / Firma", viewModel.companyName],
    ["Projekt / stánek", viewModel.projectName],
    ["Realizační firma", viewModel.realizationCompanyName],
    ["Datum exportu", new Date(viewModel.generatedAt).toLocaleDateString("cs-CZ")],
    ["Revize", `R${viewModel.revision}`],
  ];

  const metadataHtml = metadataCards
    .filter(([, value]) => Boolean(value))
    .map(([label, value]) => `<div class="ps-meta-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value!)}</strong></div>`)
    .join("");

  const summaryHtml = [
    `<div class="ps-summary-card ps-summary-total"><strong>${viewModel.summary.total}</strong><span>Počet ploch</span></div>`,
    ...viewModel.summary.groups.map((group) => `<div class="ps-summary-card"><strong>${group.count}</strong><span>${escapeHtml(group.labelCz)}</span></div>`),
  ].join("");

  const imagesSizeClass = viewModel.images.length === 1 ? "ps-image-solo" : "ps-image-pair";
  const imagesHtml = viewModel.images.map((image) => imageBlockHtml(image, imagesSizeClass)).join("");

  const rows = viewModel.rows
    .map((row) => `<tr>
      <td>${escapeHtml(row.label)}</td>
      <td>${escapeHtml(row.typeLabel)}</td>
      <td>${escapeHtml(row.surfaceName)}</td>
      <td>${escapeHtml(row.dimensionLabel)}</td>
      <td>${row.quantity}</td>
      <td>${escapeHtml(row.note)}</td>
      ${viewModel.showViewColumn ? `<td>${escapeHtml(row.viewLabel)}</td>` : ""}
      ${viewModel.showPrices ? `<td>${escapeHtml(row.priceQuantityLabel ?? "—")}</td><td>${escapeHtml(row.priceRateLabel ?? "—")}</td><td>${escapeHtml(row.priceLabel ?? "—")}</td>` : ""}
    </tr>`)
    .join("");

  const footerPriceHtml = viewModel.showPrices
    ? `<p><strong>Cena tiskových ploch celkem:</strong> ${escapeHtml(viewModel.totalPrice.toLocaleString("cs-CZ"))} Kč</p>`
    : "";

  return `<!doctype html>
<html lang="cs"><head><meta charset="utf-8"><title>Export tiskových ploch — ${escapeHtml(viewModel.projectName)}</title>
<style>
@page { size: A4 portrait; margin: 14mm 12mm; }
* { box-sizing: border-box; }
body { font-family: system-ui, "Segoe UI", sans-serif; color: #151515; margin: 0; padding: 0; font-size: 11px; }
.ps-page { max-width: 186mm; margin: 0 auto; }

.ps-header { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 3px solid #151515; padding-bottom: 10px; margin-bottom: 14px; }
.ps-brand { font-size: 11px; font-weight: 700; letter-spacing: 2px; color: #96999c; text-transform: uppercase; }
.ps-title { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; margin: 2px 0 0; }
.ps-subtitle { font-size: 10px; color: #666a6d; margin-top: 2px; }

.ps-meta-strip { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-bottom: 16px; }
.ps-meta-card { border: 1px solid #e3e4e5; border-radius: 6px; padding: 7px 10px; background: #fafafa; }
.ps-meta-card span { display: block; color: #96999c; font-size: 8px; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 2px; }
.ps-meta-card strong { font-size: 11px; }

.ps-visual-section { margin-bottom: 16px; page-break-inside: avoid; }
.ps-image-solo, .ps-image-pair-wrap { display: block; }
.ps-image-block { margin-bottom: 8px; }
.ps-image-pair-wrap { display: flex; gap: 8px; }
.ps-image-label { font-size: 9px; color: #666a6d; margin-bottom: 4px; font-weight: 600; }
.ps-image-frame { position: relative; width: 100%; border: 1px solid #dcdedf; border-radius: 6px; overflow: hidden; background: #f4f5f6; }
.ps-image-frame img { display: block; width: 100%; height: auto; }
.ps-image-missing { padding: 40px; text-align: center; color: #96999c; font-size: 10px; }
.ps-marker { position: absolute; width: 14px; height: 14px; margin: -7px 0 0 -7px; border-radius: 50%; background: #151515; color: #fff; border: 1.5px solid #fff; display: grid; place-items: center; font-size: 6.5px; font-weight: 700; box-shadow: 0 0 0 1px rgba(0,0,0,.25); }

.ps-summary-row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 16px; }
.ps-summary-card { flex: 1 1 auto; min-width: 70px; border: 1px solid #e3e4e5; border-radius: 6px; padding: 8px 10px; text-align: center; background: #fff; }
.ps-summary-card strong { display: block; font-size: 17px; }
.ps-summary-card span { font-size: 8px; color: #666a6d; text-transform: uppercase; letter-spacing: .4px; }
.ps-summary-total { background: #151515; border-color: #151515; }
.ps-summary-total strong, .ps-summary-total span { color: #fff; }

table { width: 100%; border-collapse: collapse; font-size: 9.5px; margin-bottom: 16px; }
thead { display: table-header-group; }
tr { page-break-inside: avoid; }
th, td { border: 1px solid #dcdedf; padding: 5px 7px; text-align: left; vertical-align: top; }
th { background: #f4f5f6; font-size: 8px; text-transform: uppercase; letter-spacing: .3px; color: #55595c; }

.ps-footer { border-top: 1px solid #dcdedf; padding-top: 10px; font-size: 8.5px; color: #55595c; line-height: 1.5; }
.ps-footer strong { color: #151515; }

@media print {
  body { font-size: 10px; }
  .ps-visual-section, table { page-break-inside: avoid; }
}
</style></head>
<body>
<div class="ps-page">
  <div class="ps-header">
    <div>
      <div class="ps-brand">ABF · HomeworkStudio</div>
      <div class="ps-title">EXPORT TISKOVÝCH PLOCH</div>
      <div class="ps-subtitle">Přehled tiskových ploch z generátoru</div>
    </div>
    ${viewModel.createdBy ? `<div class="ps-subtitle">Vytvořil: ${escapeHtml(viewModel.createdBy)}</div>` : ""}
  </div>

  <div class="ps-meta-strip">${metadataHtml}</div>

  <div class="ps-visual-section">
    <div class="${imagesSizeClass === "ps-image-pair" ? "ps-image-pair-wrap" : ""}">${imagesHtml}</div>
  </div>

  <div class="ps-summary-row">${summaryHtml}</div>

  <table>
    <thead><tr>
      <th>Označení</th><th>Typ plochy</th><th>Název plochy</th><th>Rozměr grafiky</th><th>Počet</th><th>Poznámka</th>
      ${viewModel.showViewColumn ? "<th>Pohled</th>" : ""}
      ${viewModel.showPrices ? "<th>Jednotka</th><th>Sazba</th><th>Cena</th>" : ""}
    </tr></thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="ps-footer">
    <p><strong>Pokyny pro přípravu grafiky:</strong> Uvedené rozměry jsou VÝROBNÍ rozměry tiskové plochy — grafiku připravujte přesně na tento rozměr, včetně bezpečného odstupu textů a log minimálně 20 mm od každého okraje.</p>
    <p>Konkrétní technické podmínky (formát souboru, barevný profil, spadávka) se řídí požadavky zvolené realizační firmy${viewModel.realizationCompanyName ? ` (${escapeHtml(viewModel.realizationCompanyName)})` : ""}.</p>
    ${footerPriceHtml}
  </div>
</div>
</body></html>`;
}

export function PrintSurfaceExportPanel({
  project,
  views,
  presets,
  productionDimensions,
  eventName,
  realizationCompanyName,
  exportRepository,
  priceResolutions,
}: {
  project: PrintSurfaceProject;
  views: readonly PrintSurfaceView[];
  presets: readonly PrintSurfacePreset[];
  productionDimensions: readonly PrintSurfaceProductionDimension[];
  eventName?: string;
  realizationCompanyName?: string;
  exportRepository: PrintSurfaceExportRepository;
  /** Per-item price resolutions from the editor (domain/printSurfacePricing.ts) — only ever rendered into the PDF when showPrices below is checked (spec section 9.9, default false). */
  priceResolutions: ReadonlyMap<string, PrintSurfacePriceResolution>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showPrices, setShowPrices] = useState(false);
  const [isBuilding, setIsBuilding] = useState(false);
  const [error, setError] = useState("");

  async function handlePdfOverview() {
    setMenuOpen(false);
    setError("");
    setIsBuilding(true);
    try {
      const [imageUrlEntries, existingExports] = await Promise.all([
        Promise.all(views.map(async (view) => {
          try {
            return [view.id, await getAssetDownloadUrl(view.image.asset.storageKey)] as const;
          } catch {
            return [view.id, undefined] as const;
          }
        })),
        exportRepository.list(project.id).catch(() => []),
      ]);
      const imageUrlsByViewId = Object.fromEntries(imageUrlEntries.filter(([, url]) => Boolean(url)));

      const viewModel = buildPrintSurfaceExportViewModel({
        project,
        presets,
        productionDimensions,
        revision: nextPrintSurfaceExportRevision(existingExports.length),
        eventName,
        realizationCompanyName,
        imageUrlsByViewId,
        priceResolutions,
        showPrices,
      });

      const printWindow = window.open("", "_blank");
      if (!printWindow) {
        setError("Prohlížeč zablokoval otevření náhledu. Povolte vyskakovací okna a zkuste to znovu.");
        return;
      }
      printWindow.document.write(buildPrintableHtml(viewModel));
      printWindow.document.close();

      try {
        await exportRepository.create({ projectId: project.id, exportType: "pdf_overview", createdBy: project.createdBy });
      } catch {
        // the preview already opened successfully — a failed history record shouldn't block the user's export
      }
    } catch {
      setError("Export se nezdařil.");
    } finally {
      setIsBuilding(false);
    }
  }

  return (
    <div className="printSurfaceExportPanel">
      <button type="button" className="primaryButton" onClick={() => setMenuOpen((current) => !current)} disabled={isBuilding}>
        {isBuilding ? "Připravuji…" : "Exportovat"}
      </button>
      {menuOpen && (
        <div className="printSurfaceExportMenu">
          <label className="printSurfaceExportPricesToggle">
            <input type="checkbox" checked={showPrices} onChange={(event) => setShowPrices(event.target.checked)} />
            <span>Zobrazit ceny</span>
          </label>
          <button type="button" onClick={() => void handlePdfOverview()}>PDF / Tiskový přehled</button>
          <button type="button" disabled title="Připravujeme">Do Outlooku</button>
        </div>
      )}
      {error && <p className="uploadError">{error}</p>}
    </div>
  );
}
