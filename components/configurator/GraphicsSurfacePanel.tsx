"use client";

import { useState } from "react";
import type { PrintSurface } from "../../domain/models";
import type {
  ArtworkPlacement,
  ArtworkPlacementMode,
  GraphicFileReference,
  PrintSurfaceAssignment,
} from "../../domain/project";
import {
  artworkPlacementForMode,
  MAX_ARTWORK_SCALE,
  MIN_ARTWORK_SCALE,
  normalizeArtworkPlacement,
} from "../../domain/artworkPlacement";
import { artworkPreviewLabel, isRasterArtworkFile } from "../../lib/printArtworkOverlays";
import type { UploadProgress } from "../../lib/storage/assetClient";

type GraphicsSurfacePanelProps = Readonly<{
  printSurfaces: readonly PrintSurface[];
  assignments: readonly PrintSurfaceAssignment[];
  graphicsFiles: readonly GraphicFileReference[];
  selectedSurfaceId: string | null;
  upload?: UploadProgress;
  onSelectSurface: (surfaceId: string) => void;
  onUpload: (surfaceId: string, file: File) => Promise<void>;
  onAssignExisting: (surfaceId: string, artworkFileId: string) => void;
  onRemove: (surfaceId: string) => void;
  onPlacementChange: (surfaceId: string, placement: ArtworkPlacement) => void;
}>;

function surfaceFaceLabel(surface: PrintSurface): string {
  if (surface.id === "fascia-print") return "Přední";
  return surface.sceneBinding?.face === "back" ? "Zadní" : "Přední";
}

function surfacePanelLabel(surface: PrintSurface): string {
  if (surface.id === "fascia-print") return "Přední";
  const panelName = surface.name.replace(/\s+(FRONT|BACK)$/u, "");
  return `${panelName} – ${surfaceFaceLabel(surface).toLowerCase()}`;
}

