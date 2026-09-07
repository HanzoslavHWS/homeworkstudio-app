"use client";

import { useState } from "react";
import {
  buildPrintSurfaceExportViewModel,
  nextPrintSurfaceExportRevision,
  type PrintSurfaceExportImage,
  type PrintSurfaceExportRecord,
  type PrintSurfaceExportRepository,
  type PrintSurfaceExportViewModel,
} from "../../../domain/printSurfaceExport";
import { resolvePrintSurfaceItemDimension, type PrintSurfaceProject, type PrintSurfaceView } from "../../../domain/printSurfaceProject";
import type { PrintSurfacePreset } from "../../../domain/printSurfacePreset";
import type { PrintSurfaceProductionDimension } from "../../../domain/printSurfaceProductionDimension";
import type { PrintSurfacePriceResolution } from "../../../domain/printSurfacePricing";
import type { EventBranding } from "../../../domain/eventBranding";
import type { RealizationCompany } from "../../../domain/realizationCompany";
import { buildPrintSurfaceEmailContext, type PrintSurfaceEmailContext } from "../../../domain/printSurfaceEmailContext";
import { getAssetDownloadUrl, uploadAsset } from "../../../lib/storage/assetClient";
import { loadImageAsDataUrl, loadImageWithDimensions } from "../../../lib/pdf/loadImageDataUrl";
import { buildPrintSurfacePdf, type PrintSurfacePdfViewImages } from "../../../lib/printSurfacePdf";

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
 * Event branding header block for the print-preview HTML (spec sections 1-6). The `<img
 * onerror=...>` handler is the print-safe fallback: if the event has no real logo file at that
 * URL (a static `/events/<slug>/logo.png` that was never added, or a blocked/slow remote asset
 * URL), the image hides itself and reveals the always-present text sibling instead — never an
 * empty gap, and never anything that could block/delay window.print() (this preview is never
 * auto-printed — the user triggers Ctrl+P themselves once the window is visibly ready).
 */
function eventBrandingHtml(branding: EventBranding): string {
  if (!branding.logoUrl) {
    return branding.displayName ? `<strong class="ps-event-name-fallback">${escapeHtml(branding.displayName)}</strong>` : "";
  }
  return `<div class="ps-event-logo-wrap">
    <img src="${escapeHtml(branding.logoUrl)}" alt="${escapeHtml(branding.displayName)}" class="ps-event-logo" onerror="this.style.display='none';this.nextElementSibling.style.display='block'">
    <strong class="ps-event-name-fallback" style="display:none">${escapeHtml(branding.displayName)}</strong>
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

.ps-header { display: flex; align-items: flex-end; justify-content: space-between; border-bottom: 3px solid #151515; padding-bottom: 10px; margin-bottom: 14px; gap: 12px; }
.ps-header-brand { display: flex; align-items: flex-end; gap: 10px; }
.ps-title { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; margin: 0; }
.ps-subtitle { font-size: 10px; color: #666a6d; margin-top: 2px; }
.ps-event-logo-wrap { text-align: right; }
.ps-event-logo { max-height: 40px; max-width: 130px; width: auto; height: auto; }
.ps-event-name-fallback { font-size: 15px; font-weight: 700; }

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
    <div class="ps-header-brand">
      <div>
        <div class="ps-title">EXPORT TISKOVÝCH PLOCH</div>
        ${viewModel.createdBy ? `<div class="ps-subtitle">Vytvořil: ${escapeHtml(viewModel.createdBy)}</div>` : ""}
      </div>
    </div>
    ${eventBrandingHtml(viewModel.eventBranding)}
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

  ${footerPriceHtml ? `<div class="ps-footer">${footerPriceHtml}</div>` : ""}
</div>
</body></html>`;
}

function pdfFileName(project: PrintSurfaceProject, revision: number): string {
  const slug = (project.name || "tiskove-plochy").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "").toLowerCase();
  return `${slug || "tiskove-plochy"}-R${revision}.pdf`;
}

