import type { BoothType, PlacedComponent } from "../domain/models.ts";
import type { ExportLayer } from "../domain/workflow.ts";
import type {
  CustomDimension,
  ProjectAnnotation,
} from "../domain/spatialAnnotations.ts";
import { dimensionDisplayLabel } from "../domain/spatialAnnotations.ts";
import {
  worldRotationToPlanView180,
  worldToPlanView180,
} from "../domain/planView.ts";
import { sortComponentsFor2D } from "../domain/displayOrder.ts";

export type CadPlanSnapshot = Readonly<{
  imageDataUrl: string;
  bounds: Readonly<{
    minX: number;
    minY: number;
    width: number;
    depth: number;
  }>;
}>;

export const PLAN_RENDER_CONFIG = {
  canvasSizePx: 1600,
  outerMarginPx: 190,
  dimensionOffsetPx: 70,
  dimensionFontPx: 34,
  dimensionTickPx: 14,
  annotationFontPx: { small: 24, medium: 34, large: 46 },
} as const;

export function createPlanRenderLayout(
  boothWidthMm: number,
  boothDepthMm: number,
  sizePx: number = PLAN_RENDER_CONFIG.canvasSizePx,
) {
  const margin = PLAN_RENDER_CONFIG.outerMarginPx;
  const scale = Math.min(
    (sizePx - margin * 2) / boothWidthMm,
    (sizePx - margin * 2) / boothDepthMm,
  );
  return {
    sizePx,
    margin,
    scale,
    originX: (sizePx - boothWidthMm * scale) / 2,
    originY: (sizePx - boothDepthMm * scale) / 2,
    dimensionOffsetPx: PLAN_RENDER_CONFIG.dimensionOffsetPx,
  } as const;
}

export async function renderTechnicalPlanPng(input: {
  booth: BoothType;
  sceneObjects: readonly PlacedComponent[];
  layers: readonly ExportLayer[];
  annotations?: readonly ProjectAnnotation[];
  customDimensions?: readonly CustomDimension[];
  cadSnapshot?: CadPlanSnapshot;
  sizePx?: number;
}): Promise<string> {
  const {
    booth,
    sceneObjects,
    layers,
    annotations = [],
    customDimensions = [],
    cadSnapshot,
    sizePx = PLAN_RENDER_CONFIG.canvasSizePx,
  } = input;
  if (!booth.widthMm || !booth.depthMm) {
    throw new Error("Stánek nemá definovaný footprint.");
  }
  const canvas = document.createElement("canvas");
  canvas.width = sizePx;
  canvas.height = sizePx;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas není dostupný.");

  const layout = createPlanRenderLayout(booth.widthMm, booth.depthMm, sizePx);
  const { scale, originX, originY } = layout;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, sizePx, sizePx);
  context.strokeStyle = "#d7d9da";
  context.lineWidth = 2;
  context.strokeRect(
    originX,
    originY,
    booth.widthMm * scale,
    booth.depthMm * scale,
  );

  if (layers.includes("booth")) {
    if (!cadSnapshot) {
      throw new Error("CAD půdorys ještě není připravený.");
    }
    const cadImage = await loadImage(cadSnapshot.imageDataUrl);
    context.save();
    context.translate(
      originX + booth.widthMm * scale,
      originY + booth.depthMm * scale,
    );
    context.rotate(Math.PI);
    context.drawImage(
      cadImage,
      cadSnapshot.bounds.minX * scale,
      cadSnapshot.bounds.minY * scale,
      cadSnapshot.bounds.width * scale,
      cadSnapshot.bounds.depth * scale,
    );
    context.restore();
  }

  for (const item of sortComponentsFor2D(sceneObjects)) {
    if (!item.visible || !item.showIn2D || !layers.includes(item.sceneLayer)) continue;
    const point = worldToPlanView180(
      { x: item.xMm, y: item.yMm },
      booth.widthMm,
      booth.depthMm,
    );
    context.save();
    context.translate(originX + point.x * scale, originY + point.y * scale);
    context.rotate((worldRotationToPlanView180(item.rotationDeg) * Math.PI) / 180);
    context.fillStyle = item.sceneLayer === "furniture" ? "#f5f5f4" : "#ffffff";
    context.strokeStyle = layerColor(item.sceneLayer);
    context.lineWidth = Math.max(2, scale * 12);
    context.fillRect(-item.widthMm * scale / 2, -item.depthMm * scale / 2, item.widthMm * scale, item.depthMm * scale);
    context.strokeRect(-item.widthMm * scale / 2, -item.depthMm * scale / 2, item.widthMm * scale, item.depthMm * scale);
    context.fillStyle = "#25282a";
    context.font = "600 24px Arial";
    context.textAlign = "center";
    context.fillText(item.name, 0, 8);
    context.restore();
  }

  if (layers.includes("annotations")) {
    context.textAlign = "center";
    annotations.filter((item) => item.visible).forEach((item) => {
      const point = worldToPlanView180(item.position, booth.widthMm!, booth.depthMm!);
      const fontSize = PLAN_RENDER_CONFIG.annotationFontPx[item.textSize ?? "medium"];
      context.font = `600 ${fontSize}px Arial`;
      const metrics = context.measureText(item.text);
      const x = originX + point.x * scale;
      const y = originY + point.y * scale;
      context.fillStyle = "rgba(255, 254, 244, 0.94)";
      context.fillRect(x - metrics.width / 2 - 10, y - fontSize, metrics.width + 20, fontSize + 14);
      context.fillStyle = "#343739";
      context.fillText(item.text, x, y);
    });
  }

  if (layers.includes("dimensions")) {
    drawDimensions(context, booth, customDimensions, layout);
  }

  context.fillStyle = "#6f7376";
  context.font = "600 25px Arial";
  context.textAlign = "left";
  context.fillText(`${booth.name} · ${booth.widthMm} × ${booth.depthMm} mm`, layout.margin, 52);
  return canvas.toDataURL("image/png");
}

