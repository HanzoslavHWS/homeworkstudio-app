"use client";

import { useEffect, useRef, useState } from "react";
import {
  addMarkerPlacementForExistingItem,
  addPrintSurfaceItemWithPlacement,
  addPrintSurfaceView,
  buildPrintSurfaceProjectFingerprint,
  diffPrintSurfaceProjectFingerprints,
  findMarkerPlacement,
  findPrintSurfaceView,
  itemForPlacement,
  itemsWithoutPlacementOnView,
  movePlacement,
  placementsForItem,
  placementsForView,
  markPrintSurfaceProjectSent,
  printSurfaceProjectFingerprintsEqual,
  removeMarkerPlacement,
  renamePrintSurfaceView,
  replacePrintSurfaceViewImage,
  resolvePrintSurfaceItemDimension,
  setPrintSurfaceProjectStatus,
  updatePrintSurfaceItem,
  updatePrintSurfaceItemType,
  withItems,
  withLatestPdf,
  withPlacements,
  withProjectFields,
  type PrintSurfaceItemDimensionResolution,
  type PrintSurfaceLatestPdf,
  type PrintSurfaceProject,
  type PrintSurfaceProjectImage,
  type PrintSurfaceProjectRepository,
  type PrintSurfaceProjectStatus,
} from "../../../domain/printSurfaceProject";
import type { PrintSurfaceTypeId } from "../../../domain/printSurfaceTypeCatalog";
import type { RealizationCompany, RealizationCompanyRepository } from "../../../domain/realizationCompany";
import type { PrintSurfacePreset, PrintSurfacePresetRepository } from "../../../domain/printSurfacePreset";
import type {
  PrintSurfaceProductionDimension,
  PrintSurfaceProductionDimensionRepository,
} from "../../../domain/printSurfaceProductionDimension";
import type { PrintSurfaceExportRepository } from "../../../domain/printSurfaceExport";
import { pendingActionFromActiveTool, SELECT_TOOL, type PrintSurfaceActiveTool } from "../../../domain/printSurfaceActiveTool";
import type { PricingContext } from "../../../domain/catalog";
import type { CatalogItemSummary, PricingEntrySummary } from "../../../domain/catalogPricing";
import { resolveEventPriceListForCurrency, type Exhibition, type PriceList } from "../../../domain/organizations";
import type { Currency } from "../../../domain/models";
import type { PriceListRepository } from "../../../domain/priceListRepository";
import type { RemoteApiCatalogPricingRepository } from "../../../lib/db/catalogPricing.remoteApi.client";
import { resolvePrintSurfacePrice, type PrintSurfacePriceResolution } from "../../../domain/printSurfacePricing";
import { resolveEventBranding } from "../../../domain/eventBranding";
import type { PrintSurfaceEmailContext } from "../../../domain/printSurfaceEmailContext";
import { useAssetUrl } from "../../../hooks/useAssetUrl";
import { uploadAsset, readRasterImageDimensions } from "../../../lib/storage/assetClient";
import { PrintSurfaceCanvas } from "./PrintSurfaceCanvas";
import { PrintSurfaceInspector } from "./PrintSurfaceInspector";
import { PrintSurfaceList } from "./PrintSurfaceList";
import { PrintSurfaceToolbar } from "./PrintSurfaceToolbar";
import { PrintSurfaceExportPanel } from "./PrintSurfaceExportPanel";
import { PrintSurfaceViewTabs } from "./PrintSurfaceViewTabs";

const NOT_DEFINED_RESOLUTION: PrintSurfaceItemDimensionResolution = { status: "not_defined" };

/**
 * A single opened "Tiskové plochy" project — loaded by id from the DB (not a single local draft),
 * autosaved on every change (debounced — see the effect below) PLUS an explicit "Uložit" button
 * that bypasses the debounce (spec section 9), with the sticky active-tool workflow (spec section
 * 10): the toolbar's activeTool lives here, not in PrintSurfaceCanvas, so it survives across
 * repeated marker creations untouched by design.
 *
 * V4 (item/placement split): a physical print surface is a PrintSurfaceItem (label, type, preset,
 * quantity, price — no position) and can be pinned on 1–2 views via separate MarkerPlacement rows
 * (imageId + x/y). The canvas/inspector/list only ever show/edit PLACEMENTS belonging to the
 * active view (see placementsForView); pricing (see domain/printSurfacePricing.ts) is always
 * computed per ITEM so a surface pinned on two views is still billed exactly once.
 */
