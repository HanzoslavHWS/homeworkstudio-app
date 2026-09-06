"use client";

import { useRef, type PointerEvent as ReactPointerEvent } from "react";
import { useBoothViewport } from "../../../hooks/useBoothViewport";
import { readRasterImageDimensions } from "../../../lib/storage/assetClient";
import {
  normalizeImagePosition,
  type PrintSurfaceItem,
  type PrintSurfaceProjectImage,
} from "../../../domain/printSurfaceProject";
import { printSurfaceTypeLabel, type PrintSurfaceTypeId } from "../../../domain/printSurfaceTypeCatalog";
import { ViewportToolbar } from "../../configurator/ViewportToolbar";

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Soubor se nepodařilo načíst."));
    reader.readAsDataURL(file);
  });
}

type DragSession = { id: string; pointerId: number };

export function PrintSurfaceCanvas({
  image,
  items,
  selectedItemId,
  activeTool,
  uploadError,
  onSelectItem,
  onCreateItemAt,
  onMoveItem,
  onUploadImage,
  onUploadError,
}: {
  image: PrintSurfaceProjectImage | undefined;
  items: readonly PrintSurfaceItem[];
  selectedItemId: string | undefined;
  activeTool: "select" | PrintSurfaceTypeId;
  uploadError: string;
  onSelectItem: (id: string | undefined) => void;
  onCreateItemAt: (xNormalized: number, yNormalized: number) => void;
  onMoveItem: (id: string, xNormalized: number, yNormalized: number) => void;
  onUploadImage: (image: PrintSurfaceProjectImage) => void;
  onUploadError: (message: string) => void;
}) {
  const dragRef = useRef<DragSession | null>(null);

  // world units = the uploaded image's own pixel dimensions — normalized marker positions
  // (xNormalized/yNormalized, 0–1) are relative to THIS, never to viewport/screen pixels, so a
  // marker stays glued to the same spot on the photo across zoom/pan/Fit/viewport-resize.
  const viewport = useBoothViewport({
    worldWidthMm: image?.widthPx ?? 1,
    worldHeightMm: image?.heightPx ?? 1,
    enabled: image !== undefined,
    fitKey: image ? `${image.fileName}-${image.widthPx}x${image.heightPx}` : "no-image",
  });

  async function handleFileSelected(file: File) {
    onUploadError("");
    const dimensions = await readRasterImageDimensions(file);
    if (!dimensions) {
      onUploadError("Nepodařilo se načíst obrázek. Nahrajte prosím JPG nebo PNG.");
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      onUploadImage({
        dataUrl,
        widthPx: dimensions.widthPx,
        heightPx: dimensions.heightPx,
        fileName: file.name,
      });
    } catch {
      onUploadError("Nepodařilo se načíst obrázek.");
    }
  }

  function handleBackgroundPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (viewport.startPan(event)) return;
    if (event.button !== 0 || !image) return;

    const world = viewport.clientToWorld(event.clientX, event.clientY);
    if (!world) return;

    if (world.x < 0 || world.y < 0 || world.x > image.widthPx || world.y > image.heightPx) {
      onSelectItem(undefined);
      return;
    }

    if (activeTool === "select") {
      onSelectItem(undefined);
      return;
    }

    const { xNormalized, yNormalized } = normalizeImagePosition(world.x, world.y, image.widthPx, image.heightPx);
    onCreateItemAt(xNormalized, yNormalized);
  }

  function handleMarkerPointerDown(event: ReactPointerEvent<HTMLButtonElement>, item: PrintSurfaceItem) {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    dragRef.current = { id: item.id, pointerId: event.pointerId };
    onSelectItem(item.id);
  }

  function handleMarkerPointerMove(event: ReactPointerEvent<HTMLButtonElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !image) return;
    const world = viewport.clientToWorld(event.clientX, event.clientY);
    if (!world) return;
    const { xNormalized, yNormalized } = normalizeImagePosition(world.x, world.y, image.widthPx, image.heightPx);
    onMoveItem(drag.id, xNormalized, yNormalized);
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
    activeTool !== "select" ? "addMode" : "",
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
              <img src={image.dataUrl} alt="" draggable={false} className="printSurfaceImage" />
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={item.id === selectedItemId ? "printSurfaceMarker active" : "printSurfaceMarker"}
                  style={{ left: `${item.xNormalized * 100}%`, top: `${item.yNormalized * 100}%` }}
                  onPointerDown={(event) => handleMarkerPointerDown(event, item)}
                  onPointerMove={handleMarkerPointerMove}
                  onPointerUp={handleMarkerPointerUp}
                  onPointerCancel={handleMarkerPointerUp}
                  title={printSurfaceTypeLabel(item.typeId)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
