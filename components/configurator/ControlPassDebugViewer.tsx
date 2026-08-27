import { useEffect, useState, type RefObject } from "react";
import { downloadDataUrl } from "../../lib/planExport";
import { buildDepthDebugPreviewDataUrl } from "../../lib/visualizationDepthDebug.browser";
import type { DepthDebugStats, ProtectedMaskDepthCorrelation, RawDepthByteDiagnostics } from "../../domain/visualizationDepth";
import { PROTECTED_CATEGORIES, SEMANTIC_CATEGORY_COLORS, EDITABLE_ENVIRONMENT_COLOR } from "../../domain/visualizationSemantics";
import type { BoothCadCameraControls, ControlPassBundle, ControlPassCaptureOptions, DepthSanityCheckResult } from "./BoothCadViewer";

function rgbCss(color: Readonly<{ r: number; g: number; b: number }>): string {
  return `rgb(${color.r}, ${color.g}, ${color.b})`;
}

type ControlPassTile = Readonly<{ slug: string; label: string; dataUrl: string; note?: string }>;

/**
 * Visualization v3.1 — dev-only manual-QA wiring for the 6 control passes. Self-contained: owns
 * the "Vygenerovat kontrolní vrstvy" action, the grid, the Object-ID legend, and its own lightbox.
 * Calls the EXISTING renderControlPassCapture verbatim — never a second capture implementation.
 *
 * Never wired into the production customer-facing flow: the `NODE_ENV !== "production"` gate is
 * INSIDE this component (not at the call site), so mounting it unconditionally from
 * WorkflowSteps.tsx is safe — a production build renders nothing at all, not even the collapsed
 * "Debug AI renderu" summary.
 *
 * Deliberately does NOT reuse WorkflowSteps.tsx's RenderLightbox component directly — that would
 * invert this codebase's configurator -> workflow dependency direction (WorkflowSteps.tsx already
 * imports BoothCadViewer.tsx from this same directory) and risk a circular import. Instead this
 * reuses the exact same CSS classes/visual pattern (.visualizationLightboxOverlay etc.) and the
 * same Escape-to-close/overlay-click-to-close behavior, which is the actual "reuse" the request
 * asked for — no new modal dependency either way.
 */
