"use client";

import { useState } from "react";
import {
  buildPrintSurfaceExportFileName,
  buildPrintSurfaceExportViewModel,
  nextPrintSurfaceExportRevision,
  type PrintSurfaceExportViewModel,
} from "../../../domain/printSurfaceExport";
import {
  buildPrintSurfaceProjectFingerprint,
  isPrintSurfacePdfCurrent,
  type PrintSurfaceLatestPdf,
  type PrintSurfaceProject,
  type PrintSurfaceView,
} from "../../../domain/printSurfaceProject";
import type { PrintSurfaceExportRepository } from "../../../domain/printSurfaceExport";
import type { PrintSurfacePreset } from "../../../domain/printSurfacePreset";
import type { PrintSurfaceProductionDimension } from "../../../domain/printSurfaceProductionDimension";
import type { PrintSurfacePriceResolution } from "../../../domain/printSurfacePricing";
import type { EventBranding } from "../../../domain/eventBranding";
import type { RealizationCompany } from "../../../domain/realizationCompany";
import { buildPrintSurfaceEmailContext, type PrintSurfaceEmailContext } from "../../../domain/printSurfaceEmailContext";
import { getAssetDownloadUrl, uploadAsset } from "../../../lib/storage/assetClient";
import { loadImageAsDataUrl, loadImageWithDimensions } from "../../../lib/pdf/loadImageDataUrl";
import { buildPrintSurfacePdf, type PrintSurfacePdfViewImages } from "../../../lib/printSurfacePdf";

