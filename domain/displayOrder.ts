import type { PlacedComponent, SceneLayer } from "./models.ts";
import type { WorldBounds } from "../geometry/viewport.ts";

export const PLAN_LAYER_PRIORITY: Readonly<Record<SceneLayer, number>> = {
  furniture: 30,
  electrical: 40,
  water: 40,
  waste: 40,
  annotations: 60,
};

export function componentZIndex(
  component: Pick<PlacedComponent, "sceneLayer" | "displayOrder2D">,
): number {
  return PLAN_LAYER_PRIORITY[component.sceneLayer] + (component.displayOrder2D ?? 0);
}

export function sortComponentsFor2D<T extends Pick<PlacedComponent, "sceneLayer" | "displayOrder2D">>(
  components: readonly T[],
): readonly T[] {
  return [...components].sort((a, b) => componentZIndex(a) - componentZIndex(b));
}

export function moveComponentDisplayOrder<T extends PlacedComponent>(
  components: readonly T[],
  componentId: string,
  direction: "forward" | "backward" | "front" | "back",
): readonly T[] {
  const target = components.find((item) => item.id === componentId);
  if (!target) return components;
  const sameLayer = components.filter((item) => item.sceneLayer === target.sceneLayer);
  const orders = sameLayer.map((item) => item.displayOrder2D ?? 0);
  const current = target.displayOrder2D ?? 0;
  const next = direction === "front"
    ? Math.max(0, ...orders) + 1
    : direction === "back"
      ? Math.min(0, ...orders) - 1
      : current + (direction === "forward" ? 1 : -1);
  return components.map((item) => item.id === componentId ? { ...item, displayOrder2D: next } : item);
}

export function scenePlanBounds(
  boothWidthMm: number,
  boothDepthMm: number,
  components: readonly Pick<PlacedComponent, "xMm" | "yMm" | "widthMm" | "depthMm" | "visible" | "showIn2D">[],
): WorldBounds {
  return components
    .filter((item) => item.visible && item.showIn2D)
    .reduce<WorldBounds>((bounds, item) => ({
      minX: Math.min(bounds.minX, item.xMm - item.widthMm / 2),
      minY: Math.min(bounds.minY, item.yMm - item.depthMm / 2),
      maxX: Math.max(bounds.maxX, item.xMm + item.widthMm / 2),
      maxY: Math.max(bounds.maxY, item.yMm + item.depthMm / 2),
    }), { minX: 0, minY: 0, maxX: boothWidthMm, maxY: boothDepthMm });
}