function drawDimensions(
  context: CanvasRenderingContext2D,
  booth: BoothType,
  customDimensions: readonly CustomDimension[],
  layout: ReturnType<typeof createPlanRenderLayout>,
) {
  const { originX, originY, scale, dimensionOffsetPx } = layout;
  const nominal = booth.nominalDimensions ?? {
    widthMm: booth.widthMm!,
    depthMm: booth.depthMm!,
    heightMm: booth.heightMm ?? 0,
  };
  context.strokeStyle = "#4a4f52";
  context.fillStyle = "#343739";
  context.lineWidth = 3;
  context.font = `600 ${PLAN_RENDER_CONFIG.dimensionFontPx}px Arial`;
  context.textAlign = "center";
  const widthY = originY - dimensionOffsetPx;
  drawDimensionLine(context, originX, widthY, originX + booth.widthMm! * scale, widthY);
  context.fillText(`${nominal.widthMm} mm`, originX + booth.widthMm! * scale / 2, widthY - 16);
  const depthX = originX - dimensionOffsetPx;
  drawDimensionLine(context, depthX, originY, depthX, originY + booth.depthMm! * scale);
  context.save();
  context.translate(depthX - 18, originY + booth.depthMm! * scale / 2);
  context.rotate(-Math.PI / 2);
  context.fillText(`${nominal.depthMm} mm · V ${nominal.heightMm} mm`, 0, 0);
  context.restore();

  customDimensions.filter((item) => item.visible).forEach((item) => {
    const start = worldToPlanView180(item.start, booth.widthMm!, booth.depthMm!);
    const end = worldToPlanView180(item.end, booth.widthMm!, booth.depthMm!);
    const x1 = originX + start.x * scale;
    const y1 = originY + start.y * scale;
    const x2 = originX + end.x * scale;
    const y2 = originY + end.y * scale;
    drawDimensionLine(context, x1, y1, x2, y2);
    context.fillText(dimensionDisplayLabel(item), (x1 + x2) / 2, (y1 + y2) / 2 - 14);
  });
}

function drawDimensionLine(context: CanvasRenderingContext2D, x1: number, y1: number, x2: number, y2: number) {
  const tick = PLAN_RENDER_CONFIG.dimensionTickPx;
  context.beginPath();
  context.moveTo(x1, y1);
  context.lineTo(x2, y2);
  context.moveTo(x1 - tick, y1 - tick);
  context.lineTo(x1 + tick, y1 + tick);
  context.moveTo(x2 - tick, y2 - tick);
  context.lineTo(x2 + tick, y2 + tick);
  context.stroke();
}

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("CAD snapshot nelze načíst."));
    image.src = source;
  });
}

function layerColor(layer: PlacedComponent["sceneLayer"]): string {
  if (layer === "electrical") return "#9b6c24";
  if (layer === "water") return "#34759a";
  if (layer === "waste") return "#6f687f";
  return "#55595c";
}

export function downloadDataUrl(dataUrl: string, fileName: string): void {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = fileName;
  anchor.click();
}

export function downloadText(text: string, fileName: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  downloadDataUrl(url, fileName);
  URL.revokeObjectURL(url);
}
