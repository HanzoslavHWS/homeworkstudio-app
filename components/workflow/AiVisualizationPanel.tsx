import { useMemo, useState, type RefObject } from "react";
import { carpetFinishVariants, constructionFinishVariants, selectedFinish } from "../../domain/finishes";
import type { VisualizationItem, VisualizationView } from "../../domain/project";
import {
  ENVIRONMENT_PRESET_LABELS,
  ENVIRONMENT_PRESETS,
  LIGHTING_PRESET_LABELS,
  LIGHTING_PRESETS,
  PEOPLE_PRESET_LABELS,
  PEOPLE_PRESETS,
  createAiVisualizationRender,
  type AiGenerationSettings,
  type EnvironmentPreset,
  type LightingPreset,
  type PeoplePreset,
} from "../../domain/visualizationAi";
import { buildEnvironmentPrompt, buildSceneMetadataForAi, type StructuredAiPrompt } from "../../domain/visualizationAiPrompt";
import { latestAiRendersByView, evaluateRenderStaleness, type VisualizationRenderFingerprint } from "../../domain/visualizationRender";
import { compositeStrictLockInBrowser, type CompositeDebugOverlays } from "../../lib/visualizationAiComposite.browser";
import { downloadDataUrl } from "../../lib/planExport";
import type { BoothCadCameraControls } from "../configurator/BoothCadViewer";
import { ViewRenderCard, RenderLightbox, type CommonProject } from "./WorkflowSteps";

type AiGenerationProgress = "preparing" | "generating" | "compositing" | "saving";

const PROGRESS_LABELS: Readonly<Record<AiGenerationProgress, string>> = {
  preparing: "Připravuji kontrolní data…",
  generating: "Generuji prostředí…",
  compositing: "Skládám finální vizualizaci…",
  saving: "Ukládám…",
};

/**
 * v3.3d — dev-only diagnostics for the "ghosting only on the FIRST request" audit (report
 * v3.3d). Pure read-only inspection of what's ABOUT to be sent — never mutates state, never
 * changes what gets captured/sent/composited. Hashes are SHA-256 (Web Crypto), one-way, and no
 * API key ever reaches the browser to begin with, so there's nothing sensitive in any of this.
 */
