"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useBoothViewport } from "../../../hooks/useBoothViewport";
import { useAssetUrl } from "../../../hooks/useAssetUrl";
import { uploadAsset, readRasterImageDimensions } from "../../../lib/storage/assetClient";
import {
  itemForPlacement,
  normalizeImagePosition,
  type MarkerPlacement,
  type PrintSurfaceItem,
  type PrintSurfaceProjectImage,
} from "../../../domain/printSurfaceProject";
import { printSurfaceTypeLabel } from "../../../domain/printSurfaceTypeCatalog";
import { ViewportToolbar } from "../../configurator/ViewportToolbar";

type DragSession = { id: string; pointerId: number };

/**
 * Renders one view's MarkerPlacements (pins), never PrintSurfaceItems directly — the same
 * physical item can have a placement here AND on the other view, each an independent pin with
 * its own drag/position, both resolving back to the exact same item (label/type/etc — see
 * itemForPlacement) for display.
 */
export function PrintSurfaceCanvas({
  projectId,
  image,
  items,
  placements,
  selectedPlacementId,
  canCreate,
  uploadError,
  onSelectPlacement,
  onCreateAt,
  onMovePlacement,
  onUploadImage,
  onUploadError,
}: {
  projectId: string;
  image: PrintSurfaceProjectImage | undefined;
  items: readonly PrintSurfaceItem[];
  placements: readonly MarkerPlacement[];
  selectedPlacementId: string | undefined;
  canCreate: boolean;
  uploadError: string;
  onSelectPlacement: (id: string | undefined) => void;
  onCreateAt: (xNormalized: number, yNormalized: number) => void;
  onMovePlacement: (id: string, xNormalized: number, yNormalized: number) => void;
  onUploadImage: (image: PrintSurfaceProjectImage) => void;
  onUploadError: (message: string) => void;
}) {
  const dragRef = useRef<DragSession | null>(null);
  const { url: imageUrl } = useAssetUrl(image?.asset);

  // world units = the uploaded image's own pixel dimensions — normalized placement positions
  // (xNormalized/yNormalized, 0–1) are relative to THIS, never to viewport/screen pixels, so a
  // pin stays glued to the same spot on the photo across zoom/pan/Fit/viewport-resize.
  const viewport = useBoothViewport({
    worldWidthMm: image?.widthPx ?? 1,
    worldHeightMm: image?.heightPx ?? 1,
    enabled: image !== undefined,
    fitKey: image ? `${image.asset.id}-${image.widthPx}x${image.heightPx}` : "no-image",
  });

  async function handleFileSelected(file: File) {
    if (image && placements.length > 0) {
      const confirmed = window.confirm(
        "Tento pohled už má umístěné tiskové plochy — jejich pozice jsou vázané na tento konkrétní obrázek. Nahrazením obrázku zůstanou plochy na stejných relativních souřadnicích, ale mohou už neodpovídat novému obrázku. Opravdu nahradit?",
      );
      if (!confirmed) return;
    }
    onUploadError("");
    const dimensions = await readRasterImageDimensions(file);
    if (!dimensions) {
      onUploadError("Nepodařilo se načíst obrázek. Nahrajte prosím JPG nebo PNG.");
      return;
    }
    try {
      const asset = await uploadAsset(file, { category: "print-surface-image", ownerId: projectId });
      onUploadImage({ asset, widthPx: dimensions.widthPx, heightPx: dimensions.heightPx });
    } catch (error) {
      onUploadError(error instanceof Error ? error.message : "Nepodařilo se nahrát obrázek.");
    }
  }

  function handleBackgroundPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (viewport.startPan(event)) return;
    if (event.button !== 0 || !image) return;

    const world = viewport.clientToWorld(event.clientX, event.clientY);
    if (!world) return;

    if (world.x < 0 || world.y < 0 || world.x > image.widthPx || world.y > image.heightPx) {
      onSelectPlacement(undefined);
      return;
    }

    if (!canCreate) {
      onSelectPlacement(undefined);
      return;
    }

    const { xNormalized, yNormalized } = normalizeImagePosition(world.x, world.y, image.widthPx, image.heightPx);
    onCreateAt(xNormalized, yNormalized);
  }

  function handleMarkerPointerDown(event: ReactPointerEvent<HTMLButtonElement>, placement: MarkerPlacement) {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: placement.id, pointerId: event.pointerId };
    onSelectPlacement(placement.id);
  }

  function handleMarkerPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !image) return;
    const world = viewport.clientToWorld(event.clientX, event.clientY);
    if (!world) return;
    const { xNormalized, yNormalized } = normalizeImagePosition(world.x, world.y, image.widthPx, image.heightPx);
    onMovePlacement(drag.id, xNormalized, yNormalized);
  }

  function handleMarkerPointerUp(event: ReactPointerEvent<HTMLButtonElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }

  const viewportClassName = [
    "printSurfaceViewport",
    viewport.isPanning ? "panning" : viewport.isSpacePressed ? "panReady" : "",
    canCreate ? "addMode" : "",
  ].filter(Boolean).join(" ");

  return (
    <div className="workflowCard printSurfaceCanvasPanel">
      {!image && (
        <div className="printSurfaceUploadPrompt">
          <p className="workspaceEmpty">Nahrajte obrázek nebo vizualizaci stánku (JPG nebo PNG).</p>
          <label className="filePicker">
            <span>Nahrát obrázek</span>
            <input
              type="file"
              accept="image/png,image/jpeg"
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (file) void handleFileSelected(file);
                event.target.value = "";
              }}
            />
          </label>
          {uploadError && <p className="uploadError">{uploadError}</p>}
        </div>
      )}

      {image && (
        <>
          <div className="printSurfaceCanvasToolbar">
            <ViewportToolbar
              zoomPercent={viewport.zoomPercent}
              onZoomOut={viewport.zoomOut}
              onZoomIn={viewport.zoomIn}
              onFit={viewport.fitToBooth}
              onReset={viewport.resetZoom}
            />
            <label className="filePicker compact">
              <span>Změnit obrázek</span>
              <input
                type="file"
                accept="image/png,image/jpeg"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void handleFileSelected(file);
                  event.target.value = "";
                }}
              />
            </label>
          </div>
          {uploadError && <p className="uploadError">{uploadError}</p>}

          <div
            ref={viewport.viewportRef}
            className={viewportClassName}
            onPointerDown={handleBackgroundPointerDown}
            onPointerMove={viewport.movePan}
            onPointerUp={viewport.endPan}
            onPointerCancel={viewport.endPan}
          >
            <div
              className="printSurfaceStage"
              style={{
                width: `${image.widthPx * viewport.pixelsPerMm}px`,
                height: `${image.heightPx * viewport.pixelsPerMm}px`,
                transform: `translate(${viewport.transform.pan.x}px, ${viewport.transform.pan.y}px) scale(${viewport.transform.zoom})`,
              }}
            >
              {imageUrl && <img src={imageUrl} alt="" draggable={false} className="printSurfaceImage" />}
              {placements.map((placement) => {
                const item = itemForPlacement(items, placement);
                return (
                  <button
                    key={placement.id}
                    type="button"
                    className={placement.id === selectedPlacementId ? "printSurfaceMarker active" : "printSurfaceMarker"}
                    style={{ left: `${placement.xNormalized * 100}%`, top: `${placement.yNormalized * 100}%` }}
                    onPointerDown={(event) => handleMarkerPointerDown(event, placement)}
                    onPointerMove={handleMarkerPointerMove}
                    onPointerUp={handleMarkerPointerUp}
                    onPointerCancel={handleMarkerPointerUp}
                    title={item ? printSurfaceTypeLabel(item.typeId) : undefined}
                  >
                    {item?.label ?? "?"}
                  </button>
                );
              })}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