export function GraphicsSurfacePanel({
  printSurfaces,
  assignments,
  graphicsFiles,
  selectedSurfaceId,
  upload,
  onSelectSurface,
  onUpload,
  onAssignExisting,
  onRemove,
  onPlacementChange,
}: GraphicsSurfacePanelProps) {
  const [expandedSurfaceIds, setExpandedSurfaceIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const togglePlacementEditor = (surfaceId: string) => {
    setExpandedSurfaceIds((current) => {
      const next = new Set(current);
      if (next.has(surfaceId)) next.delete(surfaceId);
      else next.add(surfaceId);
      return next;
    });
  };
  const active = printSurfaces
    .filter((surface) => surface.active && surface.sceneBinding)
    .sort((left, right) =>
      (left.group?.order ?? 0) - (right.group?.order ?? 0) ||
      (left.order ?? 0) - (right.order ?? 0));
  const groups = active.reduce<Array<{ id: string; name: string; surfaces: PrintSurface[] }>>(
    (result, surface) => {
      const id = surface.group?.id ?? "other";
      const existing = result.find((group) => group.id === id);
      if (existing) existing.surfaces.push(surface);
      else result.push({ id, name: surface.group?.name ?? "Tiskové plochy", surfaces: [surface] });
      return result;
    },
    [],
  );

  if (!groups.length) return null;
  return (
    <section className="graphicsSurfacePanel" aria-label="Grafika tiskových ploch">
      <div className="graphicsSurfacePanelHeader">
        <span className="propertySectionTitle">GRAFIKA</span>
        <small>PNG, JPG a WebP se zobrazí přímo ve 3D. PDF zůstane produkčním zdrojem.</small>
      </div>
      {upload && (
        <div className={`assetUploadState ${upload.state}`}>
          <progress max="100" value={upload.percent} />
          <span>{upload.state === "uploading" ? `Nahrávám ${upload.percent} %` : upload.state === "success" ? "Nahráno do R2" : upload.message}</span>
        </div>
      )}
      {groups.map((group) => (
        <div className="graphicsSurfaceGroup" key={group.id}>
          <strong>{group.name}</strong>
          {group.surfaces.map((surface) => {
            const assignment = assignments.find((item) => item.printSurfaceId === surface.id);
            const file = graphicsFiles.find((item) => item.id === assignment?.artworkFileId);
            const status = file
              ? assignment?.artworkStatus === "ready" ? "Připraveno" : "Data přijata"
              : "Bez grafiky";
            const placement = normalizeArtworkPlacement(assignment?.artworkPlacement);
            const isPlacementExpanded = expandedSurfaceIds.has(surface.id);
            const placementModeLabel = placement.mode === "stretch"
              ? "Stretch"
              : placement.mode === "fit"
                ? "Fit"
                : "Fill";
            const changePlacement = (patch: Partial<ArtworkPlacement>) => {
              onPlacementChange(surface.id, { ...placement, ...patch });
            };
            return (
              <article
                className={`graphicsSurfaceRow ${selectedSurfaceId === surface.id ? "selected" : ""}`}
                key={surface.id}
                onClick={() => onSelectSurface(surface.id)}
              >
                <div className="graphicsSurfaceIdentity">
                  <strong>{surfacePanelLabel(surface)}</strong>
                  <small>{surface.widthMm} × {surface.heightMm} mm · {status}</small>
                  {file && <><span>{file.name}</span><small>{artworkPreviewLabel(file)}</small></>}
                </div>
                <div className="graphicsSurfaceActions" onClick={(event) => event.stopPropagation()}>
                  <label className="filePicker compact">
                    <span>{file ? "Změnit" : "Nahrát"}</span>
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp,.pdf"
                      onChange={(event) => {
                        const selected = event.target.files?.[0];
                        if (selected) void onUpload(surface.id, selected);
                        event.target.value = "";
                      }}
                    />
                  </label>
                  {graphicsFiles.length > 0 && (
                    <select
                      aria-label={`Vybrat existující artwork pro ${surfacePanelLabel(surface)}`}
                      value={file?.id ?? ""}
                      onChange={(event) => {
                        if (event.target.value) onAssignExisting(surface.id, event.target.value);
                      }}
                    >
                      <option value="">Vybrat soubor…</option>
                      {graphicsFiles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
                    </select>
                  )}
                  <button type="button" disabled={!file} onClick={() => onRemove(surface.id)}>Odebrat</button>
                </div>
                {file && isRasterArtworkFile(file) && assignment && (
                  <div className="graphicsPlacementEditor" onClick={(event) => event.stopPropagation()}>
                    <div className="graphicsPlacementSummary">
                      <span>{placementModeLabel} · {Math.round(placement.scale * 100)} % · X {placement.offsetXmm} mm · Y {placement.offsetYmm} mm</span>
                      <button
                        type="button"
                        aria-expanded={isPlacementExpanded}
                        aria-controls={`graphics-placement-controls-${surface.id}`}
                        onClick={() => togglePlacementEditor(surface.id)}
                      >
                        Upravit {isPlacementExpanded ? "▴" : "▾"}
                      </button>
                    </div>
                    {isPlacementExpanded && (
                      <div className="graphicsPlacementControls" id={`graphics-placement-controls-${surface.id}`}>
                        <div className="graphicsPlacementModes">
                          <span>Zobrazení</span>
                          {(["stretch", "fit", "fill"] as const).map((mode: ArtworkPlacementMode) => (
                            <button
                              type="button"
                              className={placement.mode === mode ? "active" : ""}
                              key={mode}
                              onClick={() => onPlacementChange(surface.id, artworkPlacementForMode(mode))}
                            >
                              {mode === "stretch" ? "Stretch" : mode === "fit" ? "Fit" : "Fill"}
                            </button>
                          ))}
                        </div>
                        <div className="graphicsPlacementScale">
                          <span>Měřítko</span>
                          <button type="button" aria-label="Zmenšit artwork" onClick={() => changePlacement({ scale: Math.max(MIN_ARTWORK_SCALE, placement.scale - 0.1) })}>−</button>
                          <strong>{Math.round(placement.scale * 100)} %</strong>
                          <button type="button" aria-label="Zvětšit artwork" onClick={() => changePlacement({ scale: Math.min(MAX_ARTWORK_SCALE, placement.scale + 0.1) })}>+</button>
                        </div>
                        <label><span>Posun X</span><input type="number" step="10" value={placement.offsetXmm} onChange={(event) => changePlacement({ offsetXmm: Number(event.target.value) || 0 })} /><small>mm</small></label>
                        <label><span>Posun Y</span><input type="number" step="10" value={placement.offsetYmm} onChange={(event) => changePlacement({ offsetYmm: Number(event.target.value) || 0 })} /><small>mm</small></label>
                        <button type="button" className="graphicsPlacementReset" onClick={() => onPlacementChange(surface.id, artworkPlacementForMode("stretch"))}>Reset</button>
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      ))}
    </section>
  );
}