type GeneratedPdf = Readonly<{ storageKey: string; fileName: string; viewModel: PrintSurfaceExportViewModel }>;

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
  onPdfGenerated,
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
  /** Per-item price resolutions from the editor (domain/printSurfacePricing.ts) — kept wired for a future pricing phase, but never surfaced: the PDF never shows prices in this phase. */
  priceResolutions: ReadonlyMap<string, PrintSurfacePriceResolution>;
  /** Switches the app to the E-maily tab with this print-surfaces context prefilled — implemented at the BoothGenerator level, never a second composer here. */
  onEmailHandoff: (context: PrintSurfaceEmailContext) => void;
  /** A PDF was (re)generated and uploaded — the caller (PrintSurfaceEditorPage) attaches it via withLatestPdf and persists immediately, same discipline as onMarkSent below. This panel never persists the project itself — it only reports the artifact. */
  onPdfGenerated: (latestPdf: PrintSurfaceLatestPdf) => void;
  /** Calls markPrintSurfaceProjectSent + persists — only ever invoked from the explicit "Potvrdit jako odesláno" action below, never automatically. */
  onMarkSent: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");
  /** The most recent export-history record id created THIS session — "Potvrdit jako odesláno" targets exactly this record, never a stale/unrelated one. */
  const [lastExportId, setLastExportId] = useState<string | undefined>(undefined);
  const [isMarkingSent, setIsMarkingSent] = useState(false);

  const pdfIsCurrent = isPrintSurfacePdfCurrent(project, project.latestPdf);
  const exportButtonLabel = !project.latestPdf ? "Vygenerovat PDF" : pdfIsCurrent ? "Stáhnout PDF" : "Aktualizovat PDF";

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

  /**
   * Renders a fresh PDF, uploads it as a NEW StoredAsset (this app's upload/asset infrastructure
   * has no safe "overwrite this exact key" or "delete an already-referenced object" operation —
   * see lib/storage/assetClient.ts / app/api/assets/delete/route.ts's reference-safety refusal —
   * so the OLD R2 object is simply left orphaned/unreferenced, the same tradeoff this app already
   * makes for every export today), reports the result via onPdfGenerated (so the caller attaches
   * it as the project's ONE current PDF reference and persists), and records ONE export-history
   * audit row for the generation itself. The filename is stable across regenerations (spec: no
   * revision in the filename) — only the storageKey changes.
   */
  async function generateAndUploadCurrentPdf(): Promise<GeneratedPdf> {
    const [imageUrlsByViewId, existingExports] = await Promise.all([
      resolveImageUrlsByViewId(),
      exportRepository.list(project.id).catch(() => []),
    ]);
    const revision = nextPrintSurfaceExportRevision(existingExports.length);
    const viewModel = buildPrintSurfaceExportViewModel({
      project,
      presets,
      productionDimensions,
      revision,
      eventName: eventBranding.displayName || undefined,
      realizationCompanyName,
      realizationCompany,
      imageUrlsByViewId,
      priceResolutions,
      showPrices: false,
      eventBranding,
    });

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
    const fileName = buildPrintSurfaceExportFileName({ eventName: eventBranding.displayName || undefined, projectName: project.name });
    const file = new File([new Uint8Array(bytes)], fileName, { type: "application/pdf" });
    const asset = await uploadAsset(file, { category: "print-surface-export", ownerId: project.id, displayName: fileName });

    onPdfGenerated({
      storageKey: asset.storageKey,
      fileName,
      generatedAt: new Date().toISOString(),
      projectFingerprint: buildPrintSurfaceProjectFingerprint(project),
    });

    try {
      const record = await exportRepository.create({ projectId: project.id, exportType: "pdf_overview", createdBy: project.createdBy, fileStorageKey: asset.storageKey });
      setLastExportId(record.id);
    } catch {
      // the PDF itself already uploaded successfully — a failed audit-history write shouldn't block delivery
    }

    return { storageKey: asset.storageKey, fileName, viewModel };
  }

  /** "Stáhnout PDF" (current) just opens the existing artifact; "Vygenerovat"/"Aktualizovat PDF" (missing/stale) regenerates first. */
  async function handleExportButtonClick() {
    setMenuOpen(false);
    setError("");
    setIsBusy(true);
    try {
      const storageKey = pdfIsCurrent && project.latestPdf ? project.latestPdf.storageKey : (await generateAndUploadCurrentPdf()).storageKey;
      const downloadUrl = await getAssetDownloadUrl(storageKey);
      window.open(downloadUrl, "_blank");
    } catch {
      setError("Vytvoření PDF souboru se nezdařilo.");
    } finally {
      setIsBusy(false);
    }
  }

  /** Reuses the current PDF when it's already up to date; regenerates it first when missing/stale (spec: "Připravit e-mail" auto-generates/aktualizuje, never emails a stale artifact). Always logs ONE export-history row for the handoff itself, regardless of whether a new PDF was rendered. */
  async function handleEmailHandoff() {
    setMenuOpen(false);
    setError("");
    setIsBusy(true);
    try {
      const pdf: GeneratedPdf = pdfIsCurrent && project.latestPdf
        ? {
          storageKey: project.latestPdf.storageKey,
          fileName: project.latestPdf.fileName,
          viewModel: buildPrintSurfaceExportViewModel({
            project, presets, productionDimensions, revision: 1,
            eventName: eventBranding.displayName || undefined, realizationCompanyName, realizationCompany,
            priceResolutions, showPrices: false, eventBranding,
          }),
        }
        : await generateAndUploadCurrentPdf();

      const existingExports = await exportRepository.list(project.id).catch(() => []);
      const record = await exportRepository.create({ projectId: project.id, exportType: "pdf_overview", createdBy: project.createdBy, fileStorageKey: pdf.storageKey });
      setLastExportId(record.id);

      const context = buildPrintSurfaceEmailContext({
        projectId: project.id,
        companyName: pdf.viewModel.companyName,
        eventId: project.eventId,
        eventName: eventBranding.displayName || undefined,
        realizationCompanyName,
        projectName: pdf.viewModel.projectName,
        rows: pdf.viewModel.rows,
        revision: nextPrintSurfaceExportRevision(existingExports.length),
        exportId: record.id,
        pdfAssetStorageKey: pdf.storageKey,
        pdfFileName: pdf.fileName,
      });
      onEmailHandoff(context);
    } catch {
      setError("Příprava e-mailového podkladu se nezdařila.");
    } finally {
      setIsBusy(false);
    }
  }

  async function handleMarkSent() {
    if (!lastExportId) return;
    if (!window.confirm("Potvrdit, že jste tento e-mail se soubory skutečně odeslali v Outlooku? Aplikace odeslání sama neověřuje.")) return;
    setIsMarkingSent(true);
    setError("");
    try {
      await exportRepository.markSent(lastExportId, { language: "cs" });
      onMarkSent();
    } catch {
      setError("Označení jako odesláno se nezdařilo.");
    } finally {
      setIsMarkingSent(false);
    }
  }

  return (
    <div className="printSurfaceExportPanel">
      <button type="button" className="primaryButton" onClick={() => setMenuOpen((current) => !current)} disabled={isBusy}>
        {isBusy ? "Připravuji…" : "Exportovat"}
      </button>
      {menuOpen && (
        <div className="printSurfaceExportMenu">
          <button type="button" onClick={() => void handleExportButtonClick()}>{exportButtonLabel}</button>
          <button type="button" onClick={() => void handleEmailHandoff()}>Připravit e-mail</button>
          {project.status !== "sent" && (
            <button type="button" onClick={() => void handleMarkSent()} disabled={!lastExportId || isMarkingSent} title={!lastExportId ? "Nejdřív vytvořte export přes 'Vygenerovat PDF' nebo 'Připravit e-mail'" : undefined}>
              {isMarkingSent ? "Potvrzuji…" : "Potvrdit jako odesláno"}
            </button>
          )}
        </div>
      )}
      {error && <p className="uploadError">{error}</p>}
    </div>
  );
}
