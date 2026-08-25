import type {
  ArtworkPlacement,
  ArtworkPlacementMode,
  PrintSurfaceAssignment,
} from "./project.ts";

export const DEFAULT_ARTWORK_PLACEMENT: ArtworkPlacement = Object.freeze({
  mode: "stretch",
  scale: 1,
  offsetXmm: 0,
  offsetYmm: 0,
});

export const MIN_ARTWORK_SCALE = 0.1;
export const MAX_ARTWORK_SCALE = 5;

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function normalizeArtworkPlacement(
  placement: ArtworkPlacement | undefined,
): ArtworkPlacement {
  if (!placement) return DEFAULT_ARTWORK_PLACEMENT;
  const mode: ArtworkPlacementMode = ["stretch", "fit", "fill"].includes(placement.mode)
    ? placement.mode
    : "stretch";
  return {
    mode,
    scale: Math.min(MAX_ARTWORK_SCALE, Math.max(MIN_ARTWORK_SCALE, finiteOr(placement.scale, 1))),
    offsetXmm: finiteOr(placement.offsetXmm, 0),
    offsetYmm: finiteOr(placement.offsetYmm, 0),
  };
}

export function artworkPlacementForMode(mode: ArtworkPlacementMode): ArtworkPlacement {
  return { ...DEFAULT_ARTWORK_PLACEMENT, mode };
}

export function artworkPlacementsEqual(
  left: ArtworkPlacement | undefined,
  right: ArtworkPlacement | undefined,
): boolean {
  const a = normalizeArtworkPlacement(left);
  const b = normalizeArtworkPlacement(right);
  return a.mode === b.mode && a.scale === b.scale &&
    a.offsetXmm === b.offsetXmm && a.offsetYmm === b.offsetYmm;
}

export type ArtworkUvTransform = Readonly<{
  mode: ArtworkPlacementMode;
  scale: number;
  offsetXmm: number;
  offsetYmm: number;
  displayedWidthMm: number;
  displayedHeightMm: number;
  repeatU: number;
  repeatV: number;
  offsetU: number;
  offsetV: number;
}>;

/**
 * Maps the fixed surface quad's normalized UV into artwork UV. Values outside 0..1 are clipped
 * by the overlay material, so Fit reveals the base panel and Fill/custom zoom stays constrained
 * to this one print surface.
 */
export function calculateArtworkUvTransform(input: Readonly<{
  surfaceWidthMm: number;
  surfaceHeightMm: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
  placement?: ArtworkPlacement;
}>): ArtworkUvTransform {
  const placement = normalizeArtworkPlacement(input.placement);
  const surfaceWidthMm = Math.max(Number.EPSILON, input.surfaceWidthMm);
  const surfaceHeightMm = Math.max(Number.EPSILON, input.surfaceHeightMm);
  const sourceWidthPx = Math.max(Number.EPSILON, input.sourceWidthPx);
  const sourceHeightPx = Math.max(Number.EPSILON, input.sourceHeightPx);

  let baseWidthMm = surfaceWidthMm;
  let baseHeightMm = surfaceHeightMm;
  if (placement.mode !== "stretch") {
    const fitScale = Math.min(surfaceWidthMm / sourceWidthPx, surfaceHeightMm / sourceHeightPx);
    const fillScale = Math.max(surfaceWidthMm / sourceWidthPx, surfaceHeightMm / sourceHeightPx);
    const pixelsToMm = placement.mode === "fit" ? fitScale : fillScale;
    baseWidthMm = sourceWidthPx * pixelsToMm;
    baseHeightMm = sourceHeightPx * pixelsToMm;
  }

  const displayedWidthMm = baseWidthMm * placement.scale;
  const displayedHeightMm = baseHeightMm * placement.scale;
  const repeatU = surfaceWidthMm / displayedWidthMm;
  const repeatV = surfaceHeightMm / displayedHeightMm;
  return {
    ...placement,
    displayedWidthMm,
    displayedHeightMm,
    repeatU,
    repeatV,
    offsetU: 0.5 - repeatU / 2 - placement.offsetXmm / displayedWidthMm,
    offsetV: 0.5 - repeatV / 2 - placement.offsetYmm / displayedHeightMm,
  };
}

export function updatePrintSurfaceArtworkPlacement(
  assignments: readonly PrintSurfaceAssignment[],
  printSurfaceId: string,
  placement: ArtworkPlacement,
): readonly PrintSurfaceAssignment[] {
  const normalized = normalizeArtworkPlacement(placement);
  return assignments.map((assignment) => assignment.printSurfaceId === printSurfaceId
    ? { ...assignment, artworkPlacement: normalized }
    : assignment);
}
