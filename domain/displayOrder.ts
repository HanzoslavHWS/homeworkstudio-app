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

/**
 * "forward"/"backward" SWAP the target with its immediate neighbor in the effective visual
 * order (never a blind +1/-1): a naive increment can land exactly ON an existing neighbor's
 * value — e.g. back/middle/front at 0/1/2, "forward" on back giving 0+1=1 TIES with middle
 * instead of overtaking it, so the stable sort's array-index tie-break leaves the render order
 * completely unchanged. A real swap always produces a visible, deterministic move.
 *
 * Every call also RENORMALIZES every item in the target's own sceneLayer to compact sequential
 * values (0..n-1) in the resulting order. This is what makes reordering work the very first time
 * even when many/all items still share the legacy default displayOrder2D=0 (never yet manually
 * reordered) — with no explicit values to compare, "current effective order" falls back to
 * original array position (identical to sortComponentsFor2D's own tie-break), so the very first
 * click already has a well-defined neighbor to swap with. It also keeps values from growing
 * unboundedly across many repeated "front"/"back" clicks. Items in OTHER sceneLayers (e.g.
 * technical points, which always render above furniture via PLAN_LAYER_PRIORITY) are never
 * touched — layer buckets stay completely independent.
 *
 * "front"/"back" move the target to the absolute end/start of that same effective order, then
 * renormalize the same way. At either boundary (already first for "backward"/"back", already
 * last for "forward"/"front") the requested move is a safe no-op — but a pre-existing tie is
 * still resolved into the same deterministic order sortComponentsFor2D would already show.
 */
export function moveComponentDisplayOrder<T extends PlacedComponent>(
  components: readonly T[],
  componentId: string,
  direction: "forward" | "backward" | "front" | "back",
): readonly T[] {
  const target = components.find((item) => item.id === componentId);
  if (!target) return components;

  const sameLayerIds = components
    .map((item, index) => ({ id: item.id, order: item.displayOrder2D ?? 0, index }))
    .filter((entry) => components[entry.index]!.sceneLayer === target.sceneLayer)
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map((entry) => entry.id);

  const currentIndex = sameLayerIds.indexOf(componentId);
  const lastIndex = sameLayerIds.length - 1;
  let nextIds: readonly string[] = sameLayerIds;

  if (direction === "forward" && currentIndex < lastIndex) {
    nextIds = swapAt(sameLayerIds, currentIndex, currentIndex + 1);
  } else if (direction === "backward" && currentIndex > 0) {
    nextIds = swapAt(sameLayerIds, currentIndex, currentIndex - 1);
  } else if (direction === "front" && currentIndex < lastIndex) {
    nextIds = moveIndexToEnd(sameLayerIds, currentIndex);
  } else if (direction === "back" && currentIndex > 0) {
    nextIds = moveIndexToStart(sameLayerIds, currentIndex);
  }

  const normalizedOrder = new Map(nextIds.map((id, index) => [id, index]));
  return components.map((item) =>
    item.sceneLayer === target.sceneLayer
      ? { ...item, displayOrder2D: normalizedOrder.get(item.id)! }
      : item,
  );
}

function swapAt<T>(items: readonly T[], a: number, b: number): readonly T[] {
  const next = items.slice();
  const temp = next[a]!;
  next[a] = next[b]!;
  next[b] = temp;
  return next;
}

function moveIndexToEnd<T>(items: readonly T[], index: number): readonly T[] {
  const next = items.slice();
  const [moved] = next.splice(index, 1);
  next.push(moved!);
  return next;
}

function moveIndexToStart<T>(items: readonly T[], index: number): readonly T[] {
  const next = items.slice();
  const [moved] = next.splice(index, 1);
  next.unshift(moved!);
  return next;
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
