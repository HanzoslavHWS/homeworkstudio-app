import type {
  AssetReference,
  BoothVariant,
  CadModelAsset,
  PlacedComponent,
} from "./models.ts";
import type { StoredAsset } from "./assets.ts";

/**
 * The viewer uses meters as scene units while all project and CAD data remain mm.
 * Keep this conversion at the CAD boundary; editor state must never use scene units.
 */
export const SCENE_UNITS_PER_MILLIMETER = 0.001;

/** CAD is X-right, Y-depth, Z-up. Three.js is X-right, Y-up, Z-depth. */
export const CAD_TO_VIEWER_ROTATION_X_RAD = -Math.PI / 2;

export type Point3 = Readonly<{ x: number; y: number; z: number }>;

export function mmToSceneUnits(millimeters: number): number {
  return millimeters * SCENE_UNITS_PER_MILLIMETER;
}

export function sceneUnitsToMm(sceneUnits: number): number {
  return sceneUnits / SCENE_UNITS_PER_MILLIMETER;
}

/** Maps a CAD point (X, Y-depth, Z-up) to Three.js (X, Y-up, Z-back). */
export function cadPointToViewer(pointMm: Point3): Point3 {
  return {
    x: mmToSceneUnits(pointMm.x),
    y: mmToSceneUnits(pointMm.z),
    z: -mmToSceneUnits(pointMm.y),
  };
}

/**
 * Exact inverse of cadPointToViewer — converts a Three.js scene point back to CAD/project mm
 * coordinates. The 3D viewer's `content`/`editorOverlays` groups carry no render-time
 * rotation, so this is a direct inverse with no further undo step needed (see
 * BoothCadViewer.tsx's raycast click handler).
 */
export function viewerPointToCad(pointSceneUnits: Point3): Point3 {
  return {
    x: sceneUnitsToMm(pointSceneUnits.x),
    y: -sceneUnitsToMm(pointSceneUnits.z),
    z: sceneUnitsToMm(pointSceneUnits.y),
  };
}

export function getMasterReferenceModel(
  assets?: AssetReference,
): CadModelAsset | undefined {
  return assets?.models3d?.find((asset) => asset.role === "master-reference");
}

export function getComponentModel(
  assets?: AssetReference,
): CadModelAsset | undefined {
  return assets?.models3d?.find((asset) => asset.role === "component");
}

/**
 * A booth's runtime 3D model may come from one of two sources depending on shape: a legacy
 * static-file CadModelAsset (P86's own `/models/...` master reference, or a demo/test variant's
 * `assetSourceBoothId`-borrowed reference — the "Test series: four independent variants share
 * one canonical booth asset" fixture in data/booths.ts), or a real R2-backed StoredAsset
 * (uploaded per-variant via the catalog admin — see domain/models.ts's BoothVariant.modelAsset).
 * Callers must resolve a StoredAsset's signed download URL themselves (it has no ready-to-load
 * `url`, only a `storageKey` — see hooks/useAssetUrl) before handing it to a GLTFLoader.
 */
export type ResolvedBoothModelSource =
  | Readonly<{ kind: "stored"; asset: StoredAsset }>
  | Readonly<{ kind: "legacy"; asset: CadModelAsset }>;

/**
 * Resolves which 3D model a booth-selection UI should load for the CURRENT selection state.
 *
 * - No variants declared (e.g. P86): always the booth's own master-reference CadModelAsset —
 *   completely unaffected by this function's variant logic, exactly the pre-existing behavior.
 * - Variants declared (e.g. T04..T25): NEVER falls back to the parent's own master reference —
 *   one shared parent GLB for every variant is exactly the bug this resolves. Priority order per
 *   variant: (1) the variant's OWN modelAsset (StoredAsset) if uploaded — this is the real,
 *   per-variant runtime model; (2) a legacy `assetSourceBoothId`/`configurationBoothId` — an
 *   explicit "reuse THIS OTHER booth's geometry" declaration (only ever set by data/booths.ts's
 *   demo/test fixtures, e.g. T4-TEST borrowing P86's asset — never invented for real Txx data);
 *   (3) otherwise undefined — the variant has no asset source declared at all, so it must never
 *   present as an available, selectable-and-ready option.
 * - No variant selected yet (selectedVariantId undefined/not found) on a variants-line booth:
 *   undefined — nothing to load until a variant is chosen.
 */
export function resolveBoothModelSource(
  booth: Readonly<{ variants: readonly BoothVariant[]; assets?: AssetReference }>,
  allBooths: readonly Readonly<{ id: string; assets?: AssetReference }>[],
  selectedVariantId: string | undefined,
): ResolvedBoothModelSource | undefined {
  if (booth.variants.length === 0) {
    const master = getMasterReferenceModel(booth.assets);
    return master ? { kind: "legacy", asset: master } : undefined;
  }

  const variant = booth.variants.find((candidate) => candidate.id === selectedVariantId);
  if (!variant) return undefined;

  if (variant.modelAsset) return { kind: "stored", asset: variant.modelAsset };

  const sourceBoothId = variant.assetSourceBoothId ?? variant.configurationBoothId;
  const sourceBooth = sourceBoothId ? allBooths.find((candidate) => candidate.id === sourceBoothId) : undefined;
  const legacyMaster = getMasterReferenceModel(sourceBooth?.assets);
  return legacyMaster ? { kind: "legacy", asset: legacyMaster } : undefined;
}

/** Whether a declared variant currently has ANY resolvable asset source — used to gate variant-picker availability (an incomplete variant must never present as a ready, selectable option). */
export function isVariantAvailable(
  variant: BoothVariant,
  allBooths: readonly Readonly<{ id: string; assets?: AssetReference }>[],
): boolean {
  if (variant.modelAsset) return true;
  const sourceBoothId = variant.assetSourceBoothId ?? variant.configurationBoothId;
  const sourceBooth = sourceBoothId ? allBooths.find((candidate) => candidate.id === sourceBoothId) : undefined;
  return Boolean(getMasterReferenceModel(sourceBooth?.assets));
}

export function placedComponentToViewerTransform(
  component: Pick<PlacedComponent, "xMm" | "yMm" | "rotationDeg">,
) {
  return {
    position: cadPointToViewer({
      x: component.xMm,
      y: component.yMm,
      z: 0,
    }),
    rotationYRad: (component.rotationDeg * Math.PI) / 180,
  } as const;
}