export function PrintSurfaceExportPanel({
  project,
  views,
  presets,
  productionDimensions,
  eventBranding,
  realizationCompanyName,
  realizationCompany,
  exportRepository,
  priceResolutions,
  onEmailHandoff,
  onMarkSent,
}: {
  project: PrintSurfaceProject;
  views: readonly PrintSurfaceView[];
  presets: readonly PrintSurfacePreset[];
  productionDimensions: readonly PrintSurfaceProductionDimension[];
  eventBranding: EventBranding;
  realizationCompanyName?: string;
  realizationCompany?: Pick<RealizationCompany, "id" | "name">;
  exportRepository: PrintSurfaceExportRepository;
  /** Per-item price resolutions from the editor (domain/printSurfacePricing.ts) — only ever rendered into the PDF when showPrices below is checked (spec section 9.9, default false). */
  priceResolutions: ReadonlyMap<string, PrintSurfacePriceResolution>;
  /** Switches the app to the E-maily tab with this print-surfaces context prefilled (spec section 9) — implemented at the BoothGenerator level, never a second composer here. */
  onEmailHandoff: (context: PrintSurfaceEmailContext) => void;
  /** Calls markPrintSurfaceProjectSent + persists — only ever invoked from the explicit "Potvrdit jako odesláno" action below, never automatically (spec section 10/14). */
  onMarkSent: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showPrices, setShowPrices] = useState(false);
  const [isBuilding, setIsBuilding] = useState(false);
  const [isBuildingFile, setIsBuildingFile] = useState(false);
  const [error, setError] = useState("");
  const [lastPdfExport, setLastPdfExport] = useState<Readonly<{ record: PrintSurfaceExportRecord; revision: number; fileName: string }> | undefined>(undefined);
  const [isMarkingSent, setIsMarkingSent] = useState(false);

  async function resolveImageUrlsByViewId(): Promise<Record<string, string>> {
    const entries = await Promise.all(views.map(async (view) => {
      try {
        return [view.id, await getAssetDownloadUrl(view.image.asset.storageKey)] as const;
      } catch {
        return [view.id, undefined] as const;
      }
    }));
    return Object.fromEntries(entries.filter(([, url]) => Boolean(url))) as Record<string, string>;
  }

  function buildViewModel(revision: number, imageUrlsByViewId: Readonly<Record<string, string>>): PrintSurfaceExportViewModel {
    return buildPrintSurfaceExportViewModel({
      project,
      presets,
      productionDimensions,
      revision,
      eventName: eventBranding.displayName || undefined,
      realizationCompanyName,
      realizationCompany,
      imageUrlsByViewId,
      priceResolutions,
      showPrices,
      eventBranding,
    });
  }

  async function handlePdfOverview() {
    setMenuOpen(false);
    setError("");
    setIsBuilding(true);
    try {
      const [imageUrlsByViewId, existingExports] = await Promise.all([
        resolveImageUrlsByViewId(),
        exportRepository.list(project.id).catch(() => []),
      ]);
      const viewModel = buildViewModel(nextPrintSurfaceExportRevision(existingExports.length), imageUrlsByViewId);

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

  /**
   * The real PDF artifact (spec section 13) — jsPDF binary, uploaded as a StoredAsset so it has a
   * real, later-downloadable/attachable reference (export history's fileStorageKey). Branding/view
   * images are resolved to data URLs HERE (client-side, with graceful per-image fallback — see
   * lib/pdf/loadImageDataUrl.ts) so lib/printSurfacePdf.ts itself stays pure/offline-testable.
   */
  async function generateAndUploadPdfFile(): Promise<Readonly<{ record: PrintSurfaceExportRecord; revision: number; fileName: string }>> {
    const [imageUrlsByViewId, existingExports] = await Promise.all([
      resolveImageUrlsByViewId(),
      exportRepository.list(project.id).catch(() => []),
    ]);
    const revision = nextPrintSurfaceExportRevision(existingExports.length);
    const viewModel = buildViewModel(revision, imageUrlsByViewId);

    const eventLogoDataUrl = eventBranding.logoUrl ? await loadImageAsDataUrl(eventBranding.logoUrl) : undefined;
    const viewImageEntries = await Promise.all(
      views
        .filter((view) => imageUrlsByViewId[view.id])
        .map(async (view) => [view.id, await loadImageWithDimensions(imageUrlsByViewId[view.id]!)] as const),
    );
    const viewImages: PrintSurfacePdfViewImages = new Map(
      viewImageEntries.filter((entry): entry is readonly [string, NonNullable<(typeof entry)[1]>] => Boolean(entry[1])),
    );

    const bytes = await buildPrintSurfacePdf(viewModel, { eventLogoDataUrl }, viewImages);
    const fileName = pdfFileName(project, revision);
    const file = new File([new Uint8Array(bytes)], fileName, { type: "application/pdf" });
    const asset = await uploadAsset(file, { category: "print-surface-export", ownerId: project.id, displayName: fileName });
    const record = await exportRepository.create({ projectId: project.id, exportType: "pdf_overview", createdBy: project.createdBy, fileStorageKey: asset.storageKey });
    const result = { record, revision, fileName };
    setLastPdfExport(result);
    return result;
  }

  async function handleDownloadPdfFile() {
    setMenuOpen(false);
    setError("");
    setIsBuildingFile(true);
    try {
      const { record } = await generateAndUploadPdfFile();
      if (record.fileStorageKey) {
        const downloadUrl = await getAssetDownloadUrl(record.fileStorageKey);
        window.open(downloadUrl, "_blank");
      }
    } catch {
      setError("Vytvoření PDF souboru se nezdařilo.");
    } finally {
      setIsBuildingFile(false);
    }
  }

  async function handleEmailHandoff() {
    setMenuOpen(false);
    setError("");
    setIsBuildingFile(true);
    try {
      const { revision, fileName } = lastPdfExport ?? (await generateAndUploadPdfFile());
      const context = buildPrintSurfaceEmailContext({
        companyName: project.companyName,
        eventId: project.eventId,
        eventName: eventBranding.displayName || undefined,
        realizationCompanyName,
        projectName: project.name,
        items: project.items,
        presets,
        resolveDimension: (item) => resolvePrintSurfaceItemDimension(item, project.realizationCompanyId, productionDimensions),
        revision,
        attachmentFileName: fileName,
      });
      onEmailHandoff(context);
    } catch {
      setError("Příprava e-mailového podkladu se nezdařila.");
    } finally {
      setIsBuildingFile(false);
    }
  }

  async function handleMarkSent() {
    if (!lastPdfExport) return;
    if (!window.confirm("Potvrdit, že jste tento e-mail se soubory skutečně odeslali v Outlooku? Aplikace odeslání sama neověřuje.")) return;
    setIsMarkingSent(true);
    setError("");
    try {
      await exportRepository.markSent(lastPdfExport.record.id, { language: "cs" });
      onMarkSent();
    } catch {
      setError("Označení jako odesláno se nezdařilo.");
    } finally {
      setIsMarkingSent(false);
    }
  }

  const isBusy = isBuilding || isBuildingFile;

  return (
    <div className="printSurfaceExportPanel">
      <button type="button" className="primaryButton" onClick={() => setMenuOpen((current) => !current)} disabled={isBusy}>
        {isBusy ? "Připravuji…" : "Exportovat"}
      </button>
      {menuOpen && (
        <div className="printSurfaceExportMenu">
          <label className="printSurfaceExportPricesToggle">
            <input type="checkbox" checked={showPrices} onChange={(event) => setShowPrices(event.target.checked)} />
            <span>Zobrazit ceny</span>
          </label>
          <button type="button" onClick={() => void handlePdfOverview()}>PDF / Tiskový přehled</button>
          <button type="button" onClick={() => void handleDownloadPdfFile()}>Stáhnout PDF (soubor)</button>
          <button type="button" onClick={() => void handleEmailHandoff()}>Do e-mailu / Outlooku</button>
          {project.status !== "sent" && (
            <button type="button" onClick={() => void handleMarkSent()} disabled={!lastPdfExport || isMarkingSent} title={!lastPdfExport ? "Nejdřív vytvořte PDF soubor nebo použijte 'Do e-mailu / Outlooku'" : undefined}>
              {isMarkingSent ? "Potvrzuji…" : "Potvrdit jako odesláno"}
            </button>
          )}
        </div>
      )}
      {error && <p className="uploadError">{error}</p>}
    </div>
  );
}