async function sha256Hex(bytes: ArrayBuffer | Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256HexOfDataUrl(dataUrl: string): Promise<string> {
  const response = await fetch(dataUrl);
  return sha256Hex(await response.arrayBuffer());
}

async function sha256HexOfText(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}

async function decodedImageDimensions(dataUrl: string): Promise<Readonly<{ width: number; height: number }>> {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return { width: image.naturalWidth, height: image.naturalHeight };
}

/**
 * Logs exactly what THIS generate() call is about to send, captured right after
 * renderControlPassCapture returns and the prompt is built — i.e. the actual state at the moment
 * of the click, not a value re-derived later. Compare this log across two consecutive
 * Generate clicks (same view, same settings) to see whether the CAPTURE itself differed (a
 * client-side/camera-timing bug) before ever suspecting provider variability. Independent
 * server-side logs exist in app/api/visualizations/ai-generate/route.ts (what the route actually
 * received — catches transport bugs) and lib/ai/openaiVisualizationAiProvider.server.ts (prompt
 * hash + requested OpenAI size, computed server-side).
 */
async function logAiGenerationRequestDiagnostics(input: Readonly<{
  sourceRenderId: string;
  viewId: string;
  beautyDataUrl: string;
  protectedMaskDataUrl: string;
  structuredPrompt: StructuredAiPrompt;
  settings: AiGenerationSettings;
}>): Promise<void> {
  try {
    const [beautyDimensions, maskDimensions, beautySha256, protectedMaskSha256, promptSha256] = await Promise.all([
      decodedImageDimensions(input.beautyDataUrl),
      decodedImageDimensions(input.protectedMaskDataUrl),
      sha256HexOfDataUrl(input.beautyDataUrl),
      sha256HexOfDataUrl(input.protectedMaskDataUrl),
      sha256HexOfText(JSON.stringify(input.structuredPrompt)),
    ]);
    // eslint-disable-next-line no-console
    console.info("[ai-generation-diagnostics] client about to send request", {
      timestamp: new Date().toISOString(),
      sourceRenderId: input.sourceRenderId,
      viewId: input.viewId,
      beautyWidthPx: beautyDimensions.width,
      beautyHeightPx: beautyDimensions.height,
      protectedMaskWidthPx: maskDimensions.width,
      protectedMaskHeightPx: maskDimensions.height,
      beautySha256,
      protectedMaskSha256,
      promptSha256,
      environmentPreset: input.settings.environmentPreset,
      peoplePreset: input.settings.peoplePreset,
      lightingPreset: input.settings.lightingPreset,
    });
  } catch (reason) {
    console.warn("[ai-generation-diagnostics] failed to compute client request diagnostics", reason);
  }
}

/**
 * Visualization v3 — the AI-generation workflow panel. Gated entirely on an existing Customer
 * Render (report section 20): "Customer Render → button → settings → generate," never from an
 * arbitrary live viewport. Reuses ViewRenderCard/RenderLightbox verbatim for the resulting AI
 * renders grid — no parallel markup. Never auto-generates on any project mutation; every
 * generation is this component's own explicit "Vygenerovat" click.
 */
export function AiVisualizationPanel({
  project, views, cameraControlsRef, latestCustomerRenders, currentFingerprint, onAddVisualization,
  onDeleteVisualization, onUpdateVisualization, selectedVisualizationViewIds, onToggleView,
}: {
  project: CommonProject;
  views: readonly VisualizationView[];
  cameraControlsRef: RefObject<BoothCadCameraControls | null>;
  latestCustomerRenders: ReadonlyMap<string, VisualizationItem>;
  currentFingerprint: VisualizationRenderFingerprint;
  onAddVisualization: (item: VisualizationItem) => void;
  onDeleteVisualization: (id: string) => void;
  onUpdateVisualization: (item: VisualizationItem) => void;
  selectedVisualizationViewIds: readonly string[];
  onToggleView: (viewId: string) => void;
}) {
  const renderableViews = useMemo(() => views.filter((view) => latestCustomerRenders.has(view.id)), [views, latestCustomerRenders]);
  const [selectedViewId, setSelectedViewId] = useState<string>("");
  const [environmentPreset, setEnvironmentPreset] = useState<EnvironmentPreset>("clean-hall");
  const [peoplePreset, setPeoplePreset] = useState<PeoplePreset>("none");
  const [lightingPreset, setLightingPreset] = useState<LightingPreset>("neutral");
  const [progress, setProgress] = useState<AiGenerationProgress | null>(null);
  const [error, setError] = useState<string>("");
  const [showAfter, setShowAfter] = useState(true);
  const [lightboxViewId, setLightboxViewId] = useState<string | null>(null);
  // v3.3c — dev-only debug overlay (protected mask / feather band / diff-vs-beauty), never shown
  // in a production build, never persisted, never affects the saved render.
  const [debugOverlays, setDebugOverlays] = useState<CompositeDebugOverlays | null>(null);

  const latestAiRenders = useMemo(() => latestAiRendersByView(project.visualizations), [project.visualizations]);
  const aiRenderedViews = useMemo(() => views.filter((view) => latestAiRenders.has(view.id)), [views, latestAiRenders]);
  const effectiveViewId = selectedViewId || renderableViews[0]?.id || "";
  const selectedView = renderableViews.find((view) => view.id === effectiveViewId);
  const sourceRender = effectiveViewId ? latestCustomerRenders.get(effectiveViewId) : undefined;
  const existingAiRender = effectiveViewId ? latestAiRenders.get(effectiveViewId) : undefined;

  const carpetFinish = selectedFinish(project.booth?.carpetVariants ?? carpetFinishVariants, project.carpetFinishId);
  const constructionFinish = selectedFinish(project.booth?.finishVariants ?? constructionFinishVariants, project.constructionFinishId);
  const eventName = project.event?.name ?? project.fairName;

  async function generate(view: VisualizationView, source: VisualizationItem, settings: AiGenerationSettings) {
    setError("");
    setProgress("preparing");
    try {
      cameraControlsRef.current?.applyView(view);
      const passesResult = cameraControlsRef.current?.renderControlPassCapture({
        widthPx: source.widthPx ?? 1920,
        heightPx: source.heightPx ?? 1080,
        backgroundMode: source.backgroundMode ?? "light-neutral",
      });
      if (!passesResult || passesResult.ok !== true) {
        setError(passesResult?.ok === false && passesResult.reason === "print-tool-active"
          ? "Přepněte nástroj zpět na Výběr před generováním."
          : "Přípravu kontrolních dat se nepodařilo dokončit.");
        setProgress(null);
        return;
      }
      const passes = passesResult.passes;

      const metadata = buildSceneMetadataForAi({
        eventName,
        footprintMm: { widthMm: project.booth?.widthMm ?? 0, depthMm: project.booth?.depthMm ?? 0 },
        cameraPosition: view.position,
        cameraTarget: view.target,
        floorType: carpetFinish?.name ?? "Neurčeno",
        materialsSummary: [constructionFinish?.name, carpetFinish?.name].filter((value): value is string => Boolean(value)),
        objectCategoryCounts: {
          "booth-construction": Math.max(1, Object.values(project.constructionVisibility).filter(Boolean).length),
          artwork: project.printSurfaceAssignments.filter((assignment) => Boolean(assignment.artworkFileId)).length,
          furniture: project.sceneObjects.filter((item) => item.visible && item.showIn3D !== false).length,
          "booth-floor": carpetFinish ? 1 : 0,
        },
      });
      // The structured prompt (GOAL/LOCKED/EDITABLE/STYLE/CAMERA) is built here so a future real
      // provider has it available, but is intentionally NOT the mask/compositing guarantee — a
      // provider implementation decides internally how (or whether) to use it; the deterministic
      // fake provider ignores it entirely, which is fine, since protection never depends on it.
      const structuredPrompt = buildEnvironmentPrompt({ metadata, environmentPreset: settings.environmentPreset, peoplePreset: settings.peoplePreset, lightingPreset: settings.lightingPreset });

      // v3.3d — dev-only diagnostics (report v3.3d), captured at the EXACT moment this request is
      // about to be sent, from the SAME passes/settings the fetch below uses. Never changes what
      // gets sent; purely observational.
      if (process.env.NODE_ENV !== "production") {
        await logAiGenerationRequestDiagnostics({
          sourceRenderId: source.id,
          viewId: view.id,
          beautyDataUrl: passes.beautyDataUrl,
          protectedMaskDataUrl: passes.protectedMaskDataUrl,
          structuredPrompt,
          settings,
        });
      }

      setProgress("generating");
      const response = await fetch("/api/visualizations/ai-generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          viewId: view.id,
          sourceRenderId: source.id,
          beautyImageDataUrl: passes.beautyDataUrl,
          protectedMaskDataUrl: passes.protectedMaskDataUrl,
          environmentPreset: settings.environmentPreset,
          peoplePreset: settings.peoplePreset,
          lightingPreset: settings.lightingPreset,
          sceneMetadata: metadata,
          widthPx: passes.widthPx,
          heightPx: passes.heightPx,
        }),
      });
      if (!response.ok) {
        setError("AI generování prostředí se nezdařilo.");
        setProgress(null);
        return;
      }
      const generated = await response.json() as { environmentImageDataUrl: string; widthPx: number; heightPx: number; model: string; provider: string; resolutionDownscaled: boolean };

      setProgress("compositing");
      const composite = await compositeStrictLockInBrowser({
        beautyDataUrl: passes.beautyDataUrl,
        aiEnvironmentDataUrl: generated.environmentImageDataUrl,
        protectedMaskDataUrl: passes.protectedMaskDataUrl,
        debug: process.env.NODE_ENV !== "production",
      });
      if (composite.ok !== true) {
        setError("Skládání finální vizualizace se nezdařilo.");
        setProgress(null);
        return;
      }
      setDebugOverlays(composite.debug ?? null);

      setProgress("saving");
      const currentSource = latestCustomerRenders.get(view.id);
      if (!currentSource) {
        setError("Zdrojový Customer Render již neexistuje.");
        setProgress(null);
        return;
      }
      const item = createAiVisualizationRender({
        name: `${view.name} – realistický vizuál`,
        viewId: view.id,
        sourceRenderId: source.id,
        imageDataUrl: composite.dataUrl,
        widthPx: composite.widthPx,
        heightPx: composite.heightPx,
        format: "png",
        settings,
        contentFingerprint: source.contentFingerprint ?? currentFingerprint,
        provider: generated.provider,
        model: generated.model,
        resolutionDownscaled: generated.resolutionDownscaled,
        purpose: project.visualizationPurpose,
      });
      onAddVisualization(item);
      setProgress(null);
    } catch {
      setError("AI generování prostředí se nezdařilo.");
      setProgress(null);
    }
  }

  function handleGenerateClick() {
    if (!selectedView || !sourceRender || progress !== null) return;
    void generate(selectedView, sourceRender, { mode: "strict-lock", environmentPreset, peoplePreset, lightingPreset });
  }

  function handleRegenerate(view: VisualizationView, render: VisualizationItem) {
    const source = latestCustomerRenders.get(view.id);
    if (!source || progress !== null) return;
    const staleness = evaluateRenderStaleness(source, currentFingerprint);
    if (staleness === "possibly-outdated") {
      const proceed = window.confirm("Zdrojový Customer Render může být zastaralý. Nejprve doporučujeme znovu vyrenderovat pohled. Pokračovat i tak?");
      if (!proceed) return;
    }
    void generate(view, source, {
      mode: "strict-lock",
      environmentPreset: render.environmentPreset ?? "clean-hall",
      peoplePreset: render.peoplePreset ?? "none",
      lightingPreset: render.lightingPreset ?? "neutral",
    });
  }

  const lightboxView = lightboxViewId ? views.find((view) => view.id === lightboxViewId) : undefined;
  const lightboxRender = lightboxView ? latestAiRenders.get(lightboxView.id) : undefined;

  if (renderableViews.length === 0) {
    return <p className="workflowMuted">Nejprve vyrenderujte alespoň jeden Customer Render — AI realistický vizuál z něj vychází.</p>;
  }

  return (
    <div className="aiVisualizationPanel">
      <h3>Realistický vizuál (AI prostředí)</h3>
      <p className="workflowMuted">AI nesmí přenavrhovat stánek — pouze doplňuje okolní prostředí (hala, atmosféra, lidé) kolem autoritativní 3D scény.</p>
      <div className="aiVisualizationSettingsRow">
        <select value={effectiveViewId} onChange={(event) => setSelectedViewId(event.target.value)}>
          {renderableViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
        </select>
        <select value={environmentPreset} onChange={(event) => setEnvironmentPreset(event.target.value as EnvironmentPreset)}>
          {ENVIRONMENT_PRESETS.map((preset) => <option key={preset} value={preset}>{ENVIRONMENT_PRESET_LABELS[preset]}</option>)}
        </select>
        <select value={peoplePreset} onChange={(event) => setPeoplePreset(event.target.value as PeoplePreset)}>
          {PEOPLE_PRESETS.map((preset) => <option key={preset} value={preset}>{PEOPLE_PRESET_LABELS[preset]}</option>)}
        </select>
        <select value={lightingPreset} onChange={(event) => setLightingPreset(event.target.value as LightingPreset)}>
          {LIGHTING_PRESETS.map((preset) => <option key={preset} value={preset}>{LIGHTING_PRESET_LABELS[preset]}</option>)}
        </select>
        <button type="button" className="primaryButton" onClick={handleGenerateClick} disabled={progress !== null || !sourceRender}>
          {progress ? PROGRESS_LABELS[progress] : existingAiRender ? "Vygenerovat s tímto nastavením" : "Vytvořit realistický vizuál"}
        </button>
      </div>
      {error && <p className="visualizationRenderError">{error}</p>}

      {selectedView && sourceRender && existingAiRender && (
        <div className="aiVisualizationBeforeAfter">
          <div className="aiVisualizationBeforeAfterToggle">
            <button type="button" className={!showAfter ? "toggleActive" : ""} onClick={() => setShowAfter(false)}>Před</button>
            <button type="button" className={showAfter ? "toggleActive" : ""} onClick={() => setShowAfter(true)}>Po</button>
          </div>
          <img src={showAfter ? existingAiRender.imageDataUrl : sourceRender.imageDataUrl} alt={showAfter ? "AI vizuál" : "Customer Render"} />
        </div>
      )}

      {process.env.NODE_ENV !== "production" && debugOverlays && (
        <details className="controlPassDebugSection">
          <summary>Debug strict-lock compositu ▾</summary>
          <div className="controlPassDebugBody">
            <p className="workflowMuted">
              Dev-only: efektivní maska (po binarizeMask + outward-only feather), feather band (fialově zvýrazněné pixely, kde se blenduje —
              nesmí zasahovat do chráněné oblasti) a rozdíl finálního composite vůči Beauty (černá = beze změny; jakékoliv jasné místo uvnitř
              chráněné oblasti značí duplikaci/ghosting).
            </p>
            <div className="controlPassDebugGrid">
              {[
                { slug: "effective-mask", label: "Efektivní protected mask", dataUrl: debugOverlays.effectiveMaskDataUrl },
                { slug: "feather-band", label: "Feather band", dataUrl: debugOverlays.featherBandDataUrl },
                { slug: "diff-vs-beauty", label: "Diff vs. Beauty", dataUrl: debugOverlays.diffVsBeautyDataUrl },
              ].map((tile) => (
                <figure key={tile.slug} className="controlPassDebugTile">
                  <div className="controlPassDebugThumb">
                    <img src={tile.dataUrl} alt={tile.label} />
                  </div>
                  <figcaption>
                    <span>{tile.label}</span>
                    <button type="button" onClick={() => downloadDataUrl(tile.dataUrl, `strict-lock-debug-${tile.slug}.png`)}>Stáhnout PNG</button>
                  </figcaption>
                </figure>
              ))}
            </div>
          </div>
        </details>
      )}

      {aiRenderedViews.length > 0 && (
        <div className="visualizationCardGrid">
          {aiRenderedViews.map((view) => {
            const render = latestAiRenders.get(view.id);
            const staleness = render ? evaluateRenderStaleness(render, currentFingerprint) : undefined;
            return (
              <ViewRenderCard
                key={view.id}
                view={view}
                render={render}
                staleness={staleness}
                error={undefined}
                selected={selectedVisualizationViewIds.includes(view.id)}
                canMoveUp={false}
                canMoveDown={false}
                renderBlocked={progress !== null}
                onOpenThumbnail={() => setLightboxViewId(view.id)}
                onOpenCamera={() => cameraControlsRef.current?.applyView(view)}
                onRender={() => render && handleRegenerate(view, render)}
                onDownload={() => render && downloadDataUrl(render.imageDataUrl, `${render.name}.png`)}
                onRename={() => {
                  if (!render) return;
                  const name = window.prompt("Název vizuálu", render.name);
                  if (name !== null && name.trim()) onUpdateVisualization({ ...render, name: name.trim() });
                }}
                onMoveUp={() => {}}
                onMoveDown={() => {}}
                onDelete={() => render && onDeleteVisualization(render.id)}
                onToggleSelected={() => onToggleView(view.id)}
              />
            );
          })}
        </div>
      )}
      {lightboxView && lightboxRender && (
        <RenderLightbox
          viewName={lightboxView.name}
          render={lightboxRender}
          onClose={() => setLightboxViewId(null)}
          onDownload={() => downloadDataUrl(lightboxRender.imageDataUrl, `${lightboxRender.name}.png`)}
        />
      )}
    </div>
  );
}
