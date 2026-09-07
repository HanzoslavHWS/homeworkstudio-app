"use client";

import { useEffect, useRef, useState } from "react";
import {
  buildPrintSurfaceExportFileName,
  buildPrintSurfaceExportViewModel,
  nextPrintSurfaceExportRevision,
  type PrintSurfaceExportViewModel,
} from "../../../domain/printSurfaceExport";
import {
  buildPrintSurfaceProjectFingerprint,
  diffPrintSurfaceProjectFingerprints,
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
import { loadImageElement } from "../../../lib/pdf/loadImageDataUrl";
import { resolveContainRect } from "../../../lib/pdf/imageRect";
import {
  PRINT_SURFACE_PDF_EVENT_LOGO_HEIGHT_MM,
  PRINT_SURFACE_PDF_EVENT_LOGO_WIDTH_MM,
  resolvePrintSurfaceViewRenderBox,
} from "../../../lib/pdf/printSurfaceViewLayout";
import { logPreparedPdfImageDiagnostics, prepareImageForPdf } from "../../../lib/pdf/prepareImageForPdf";
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
  /**
   * A PDF was (re)generated and uploaded — the caller (PrintSurfaceEditorPage) attaches it via
   * withLatestPdf and PERSISTS it, same discipline as onMarkSent below. This panel never persists
   * the project itself — it only reports the artifact. Returns a Promise the caller resolves only
   * once the save has actually completed (real-usage follow-up spec section 3): generation is not
   * considered "done" — and Download stays disabled (isBusy) — until this resolves. If the caller's
   * persist fails, it rejects and the PREVIOUS latestPdf must remain in effect (spec section 7).
   */
  onPdfGenerated: (latestPdf: PrintSurfaceLatestPdf) => Promise<void>;
  /** Calls markPrintSurfaceProjectSent + persists — only ever invoked from the explicit "Potvrdit jako odesláno" action below, never automatically. */
  onMarkSent: () => void;
}) {
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState("");
  /** The most recent export-history record id created THIS session — "Potvrdit jako odesláno" targets exactly this record, never a stale/unrelated one. */
  const [lastExportId, setLastExportId] = useState<string | undefined>(undefined);
  const [isMarkingSent, setIsMarkingSent] = useState(false);

  const pdfIsCurrent = isPrintSurfacePdfCurrent(project, project.latestPdf);
  const pdfState: "none" | "current" | "stale" = !project.latestPdf ? "none" : pdfIsCurrent ? "current" : "stale";
  const pdfStatusLabel = pdfState === "none" ? "PDF: Nevygenerováno" : pdfState === "current" ? "✓ PDF připraveno" : "⚠ PDF není aktuální";
  const pdfActionLabel = pdfState === "none" ? "Vygenerovat PDF" : pdfState === "current" ? "Stáhnout PDF" : "Aktualizovat PDF";

  /**
   * Dev-only diagnostic (never runs in production — no permanent noisy logging): the FIRST time a
   * given latestPdf artifact is observed as stale, log exactly which fingerprint section(s) differ
   * so a "why did this go stale without an edit" report can be answered from the browser console
   * instead of re-derived by hand. Keyed on storageKey+generatedAt so it logs once per artifact,
   * not once per render — a real, ongoing edit session naturally re-keys as soon as a new PDF is
   * generated, but doesn't re-log on every keystroke while the SAME stale artifact is still shown.
   */
  const loggedStaleArtifactKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (!project.latestPdf || pdfIsCurrent) return;
    const key = `${project.latestPdf.storageKey}:${project.latestPdf.generatedAt}`;
    if (loggedStaleArtifactKeyRef.current === key) return;
    loggedStaleArtifactKeyRef.current = key;
    const current = buildPrintSurfaceProjectFingerprint(project);
    const diff = diffPrintSurfaceProjectFingerprints(project.latestPdf.projectFingerprint, current);
    console.warn("[print-surfaces] PDF marked as not current", { changedFields: diff.changedFields, stored: project.latestPdf.projectFingerprint, current });
  }, [project, pdfIsCurrent]);

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
   * A) try the optimized (downscaled) encode. B) if that fails (e.g. a canvas/CORS-taint error),
   * fall back to embedding the SAME already-decoded image at its own native resolution — no second
   * network fetch (real-usage follow-up spec section 6: "pokud optimization selže, zkus původní
   * image data"). C) if even that fails, this view's photo is genuinely unusable — throws, which
   * the caller (generateAndUploadCurrentPdf) lets propagate: a booth view that WAS successfully
   * fetched/decoded must never silently vanish from a customer-facing PDF, unlike a view whose
   * asset was never reachable at all (a separate, pre-existing, intentionally-degraded
   * "Obrázek není k dispozici" placeholder in lib/printSurfacePdf.ts, untouched by this).
   */
  function prepareViewImageOrThrow(
    label: string, element: HTMLImageElement, originalWidthPx: number, originalHeightPx: number, renderedWidthMm: number, renderedHeightMm: number,
  ): NonNullable<ReturnType<typeof prepareImageForPdf>> {
    const optimized = prepareImageForPdf({ element, originalWidthPx, originalHeightPx, renderedWidthMm, renderedHeightMm, diagnosticLabel: label });
    if (optimized) {
      logPreparedPdfImageDiagnostics(label, { widthPx: originalWidthPx, heightPx: originalHeightPx }, optimized);
      return optimized;
    }
    const native = prepareImageForPdf({ element, originalWidthPx, originalHeightPx, renderedWidthMm, renderedHeightMm, nativeResolution: true, diagnosticLabel: label });
    if (native) {
      logPreparedPdfImageDiagnostics(`${label} (native fallback)`, { widthPx: originalWidthPx, heightPx: originalHeightPx }, native);
      return native;
    }
    throw new Error(`Obrázek pohledu "${label}" se nepodařilo zpracovat pro export PDF.`);
  }

  /**
   * Loads each resolved view photo ONCE (network fetch + decode — see loadImageElement's own doc
   * on why this never re-fetches/re-decodes) and produces the PDF-optimized JPEG for it, sized to
   * exactly the box lib/printSurfacePdf.ts's drawViews will actually render it into (see
   * lib/pdf/printSurfaceViewLayout.ts — the SAME shared layout math, so this can never disagree
   * with what the PDF ends up drawing). This is what fixed the ~12MB export: a full 4000x3000
   * original was previously embedded as lossless PNG at native resolution — see the final report
   * for the measured before/after sizes. Throws (via prepareViewImageOrThrow) rather than silently
   * dropping a view whose image WAS successfully loaded but couldn't be encoded — see its own doc.
   */
  async function loadOptimizedViewImagesForPdf(imageUrlsByViewId: Record<string, string>): Promise<PrintSurfacePdfViewImages> {
    const resolvedViews = views.filter((view) => imageUrlsByViewId[view.id]);
    const loadedEntries = await Promise.all(
      resolvedViews.map(async (view) => [view.id, await loadImageElement(imageUrlsByViewId[view.id]!)] as const),
    );
    const elementsByViewId = new Map(
      loadedEntries.filter((entry): entry is readonly [string, HTMLImageElement] => Boolean(entry[1])),
    );
    if (elementsByViewId.size === 0) return new Map();

    const isPortrait = (element: HTMLImageElement) => element.naturalHeight > element.naturalWidth;
    const bothPortrait = elementsByViewId.size === 2 && [...elementsByViewId.values()].every(isPortrait);
    const box = resolvePrintSurfaceViewRenderBox(resolvedViews.length, bothPortrait);

    const preparedEntries = [...elementsByViewId.entries()].map(([viewId, element]) => {
      const originalWidthPx = element.naturalWidth;
      const originalHeightPx = element.naturalHeight;
      const rect = resolveContainRect({ x: 0, y: 0, width: box.widthMm, height: box.heightMm }, originalWidthPx, originalHeightPx);
      const view = views.find((candidate) => candidate.id === viewId);
      const prepared = prepareViewImageOrThrow(view?.label ?? viewId, element, originalWidthPx, originalHeightPx, rect.width, rect.height);
      return [viewId, { widthPx: prepared.widthPx, heightPx: prepared.heightPx, dataUrl: prepared.dataUrl, format: prepared.format }] as const;
    });

    return new Map(preparedEntries);
  }

  /**
   * The event logo, downscaled to exactly its drawn header-box size (real-usage follow-up: a logo
   * can legitimately be a multi-MB high-resolution PNG upload even though it's shown at a tiny
   * 34x20mm box — see PRINT_SURFACE_PDF_LOGO_DPI). Stays PNG (never JPEG) so real transparency/
   * sharp edges survive — see prepareImageForPdf's own doc. Same optimized -> native-resolution
   * fallback chain as booth views (A/B), but NEVER throws on total failure (C) — unlike a booth
   * view, the logo has an existing, acceptable degraded state: lib/printSurfacePdf.ts's drawHeader
   * falls through to a text-only event name when no logo data URL is provided.
   */
  async function loadOptimizedEventLogoForPdf(logoUrl: string): Promise<string | undefined> {
    const element = await loadImageElement(logoUrl);
    if (!element) return undefined;
    const originalWidthPx = element.naturalWidth;
    const originalHeightPx = element.naturalHeight;
    const box = { renderedWidthMm: PRINT_SURFACE_PDF_EVENT_LOGO_WIDTH_MM, renderedHeightMm: PRINT_SURFACE_PDF_EVENT_LOGO_HEIGHT_MM };
    const optimized = prepareImageForPdf({ element, originalWidthPx, originalHeightPx, ...box, format: "PNG", diagnosticLabel: "event logo" });
    if (optimized) {
      logPreparedPdfImageDiagnostics("event logo", { widthPx: originalWidthPx, heightPx: originalHeightPx }, optimized);
      return optimized.dataUrl;
    }
    const native = prepareImageForPdf({ element, originalWidthPx, originalHeightPx, ...box, format: "PNG", nativeResolution: true, diagnosticLabel: "event logo" });
    if (native) {
      logPreparedPdfImageDiagnostics("event logo (native fallback)", { widthPx: originalWidthPx, heightPx: originalHeightPx }, native);
      return native.dataUrl;
    }
    return undefined;
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
    // A project's name is a required field (never creatable/savable empty — see
    // PrintSurfaceProjectListPage's create form and PrintSurfaceEditorPage's own name input), but
    // it CAN be transiently empty in memory while the user is mid-edit of that field. Refusing here
    // (rather than silently falling back to just the event name segment) is what closes off any
    // path to a degraded "Tiskove_plochy_<Event>.pdf"-only filename — see the final report.
    if (!project.name.trim()) throw new Error("Projekt nemá vyplněný název — PDF nelze vygenerovat.");

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

    const eventLogoDataUrl = eventBranding.logoUrl ? await loadOptimizedEventLogoForPdf(eventBranding.logoUrl) : undefined;
    const viewImages = await loadOptimizedViewImagesForPdf(imageUrlsByViewId);

    const bytes = await buildPrintSurfacePdf(viewModel, { eventLogoDataUrl }, viewImages);
    const fileName = buildPrintSurfaceExportFileName({ eventName: eventBranding.displayName || undefined, projectName: project.name });
    const file = new File([new Uint8Array(bytes)], fileName, { type: "application/pdf" });
    const asset = await uploadAsset(file, { category: "print-surface-export", ownerId: project.id, displayName: fileName });

    // Awaited: the caller (PrintSurfaceEditorPage's handlePdfGenerated) persists the project before
    // this resolves — generateAndUploadCurrentPdf (and therefore handleGenerateOrUpdatePdf/isBusy)
    // does NOT finish until the new latestPdf is confirmed saved, so "Stáhnout PDF" can never become
    // active while pointing at an artifact the database doesn't actually have yet (real-usage
    // follow-up spec section 3/7).
    await onPdfGenerated({
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

  /**
   * "Vygenerovat PDF" (missing) / "Aktualizovat PDF" (stale) — builds/uploads the current PDF and
   * attaches it as the project's latestPdf reference. Deliberately does NOT download anything: a
   * generate/update is a SERVER/STORAGE-side action (see the module doc), never a browser download
   * on its own — that is exclusively handleDownloadCurrentPdf's job below. The UI reflects success
   * purely through pdfState flipping to "current" (✓ PDF připraveno), no separate toast needed.
   */
  async function handleGenerateOrUpdatePdf() {
    // Guards against a double-click/rapid-double-invocation race BEFORE React has re-rendered the
    // now-disabled button (the `disabled={isBusy}` JSX attribute alone cannot prevent two calls
    // dispatched within the same tick) — without this, two concurrent generate/upload runs could
    // race to attach two different latestPdf artifacts one after another.
    if (isBusy) return;
    setError("");
    setIsBusy(true);
    try {
      await generateAndUploadCurrentPdf();
    } catch (error) {
      console.error("Print surface PDF generate/update failed", error);
      setError(error instanceof Error && error.message ? error.message : "Vytvoření PDF souboru se nezdařilo.");
    } finally {
      setIsBusy(false);
    }
  }

  /** "Stáhnout PDF" (current only) — opens the EXISTING current PDF artifact. Never generates/regenerates anything itself; only enabled/shown while pdfState === "current" (see the button below). */
  async function handleDownloadCurrentPdf() {
    if (isBusy || !project.latestPdf) return;
    setError("");
    setIsBusy(true);
    try {
      const downloadUrl = await getAssetDownloadUrl(project.latestPdf.storageKey, project.latestPdf.fileName);
      window.open(downloadUrl, "_blank");
    } catch {
      setError("Stažení PDF souboru se nezdařilo.");
    } finally {
      setIsBusy(false);
    }
  }

  /** Single PDF action button dispatch — which of the two operations above depends purely on pdfState, never both at once. */
  function handlePdfActionClick() {
    if (isBusy) return;
    if (pdfState === "current") {
      void handleDownloadCurrentPdf();
    } else {
      void handleGenerateOrUpdatePdf();
    }
  }

  /** Reuses the current PDF when it's already up to date; regenerates it first when missing/stale (spec: "Připravit e-mail" auto-generates/aktualizuje, never emails a stale artifact). Always logs ONE export-history row for the handoff itself, regardless of whether a new PDF was rendered. */
  async function handleEmailHandoff() {
    if (isBusy) return;
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
    } catch (error) {
      console.error("Print surface export mark-sent failed", error);
      setError("Označení jako odesláno se nezdařilo.");
    } finally {
      setIsMarkingSent(false);
    }
  }

  return (
    <div className="printSurfaceExportPanel">
      <div className="printSurfacePdfStatusRow">
        <span className={`printSurfacePdfBadge ${pdfState}`}>{pdfStatusLabel}</span>
        <button type="button" className="primaryButton" onClick={handlePdfActionClick} disabled={isBusy}>
          {isBusy ? "Připravuji…" : pdfActionLabel}
        </button>
      </div>
      <div className="printSurfaceExportSecondaryActions">
        <button type="button" onClick={() => void handleEmailHandoff()} disabled={isBusy}>Připravit e-mail</button>
        {project.status !== "sent" && (
          <button type="button" onClick={() => void handleMarkSent()} disabled={!lastExportId || isMarkingSent} title={!lastExportId ? "Nejdřív vytvořte export přes 'Vygenerovat PDF' nebo 'Připravit e-mail'" : undefined}>
            {isMarkingSent ? "Potvrzuji…" : "Potvrdit jako odesláno"}
          </button>
        )}
      </div>
      {error && <p className="uploadError">{error}</p>}
    </div>
  );
}