export function ControlPassDebugViewer({ cameraControlsRef, widthPx, heightPx, backgroundMode }: {
  cameraControlsRef: RefObject<BoothCadCameraControls | null>;
  widthPx: number;
  heightPx: number;
  backgroundMode: ControlPassCaptureOptions["backgroundMode"];
}) {
  const [passes, setPasses] = useState<ControlPassBundle | null>(null);
  const [depthPreviewDataUrl, setDepthPreviewDataUrl] = useState<string | null>(null);
  const [depthStats, setDepthStats] = useState<DepthDebugStats | null>(null);
  const [depthRawDiagnostics, setDepthRawDiagnostics] = useState<RawDepthByteDiagnostics | null>(null);
  const [depthCorrelation, setDepthCorrelation] = useState<ProtectedMaskDepthCorrelation | null>(null);
  const [depthSanityResult, setDepthSanityResult] = useState<DepthSanityCheckResult | null>(null);
  const [error, setError] = useState("");
  const [lightboxSlug, setLightboxSlug] = useState<string | null>(null);

  const tiles: readonly ControlPassTile[] = passes ? [
    { slug: "beauty", label: "Beauty", dataUrl: passes.beautyDataUrl },
    { slug: "protected-mask", label: "Protected mask", dataUrl: passes.protectedMaskDataUrl },
    { slug: "artwork-mask", label: "Artwork mask", dataUrl: passes.artworkMaskDataUrl },
    {
      slug: "depth",
      label: "Depth (vizualizace)",
      // Human-readable linearized grayscale, never the raw packed RGBA (report section 10) — the
      // raw pass itself (used by any future provider) stays in passes.depthDataUrl, untouched.
      dataUrl: depthPreviewDataUrl ?? passes.depthDataUrl,
      note: `raw: RGBA packed · near ${passes.depthNear.toFixed(3)} · far ${passes.depthFar.toFixed(3)}`,
    },
    { slug: "normals", label: "Normals", dataUrl: passes.normalDataUrl },
    { slug: "object-ids", label: "Object IDs", dataUrl: passes.objectIdDataUrl },
  ] : [];
  const lightboxTile = lightboxSlug ? tiles.find((tile) => tile.slug === lightboxSlug) : undefined;
  const depthSanityFailureReason = depthSanityResult && depthSanityResult.ok === false ? depthSanityResult.reason : null;

  useEffect(() => {
    if (!lightboxTile) return;
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === "Escape") setLightboxSlug(null); };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxTile]);

  if (process.env.NODE_ENV === "production") return null;

  async function handleGenerate() {
    setError("");
    // Uses the CURRENT live camera/scene as-is — no applyView() call, so the active
    // camera/target/zoom is never touched even before renderControlPassCapture's own
    // save/restore runs.
    const result = cameraControlsRef.current?.renderControlPassCapture({ widthPx, heightPx, backgroundMode });
    if (!result || result.ok !== true) {
      setError(result?.ok === false && result.reason === "print-tool-active"
        ? "Přepněte nástroj zpět na Výběr před generováním."
        : "Generování kontrolních vrstev se nezdařilo.");
      return;
    }
    // Debug-only visualization built from the already-captured raw depth pass — never a second
    // capture, never mutates result.passes. protectedMaskDataUrl (from the SAME capture) is
    // reused as an independent foreground/coverage signal (report v3.2c "Robustnější varianta") —
    // never a guess derived from the depth bytes themselves.
    const preview = await buildDepthDebugPreviewDataUrl({
      depthDataUrl: result.passes.depthDataUrl,
      near: result.passes.depthNear,
      far: result.passes.depthFar,
      protectedMaskDataUrl: result.passes.protectedMaskDataUrl,
    });
    setPasses(result.passes);
    setDepthPreviewDataUrl(preview.ok === true ? preview.dataUrl : null);
    setDepthStats(preview.ok === true ? preview.stats : null);
    setDepthRawDiagnostics(preview.ok === true ? preview.rawDiagnostics : null);
    setDepthCorrelation(preview.ok === true ? preview.protectedMaskCorrelation : null);
  }

  function handleRunDepthSanityCheck() {
    const result = cameraControlsRef.current?.runDepthSanityCheck();
    if (result) setDepthSanityResult(result);
  }

  return (
    <details className="controlPassDebugSection">
      <summary>Debug AI renderu ▾</summary>
      <div className="controlPassDebugBody">
        <p className="workflowMuted">Dev-only nástroj pro manuální kontrolu kontrolních vrstev pro AI vizualizaci. Nikdy není zobrazen v produkčním buildu.</p>
        <button type="button" onClick={handleGenerate}>Vygenerovat kontrolní vrstvy</button>
        <button type="button" onClick={handleRunDepthSanityCheck}>Spustit Depth known-distance sanity test</button>
        {error && <p className="visualizationRenderError">{error}</p>}
        {depthSanityResult && (
          <details className="controlPassDebugDepthDiagnostics" open>
            <summary>Depth sanity test (near/mid/far isolated boxes) — {depthSanityResult.ok ? (depthSanityResult.monotonic ? "OK: monotonic" : "FAIL: not monotonic") : "FAILED"}</summary>
            {depthSanityResult.ok
              ? <pre className="controlPassDebugDepthSamples">{JSON.stringify(depthSanityResult.samples, null, 2)}</pre>
              : <p className="visualizationRenderError">reason: {depthSanityFailureReason}</p>}
          </details>
        )}
        {passes && (
          <>
            <p className="workflowMuted">{passes.widthPx}×{passes.heightPx}px · near {passes.depthNear.toFixed(3)} / far {passes.depthFar.toFixed(3)} · normalSpace: {passes.normalSpace}</p>
            <div className="controlPassDebugGrid">
              {tiles.map((tile) => (
                <figure key={tile.slug} className="controlPassDebugTile">
                  <button type="button" className="controlPassDebugThumb" onClick={() => setLightboxSlug(tile.slug)} aria-label={`Zvětšit – ${tile.label}`}>
                    <img src={tile.dataUrl} alt={tile.label} />
                  </button>
                  <figcaption>
                    <span>{tile.label}</span>
                    {tile.note && <span className="controlPassDebugTileNote">{tile.note}</span>}
                    {tile.slug === "depth" && depthStats && (
                      <span className="controlPassDebugTileNote">
                        foreground {depthStats.foregroundPixelCount}/{depthStats.totalPixelCount}px
                        {" · min "}{depthStats.minLinearDepth !== null ? depthStats.minLinearDepth.toFixed(4) : "—"}
                        {" · max "}{depthStats.maxLinearDepth !== null ? depthStats.maxLinearDepth.toFixed(4) : "—"}
                        {" · "}{depthStats.uniqueGrayValueCount} unique grays
                      </span>
                    )}
                    <button type="button" onClick={() => downloadDataUrl(tile.dataUrl, `control-pass-${tile.slug}.png`)}>Stáhnout PNG</button>
                  </figcaption>
                </figure>
              ))}
            </div>
            {passes.depthMaterialDiagnostics && (
              <details className="controlPassDebugDepthDiagnostics">
                <summary>Depth material runtime diagnostics (dev)</summary>
                <p className="workflowMuted">
                  type {passes.depthMaterialDiagnostics.type}
                  {" · transparent "}{String(passes.depthMaterialDiagnostics.transparent)}
                  {" · blending "}{passes.depthMaterialDiagnostics.blending}
                  {" · colorWrite "}{String(passes.depthMaterialDiagnostics.colorWrite)}
                  {" · depthWrite "}{String(passes.depthMaterialDiagnostics.depthWrite)}
                  {" · depthTest "}{String(passes.depthMaterialDiagnostics.depthTest)}
                  {" · precision "}{passes.depthMaterialDiagnostics.precision ?? "(renderer default)"}
                </p>
                <pre className="controlPassDebugDepthSamples">{passes.depthMaterialDiagnostics.compiledFragmentShader ?? "(not compiled — onBeforeCompile never fired)"}</pre>
              </details>
            )}
            {depthRawDiagnostics && (
              <details className="controlPassDebugDepthDiagnostics">
                <summary>Depth raw byte diagnostics (dev, pre-unpack)</summary>
                <p className="workflowMuted">
                  total {depthRawDiagnostics.totalPixelCount}px
                  {" · RGBA all-zero "}{depthRawDiagnostics.rgbaAllZeroCount}
                  {" · RGB-zero/alpha-nonzero "}{depthRawDiagnostics.rgbZeroAlphaNonzeroCount}
                  {" · unique alpha "}{depthRawDiagnostics.uniqueAlphaCount}
                  {" · alpha min/max "}{depthRawDiagnostics.alphaMin ?? "—"}/{depthRawDiagnostics.alphaMax ?? "—"}
                </p>
                <pre className="controlPassDebugDepthSamples">{JSON.stringify(depthRawDiagnostics.firstNonZeroSamples, null, 2)}</pre>
              </details>
            )}
            {depthCorrelation && (
              <details className="controlPassDebugDepthDiagnostics">
                <summary>Protected Mask ↔ raw depth pixel correlation (dev)</summary>
                <pre className="controlPassDebugDepthSamples">{JSON.stringify(depthCorrelation, null, 2)}</pre>
              </details>
            )}
            <div className="controlPassDebugLegend">
              <strong>Object IDs — legenda (skutečný semantic color contract z visualizationSemantics.ts):</strong>
              <ul>
                {PROTECTED_CATEGORIES.map((category) => (
                  <li key={category}>
                    <span className="controlPassDebugSwatch" style={{ backgroundColor: rgbCss(SEMANTIC_CATEGORY_COLORS[category]) }} />
                    {category}
                  </li>
                ))}
                <li>
                  <span className="controlPassDebugSwatch" style={{ backgroundColor: rgbCss(EDITABLE_ENVIRONMENT_COLOR) }} />
                  editable-environment (prostředí, které smí AI měnit)
                </li>
              </ul>
            </div>
          </>
        )}
      </div>
      {lightboxTile && (
        <div className="visualizationLightboxOverlay" role="dialog" aria-modal="true" aria-label={`Kontrolní vrstva – ${lightboxTile.label}`} onClick={() => setLightboxSlug(null)}>
          <div className="visualizationLightboxCard" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="visualizationLightboxClose" aria-label="Zavřít náhled" onClick={() => setLightboxSlug(null)}>×</button>
            <img src={lightboxTile.dataUrl} alt={lightboxTile.label} />
            <div className="visualizationLightboxFooter">
              <span>{lightboxTile.label}</span>
              <button type="button" className="primaryButton" onClick={() => downloadDataUrl(lightboxTile.dataUrl, `control-pass-${lightboxTile.slug}.png`)}>Stáhnout PNG</button>
            </div>
          </div>
        </div>
      )}
    </details>
  );
}