export function PrintSurfaceEditorPage({
  projectId,
  projectRepository,
  companyRepository,
  presetRepository,
  productionDimensionRepository,
  exportRepository,
  priceListRepository,
  catalogPricingRepository,
  events,
  onBackToList,
  onEmailHandoff,
}: {
  projectId: string;
  projectRepository: PrintSurfaceProjectRepository;
  companyRepository: RealizationCompanyRepository;
  presetRepository: PrintSurfacePresetRepository;
  productionDimensionRepository: PrintSurfaceProductionDimensionRepository;
  exportRepository: PrintSurfaceExportRepository;
  priceListRepository: PriceListRepository;
  catalogPricingRepository: RemoteApiCatalogPricingRepository;
  events: readonly Exhibition[];
  onBackToList: () => void;
  /** Switches to the E-maily tab with this print-surfaces handoff context prefilled (spec section 9) — implemented once at the BoothGenerator level, reused by every module that hands off to E-maily, never a second composer here. */
  onEmailHandoff: (context: PrintSurfaceEmailContext) => void;
}) {
  const [project, setProject] = useState<PrintSurfaceProject | null>(null);
  const [loadError, setLoadError] = useState("");
  const [activeViewId, setActiveViewId] = useState<string | undefined>(undefined);
  const [selectedPlacementId, setSelectedPlacementId] = useState<string | undefined>(undefined);
  const [activeTool, setActiveTool] = useState<PrintSurfaceActiveTool>(SELECT_TOOL);
  const [uploadError, setUploadError] = useState("");
  const [isUploadingView, setIsUploadingView] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [companies, setCompanies] = useState<readonly RealizationCompany[]>([]);
  const [presets, setPresets] = useState<readonly PrintSurfacePreset[]>([]);
  const [productionDimensions, setProductionDimensions] = useState<readonly PrintSurfaceProductionDimension[]>([]);
  const [priceLists, setPriceLists] = useState<readonly PriceList[]>([]);
  const [dbCatalogItems, setDbCatalogItems] = useState<readonly CatalogItemSummary[]>([]);
  const [dbPricingEntries, setDbPricingEntries] = useState<readonly PricingEntrySummary[]>([]);
  const skipNextAutosaveRef = useRef(true);
  const pendingSaveTimeoutRef = useRef<number | undefined>(undefined);
  const projectRef = useRef<PrintSurfaceProject | null>(null);
  projectRef.current = project;

  useEffect(() => {
    skipNextAutosaveRef.current = true;
    let cancelled = false;
    projectRepository
      .get(projectId)
      .then((loaded) => {
        if (cancelled) return;
        if (!loaded) { setLoadError("Projekt nebyl nalezen."); return; }
        setProject(loaded);
        setActiveViewId(loaded.views[0]?.id);
      })
      .catch((error) => { if (!cancelled) setLoadError(error instanceof Error ? error.message : "Projekt se nepodařilo načíst."); });
    return () => { cancelled = true; };
  }, [projectId, projectRepository]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([companyRepository.list(), presetRepository.list(), productionDimensionRepository.list()]).then(
      ([loadedCompanies, loadedPresets, loadedDimensions]) => {
        if (cancelled) return;
        setCompanies(loadedCompanies);
        setPresets(loadedPresets);
        setProductionDimensions(loadedDimensions);
      },
    );
    return () => { cancelled = true; };
  }, [companyRepository, presetRepository, productionDimensionRepository]);

  // Reuses the SAME Event → PriceList → PricingEntry architecture as the main 3D generator (spec
  // section 9.1: "nevytvářej nový paralelní pricing systém") — but with its OWN repository
  // instances/state, since this project's event/realizačka is independent of whatever project is
  // currently open in the main generator.
  useEffect(() => {
    let cancelled = false;
    Promise.all([priceListRepository.list(), catalogPricingRepository.listCatalogItems()]).then(([lists, items]) => {
      if (cancelled) return;
      setPriceLists(lists);
      setDbCatalogItems(items);
    });
    return () => { cancelled = true; };
  }, [priceListRepository, catalogPricingRepository]);

  const resolvedEvent = project ? events.find((event) => event.id === project.eventId) : undefined;
  const pricingCurrency: Currency = resolvedEvent?.defaultCurrency ?? "CZK";
  const resolvedPriceList = resolvedEvent ? resolveEventPriceListForCurrency(resolvedEvent, priceLists, pricingCurrency) : undefined;
  const resolvedPriceListId = resolvedPriceList?.id;

  useEffect(() => {
    if (!resolvedPriceListId) { setDbPricingEntries([]); return; }
    let cancelled = false;
    catalogPricingRepository.listPricingEntries(resolvedPriceListId).then((entries) => {
      if (!cancelled) setDbPricingEntries(entries);
    });
    return () => { cancelled = true; };
  }, [catalogPricingRepository, resolvedPriceListId]);

  /** Returns whether the save actually succeeded — most callers (autosave, handleMarkSent) fire-and-forget and don't care, but handlePdfGenerated below needs to know before it can safely commit a new latestPdf into editor state (real-usage follow-up spec section 3/7). */
  async function persistNow(target: PrintSurfaceProject): Promise<boolean> {
    if (pendingSaveTimeoutRef.current !== undefined) {
      window.clearTimeout(pendingSaveTimeoutRef.current);
      pendingSaveTimeoutRef.current = undefined;
    }
    setSaveStatus("saving");
    try {
      await projectRepository.save(target);
      setSaveStatus("saved");
      return true;
    } catch (error) {
      console.error("Print surface project save failed", error);
      setSaveStatus("error");
      return false;
    }
  }

  // Autosave, debounced — a marker drag calls setProject on every pointer move, but this only
  // fires the actual DB write 600ms after the LAST change (spec section 7). Skips the one
  // "change" caused by the initial load itself (see skipNextAutosaveRef), which would otherwise
  // immediately re-save the project it just fetched.
  useEffect(() => {
    if (!project) return;
    if (skipNextAutosaveRef.current) {
      skipNextAutosaveRef.current = false;
      return;
    }
    setSaveStatus("saving");
    const timeout = window.setTimeout(() => {
      pendingSaveTimeoutRef.current = undefined;
      projectRepository.save(project).then(() => setSaveStatus("saved")).catch((error) => {
        console.error("Print surface project autosave failed", error);
        setSaveStatus("error");
      });
    }, 600);
    pendingSaveTimeoutRef.current = timeout;
    return () => window.clearTimeout(timeout);
  }, [project, projectRepository]);

  /** Explicit "Uložit" (spec section 9) — an immediate save that bypasses the debounce, a UX safety net alongside autosave, never a replacement for it. */
  function handleManualSave() {
    if (projectRef.current) void persistNow(projectRef.current);
  }

  // Escape ends the sticky active tool (spec section 10) — same effect as clicking "Výběr".
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") setActiveTool(SELECT_TOOL);
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const activeView = project ? findPrintSurfaceView(project.views, activeViewId) : undefined;
  const { url: imageUrl } = useAssetUrl(activeView?.image.asset);
  // Section 1/2: an event's own DB-uploaded logoAsset (curated) wins over the static
  // `/events/<slug>/logo.png` convention when present — useAssetUrl already falls back to the
  // legacy/static logoUrl itself while the asset resolves, so resolveEventBranding below never
  // needs to duplicate that fallback logic.
  const { url: eventLogoUrl } = useAssetUrl(resolvedEvent?.logoAsset, resolvedEvent?.logoUrl);

  if (loadError) {
    return (
      <div className="workspacePage">
        <p className="uploadError">{loadError}</p>
        <button type="button" className="textButton" onClick={onBackToList}>← Zpět na seznam projektů</button>
      </div>
    );
  }

  if (!project) {
    return (
      <div className="workspacePage">
        <p className="workspaceEmpty">Načítám…</p>
      </div>
    );
  }

  const activePlacements = placementsForView(project.placements, activeViewId);
  const selectedPlacement = findMarkerPlacement(activePlacements, selectedPlacementId);
  const selectedItem = selectedPlacement ? itemForPlacement(project.items, selectedPlacement) : undefined;
  const selectedItemResolution = selectedItem
    ? resolvePrintSurfaceItemDimension(selectedItem, project.realizationCompanyId, productionDimensions)
    : NOT_DEFINED_RESOLUTION;
  const otherViewLabels = selectedItem
    ? placementsForItem(project.placements, selectedItem.id)
        .filter((placement) => placement.imageId !== activeViewId)
        .map((placement) => findPrintSurfaceView(project.views, placement.imageId)?.label ?? "?")
    : [];
  const linkableItems = activeViewId ? itemsWithoutPlacementOnView(project.items, project.placements, activeViewId) : [];
  const realizationCompany = companies.find((company) => company.id === project.realizationCompanyId);
  const realizationCompanyName = realizationCompany?.name;
  const activeCompanies = companies.filter((company) => company.isActive);
  const eventBranding = resolveEventBranding(resolvedEvent, eventLogoUrl);

  const pricingContext: PricingContext = {
    exhibitionId: project.eventId,
    realizationCompanyId: project.realizationCompanyId,
    priceListId: resolvedPriceListId,
    currency: pricingCurrency,
  };
  // Kept computed (feeds PrintSurfaceList's price column and PrintSurfaceExportPanel's plumbing)
  // but never surfaced as a total in this phase's UI — pricing is deliberately hidden until the
  // full catalog/pricing rework (see PrintSurfaceInspector.tsx's own doc note).
  const itemPriceResolutions = new Map<string, PrintSurfacePriceResolution>();
  for (const item of project.items) {
    const dimensionResolution = resolvePrintSurfaceItemDimension(item, project.realizationCompanyId, productionDimensions);
    itemPriceResolutions.set(item.id, resolvePrintSurfacePrice(item, dimensionResolution, dbCatalogItems, dbPricingEntries, pricingContext));
  }

  function updateProjectFields(fields: Parameters<typeof withProjectFields>[1]) {
    setProject((current) => (current ? withProjectFields(current, fields) : current));
  }

  /**
   * PrintSurfaceCanvas already handles its own upload (uploadAsset/readRasterImageDimensions) and
   * its own "replace warns if this view already has markers" confirm dialog — this just decides
   * what the freshly-uploaded image BECOMES: the project's first view (nothing active yet) or a
   * replacement of the currently active view's image.
   */
  function handleCanvasImageUploaded(image: PrintSurfaceProjectImage) {
    setProject((current) => {
      if (!current) return current;
      if (!activeView) {
        const next = addPrintSurfaceView(current, image);
        const added = next.views[next.views.length - 1];
        if (added) setActiveViewId(added.id);
        return next;
      }
      return replacePrintSurfaceViewImage(current, activeView.id, image);
    });
  }

  async function handleAddView(file: File) {
    setUploadError("");
    setIsUploadingView(true);
    try {
      const dimensions = await readRasterImageDimensions(file);
      if (!dimensions) {
        setUploadError("Nepodařilo se načíst obrázek. Nahrajte prosím JPG nebo PNG.");
        return;
      }
      const asset = await uploadAsset(file, { category: "print-surface-image", ownerId: project.id });
      const image: PrintSurfaceProjectImage = { asset, widthPx: dimensions.widthPx, heightPx: dimensions.heightPx };
      setProject((current) => {
        if (!current) return current;
        const next = addPrintSurfaceView(current, image);
        const addedView = next.views[next.views.length - 1];
        if (addedView && addedView.id !== activeView?.id) setActiveViewId(addedView.id);
        return next;
      });
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Nepodařilo se nahrát obrázek.");
    } finally {
      setIsUploadingView(false);
    }
  }

  function handleRenameView(viewId: string, label: string) {
    setProject((current) => (current ? renamePrintSurfaceView(current, viewId, label) : current));
  }

  function handleCreateAt(xNormalized: number, yNormalized: number) {
    if (!activeViewId) return;
    const pending = pendingActionFromActiveTool(activeTool);
    if (!pending) return;
    setProject((current) => {
      if (!current) return current;
      if (pending.mode === "link") {
        const { project: nextProject, placement } = addMarkerPlacementForExistingItem(current, pending.itemId, activeViewId, xNormalized, yNormalized);
        if (placement) setSelectedPlacementId(placement.id);
        return nextProject;
      }
      const { project: nextProject, placement } = addPrintSurfaceItemWithPlacement(
        current,
        { typeId: pending.typeId, presetId: pending.presetId, customWidthMm: pending.customWidthMm, customHeightMm: pending.customHeightMm },
        activeViewId,
        xNormalized,
        yNormalized,
      );
      setSelectedPlacementId(placement.id);
      return nextProject;
    });
  }

  function handleMovePlacement(id: string, xNormalized: number, yNormalized: number) {
    setProject((current) => (current ? withPlacements(current, movePlacement(current.placements, id, xNormalized, yNormalized)) : current));
  }

  function handleSelectPlacement(id: string | undefined) {
    setSelectedPlacementId(id);
  }

  /** Removes just THIS placement — cascades to a full item delete only when it was the item's last placement anywhere (see removeMarkerPlacement). */
  function handleDeletePlacement(id: string) {
    setProject((current) => (current ? removeMarkerPlacement(current, id) : current));
    setSelectedPlacementId((current) => (current === id ? undefined : current));
  }

  function handleChangeSelectedLabel(label: string) {
    if (!selectedItem) return;
    setProject((current) => (current ? withItems(current, updatePrintSurfaceItem(current.items, selectedItem.id, { label })) : current));
  }

  function handleChangeSelectedType(typeId: PrintSurfaceTypeId) {
    if (!selectedItem) return;
    setProject((current) => (current ? withItems(current, updatePrintSurfaceItemType(current.items, selectedItem.id, typeId, presets)) : current));
  }

  function handleChangeSelectedPreset(presetId: string | undefined) {
    if (!selectedItem) return;
    setProject((current) => (current ? withItems(current, updatePrintSurfaceItem(current.items, selectedItem.id, { presetId })) : current));
  }

  function handleChangeSelectedCustomWidth(widthMm: number) {
    if (!selectedItem) return;
    setProject((current) => (current ? withItems(current, updatePrintSurfaceItem(current.items, selectedItem.id, { customWidthMm: widthMm })) : current));
  }

  function handleChangeSelectedCustomHeight(heightMm: number) {
    if (!selectedItem) return;
    setProject((current) => (current ? withItems(current, updatePrintSurfaceItem(current.items, selectedItem.id, { customHeightMm: heightMm })) : current));
  }

  function handleChangeSelectedQuantity(quantity: number) {
    if (!selectedItem) return;
    setProject((current) => (current ? withItems(current, updatePrintSurfaceItem(current.items, selectedItem.id, { quantity })) : current));
  }

  function handleChangeSelectedNote(note: string) {
    if (!selectedItem) return;
    setProject((current) => (current ? withItems(current, updatePrintSurfaceItem(current.items, selectedItem.id, { note })) : current));
  }

  function handleChangeStatus(status: PrintSurfaceProjectStatus) {
    if (status === "sent") return; // "sent" is only ever set via handleMarkSent below, never this dropdown (spec section 8/10)
    setProject((current) => (current ? setPrintSurfaceProjectStatus(current, status) : current));
  }

  /** The ONLY path to status "sent" — called by PrintSurfaceExportPanel's "Potvrdit jako odesláno", itself only enabled after a real PDF was generated for the email handoff (spec section 10/14: never a fake "Odesláno" from a plain menu click). Persists immediately, bypassing the autosave debounce, same as handleManualSave. */
  function handleMarkSent() {
    setProject((current) => {
      if (!current) return current;
      const next = markPrintSurfaceProjectSent(current, current.createdBy);
      void persistNow(next);
      return next;
    });
  }

  /**
   * Attaches the freshly (re)generated "current PDF" reference to the project — awaited end to end
   * by the caller (PrintSurfaceExportPanel's generateAndUploadCurrentPdf), so isBusy/Download stay
   * disabled until this actually resolves (real-usage follow-up spec section 3). Real change from
   * before: `setProject` (which commits the new latestPdf into editor state — the value Download
   * reads) now happens ONLY AFTER persistNow confirms the save succeeded, not optimistically before
   * it. If the save fails, this throws instead of committing — the PREVIOUS project/latestPdf stays
   * in effect (spec section 7: "zachovej předchozí latestPdf... nevytvářej falešně PDF připraveno"),
   * and PrintSurfaceExportPanel surfaces the thrown message as its error banner. Uses projectRef
   * (not the setProject-updater pattern) because persistNow must be awaited BEFORE deciding whether
   * to commit at all — the same "read the freshest state via the ref" precedent handleManualSave
   * already uses.
   *
   * Immediate self-check (dev only): `latestPdf.projectFingerprint` was built from the `project`
   * PrintSurfaceExportPanel had at click time; `next` here is built from the actual freshest state
   * at the moment this callback runs. They SHOULD always describe the same content — if they don't,
   * the PDF would show "not current" the instant it's generated, which is exactly the bug this
   * guards against.
   */
  async function handlePdfGenerated(latestPdf: PrintSurfaceLatestPdf): Promise<void> {
    const current = projectRef.current;
    if (!current) throw new Error("Projekt není načten.");
    const next = withLatestPdf(current, latestPdf);
    if (process.env.NODE_ENV !== "production") {
      const recomputed = buildPrintSurfaceProjectFingerprint(next);
      if (!printSurfaceProjectFingerprintsEqual(latestPdf.projectFingerprint, recomputed)) {
        const diff = diffPrintSurfaceProjectFingerprints(latestPdf.projectFingerprint, recomputed);
        console.warn(
          "[print-surfaces] self-check failed: PDF just generated but its stored fingerprint already disagrees with the current project state",
          { changedFields: diff.changedFields, stored: latestPdf.projectFingerprint, recomputed },
        );
      }
    }
    const saved = await persistNow(next);
    if (!saved) throw new Error("Nový PDF byl vytvořen, ale uložení projektu se nezdařilo. Zkuste to prosím znovu.");
    // Updater form, not `setProject(next)`: persistNow was a real network round trip — if the user
    // changed something else (e.g. moved a marker) WHILE it was in flight, committing the stale
    // `next` snapshot directly would silently discard that edit. Re-attaching latestPdf onto
    // whatever is actually current now preserves it (that edit's own autosave still fires
    // separately) — and correctly leaves the PDF reading as stale if it truly is relative to it.
    setProject((latest) => (latest ? withLatestPdf(latest, latestPdf) : latest));
  }

  return (
    <div className="workspacePage">
      <div className="workspacePageHeader">
        <div>
          <button type="button" className="textButton printSurfaceBackButton" onClick={onBackToList}>← Tiskové plochy</button>
          <span className="eyebrow">TISKOVÉ PLOCHY</span>
          <h1>{project.name || "Bez názvu"}</h1>
        </div>
        <div className="printSurfaceEditorHeaderActions">
          <span className={`printSurfaceSaveStatus status-${saveStatus}`}>
            {saveStatus === "saving" && "Ukládám…"}
            {saveStatus === "saved" && "Uloženo"}
            {saveStatus === "error" && "Chyba ukládání"}
          </span>
          <button type="button" onClick={handleManualSave} disabled={saveStatus === "saving"}>Uložit</button>
          <PrintSurfaceExportPanel
            project={project}
            views={project.views}
            presets={presets}
            productionDimensions={productionDimensions}
            eventBranding={eventBranding}
            realizationCompanyName={realizationCompanyName}
            realizationCompany={realizationCompany}
            exportRepository={exportRepository}
            priceResolutions={itemPriceResolutions}
            onEmailHandoff={onEmailHandoff}
            onPdfGenerated={handlePdfGenerated}
            onMarkSent={handleMarkSent}
          />
        </div>
      </div>

      <div className="workspaceFormRow">
        <label>
          <span>Název projektu</span>
          <input value={project.name} onChange={(event) => updateProjectFields({ name: event.target.value })} />
        </label>
        <label>
          <span>Firma / zákazník</span>
          <input value={project.companyName} onChange={(event) => updateProjectFields({ companyName: event.target.value })} />
        </label>
        <label>
          <span>Veletrh</span>
          <select value={project.eventId ?? ""} onChange={(event) => updateProjectFields({ eventId: event.target.value || undefined })}>
            <option value="">— Bez veletrhu —</option>
            {events.map((event) => (
              <option key={event.id} value={event.id}>{event.name}</option>
            ))}
          </select>
        </label>
        <label>
          <span>Realizačka</span>
          <select value={project.realizationCompanyId ?? ""} onChange={(event) => updateProjectFields({ realizationCompanyId: event.target.value || undefined })}>
            <option value="">— Bez realizačky —</option>
            {activeCompanies.map((company) => (
              <option key={company.id} value={company.id}>{company.name}</option>
            ))}
          </select>
        </label>
      </div>

      <div className="printSurfaceStatusRow">
        <span>Stav:</span>
        <select value={project.status} onChange={(event) => handleChangeStatus(event.target.value as PrintSurfaceProjectStatus)} disabled={project.status === "sent"}>
          <option value="draft">Rozpracováno</option>
          <option value="ready">Připraveno</option>
          {project.status === "sent" && <option value="sent">Odesláno</option>}
        </select>
      </div>

      <PrintSurfaceViewTabs
        views={project.views}
        activeViewId={activeViewId}
        onSelectView={setActiveViewId}
        onRenameView={handleRenameView}
        onAddView={(file) => void handleAddView(file)}
        isUploading={isUploadingView}
      />

      <PrintSurfaceToolbar
        presets={presets}
        productionDimensions={productionDimensions}
        realizationCompanyId={project.realizationCompanyId}
        linkableItems={linkableItems}
        activeTool={activeTool}
        onChangeTool={setActiveTool}
      />

      <div className="printSurfacesWorkspace">
        <PrintSurfaceCanvas
          projectId={project.id}
          image={activeView?.image}
          items={project.items}
          placements={activePlacements}
          selectedPlacementId={selectedPlacementId}
          canCreate={pendingActionFromActiveTool(activeTool) !== undefined}
          uploadError={uploadError}
          onSelectPlacement={handleSelectPlacement}
          onCreateAt={handleCreateAt}
          onMovePlacement={handleMovePlacement}
          onUploadImage={handleCanvasImageUploaded}
          onUploadError={setUploadError}
        />
        <PrintSurfaceInspector
          item={selectedItem}
          placement={selectedPlacement}
          otherViewLabels={otherViewLabels}
          presets={presets}
          dimensionResolution={selectedItemResolution}
          onChangeLabel={handleChangeSelectedLabel}
          onChangeType={handleChangeSelectedType}
          onChangePreset={handleChangeSelectedPreset}
          onChangeCustomWidth={handleChangeSelectedCustomWidth}
          onChangeCustomHeight={handleChangeSelectedCustomHeight}
          onChangeQuantity={handleChangeSelectedQuantity}
          onChangeNote={handleChangeSelectedNote}
          onDelete={() => selectedPlacement && handleDeletePlacement(selectedPlacement.id)}
        />
      </div>

      <PrintSurfaceList
        items={project.items}
        placements={activePlacements}
        allPlacements={project.placements}
        selectedPlacementId={selectedPlacementId}
        presets={presets}
        productionDimensions={productionDimensions}
        realizationCompanyId={project.realizationCompanyId}
        priceResolutions={itemPriceResolutions}
        onSelectPlacement={handleSelectPlacement}
        onDeletePlacement={handleDeletePlacement}
      />
    </div>
  );
}
