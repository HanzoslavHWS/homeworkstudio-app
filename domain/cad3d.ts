import type {
  AssetReference,
  BoothAssemblyDefinition,
  BoothAssetDefinition,
  BoothVariant,
  CameraViewDefinition,
  CadModelAsset,
  PlacedComponent,
} from "./models.ts";
import type { StoredAsset } from "./assets.ts";
import type { BufferGeometry, Material, Object3D } from "three";

/**
 * The viewer uses meters as scene units while all project and CAD data remain mm.
 * Keep this conversion at the CAD boundary; editor state must never use scene units.
 */
export const SCENE_UNITS_PER_MILLIMETER = 0.001;

/** CAD is X-right, Y-depth, Z-up. Three.js is X-right, Y-up, Z-depth. */
export const CAD_TO_VIEWER_ROTATION_X_RAD = -Math.PI / 2;

export type Point3 = Readonly<{ x: number; y: number; z: number }>;

export function distanceBetween3DPoints(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

/** Keeps a perspective camera on its current view ray while changing only its target distance. */
export function cameraPositionAtDistance(
  position: Point3,
  target: Point3,
  requestedDistance: number,
  minDistance = 0,
  maxDistance = Number.POSITIVE_INFINITY,
): Point3 {
  const currentDistance = distanceBetween3DPoints(position, target);
  if (!Number.isFinite(currentDistance) || currentDistance <= Number.EPSILON) return position;
  const distance = Math.min(maxDistance, Math.max(minDistance, requestedDistance));
  const scale = distance / currentDistance;
  return {
    x: target.x + (position.x - target.x) * scale,
    y: target.y + (position.y - target.y) * scale,
    z: target.z + (position.z - target.z) * scale,
  };
}

export function cameraZoomPercent(referenceDistance: number, currentDistance: number): number {
  if (referenceDistance <= 0 || currentDistance <= 0) return 100;
  return Math.max(1, Math.round((referenceDistance / currentDistance) * 100));
}

export type Camera3DState = Readonly<{
  position: Point3;
  target: Point3;
  fov: number;
  referenceDistance: number;
}>;

export function cameraStateFromView(
  view: Pick<CameraViewDefinition, "position" | "target" | "fov">,
  fallbackFov: number,
): Camera3DState {
  const position = { x: view.position[0], y: view.position[1], z: view.position[2] };
  const target = { x: view.target[0], y: view.target[1], z: view.target[2] };
  return {
    position,
    target,
    fov: view.fov ?? fallbackFov,
    referenceDistance: distanceBetween3DPoints(position, target),
  };
}

export type PerspectiveCameraFit = Camera3DState & Readonly<{
  near: number;
  far: number;
}>;

/** Pure perspective-fit math; geometry discovery stays in the Three.js viewer. */
export function fitPerspectiveCameraState(
  center: Point3,
  radius: number,
  verticalFovDeg: number,
  aspect: number,
  margin = 1.15,
): PerspectiveCameraFit {
  const verticalFov = (verticalFovDeg * Math.PI) / 180;
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
  const limitingFov = Math.min(verticalFov, horizontalFov);
  const distance = Math.max(0.5, (radius / Math.sin(limitingFov / 2)) * margin);
  const directionLength = Math.hypot(1, 0.78, 1);
  const direction = { x: 1 / directionLength, y: 0.78 / directionLength, z: 1 / directionLength };
  return {
    position: {
      x: center.x + direction.x * distance,
      y: center.y + direction.y * distance,
      z: center.z + direction.z * distance,
    },
    target: center,
    fov: verticalFovDeg,
    referenceDistance: distance,
    near: Math.max(0.001, distance / 100),
    far: Math.max(100, distance * 100),
  };
}

export function mmToSceneUnits(millimeters: number): number {
  return millimeters * SCENE_UNITS_PER_MILLIMETER;
}

export function sceneUnitsToMm(sceneUnits: number): number {
  return sceneUnits / SCENE_UNITS_PER_MILLIMETER;
}

export function modelUnitScaleToScene(unit: CadModelAsset["unit"]): number {
  return unit === "m" ? 1 : SCENE_UNITS_PER_MILLIMETER;
}

export function modelUnitsToMillimeters(
  value: number,
  unit: CadModelAsset["unit"],
): number {
  return unit === "m" ? value * 1000 : value;
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

export type BoothAssemblyVisibility = Readonly<Record<string, boolean>>;

/** Resolves project Scene keys to case-sensitive canonical GLB assembly node ids. */
export function resolveBoothAssemblyVisibility(
  assemblies: readonly BoothAssemblyDefinition[],
  constructionVisibility: Readonly<Record<string, boolean>>,
  assemblyVisible = true,
): BoothAssemblyVisibility {
  return Object.fromEntries(
    assemblies.map((assembly) => [
      assembly.id,
      assemblyVisible &&
        (constructionVisibility[assembly.constructionPartId] ??
          constructionVisibility[assembly.id] ??
          assembly.defaultVisible),
    ]),
  );
}

export const BOOTH_PLAN_VISUAL_PADDING_MM = 40;

export type TopDownBoothPlanFrame = Readonly<{
  canonicalWidthMm: number;
  canonicalDepthMm: number;
  visualPaddingMm: number;
  cameraCenterX: number;
  cameraCenterZ: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
  layerLeftPercent: number;
  layerTopPercent: number;
  layerWidthPercent: number;
  layerHeightPercent: number;
}>;

/**
 * Canonical orthographic frame for a booth GLB top view. It deliberately accepts no model bounds:
 * physical profiles may extend into the fixed visual padding, but can never redefine booth size,
 * dimensions, snap, carpet or collision space.
 */
export function createTopDownBoothPlanFrame(
  canonicalWidthMm: number,
  canonicalDepthMm: number,
  originConvention: BoothAssetDefinition["originConvention"] | undefined,
  visualPaddingMm = BOOTH_PLAN_VISUAL_PADDING_MM,
): TopDownBoothPlanFrame {
  const centered =
    originConvention === "completed-physical-footprint-center-floor";
  const cameraCenterX = centered ? 0 : mmToSceneUnits(canonicalWidthMm / 2);
  const cameraCenterZ = centered ? 0 : -mmToSceneUnits(canonicalDepthMm / 2);
  const halfWidth = mmToSceneUnits(canonicalWidthMm / 2 + visualPaddingMm);
  const halfDepth = mmToSceneUnits(canonicalDepthMm / 2 + visualPaddingMm);

  return {
    canonicalWidthMm,
    canonicalDepthMm,
    visualPaddingMm,
    cameraCenterX,
    cameraCenterZ,
    left: cameraCenterX - halfWidth,
    right: cameraCenterX + halfWidth,
    top: halfDepth,
    bottom: -halfDepth,
    layerLeftPercent: (-visualPaddingMm / canonicalWidthMm) * 100,
    layerTopPercent: (-visualPaddingMm / canonicalDepthMm) * 100,
    layerWidthPercent:
      ((canonicalWidthMm + visualPaddingMm * 2) / canonicalWidthMm) * 100,
    layerHeightPercent:
      ((canonicalDepthMm + visualPaddingMm * 2) / canonicalDepthMm) * 100,
  };
}

/** Applies visibility without flattening/reparenting the loaded GLTF hierarchy. */
export function applyBoothAssemblyVisibility(
  root: Object3D,
  assemblies: readonly BoothAssemblyDefinition[],
  constructionVisibility: Readonly<Record<string, boolean>>,
  assemblyVisible = true,
): readonly string[] {
  const resolved = resolveBoothAssemblyVisibility(
    assemblies,
    constructionVisibility,
    assemblyVisible,
  );
  const missing: string[] = [];

  for (const assembly of assemblies) {
    const node = root.getObjectByName(assembly.id);
    if (!node) {
      missing.push(assembly.id);
      continue;
    }
    node.visible = resolved[assembly.id] ?? assembly.defaultVisible;
  }

  return missing;
}

/**
 * The single booth-GLB preparation boundary shared by every Three.js view. It changes only the
 * loaded root transform/visibility and deliberately preserves the authored child hierarchy and
 * local transforms.
 */
export function applyBoothModelTransform(
  root: Object3D,
  asset: Pick<CadModelAsset, "unit">,
  boothAsset: BoothAssetDefinition | undefined,
  constructionVisibility: Readonly<Record<string, boolean>>,
  assemblyVisible = true,
): readonly string[] {
  root.scale.setScalar(modelUnitScaleToScene(asset.unit));
  root.rotation.x = CAD_TO_VIEWER_ROTATION_X_RAD;
  root.visible = assemblyVisible;
  const missing = boothAsset
    ? applyBoothAssemblyVisibility(
        root,
        boothAsset.assemblies,
        constructionVisibility,
        assemblyVisible,
      )
    : [];
  root.updateMatrixWorld(true);
  return missing;
}

export type PrintableModelNode = Readonly<{
  nodeName: string;
  metadata: Readonly<Record<string, unknown>>;
}>;

/** Exposes GLTF `extras` retained by GLTFLoader on Object3D.userData. */
export function findPrintableModelNodes(root: Object3D): readonly PrintableModelNode[] {
  const printable: PrintableModelNode[] = [];
  root.traverse((node) => {
    if (node.userData.printable === true) {
      printable.push({ nodeName: node.name, metadata: { ...node.userData } });
    }
  });
  return printable;
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

/**
 * Turn 5 LIVE QA bug (report section 28/36): a real DB-catalog-sourced component (e.g. an
 * Admin-uploaded booth_component "sloupek") stores its runtime GLB as ComponentDefinition.
 * modelAsset (R2 StoredAsset) or the legacy ComponentDefinition.modelUrl string — NEVER as
 * assets.models3d[] (that shape is only ever populated by static demo fixtures in data/
 * components.ts). getComponentModel(component.assets) alone therefore silently found nothing for
 * every real catalog-sourced component, and the component never rendered in 3D. This resolves
 * the SAME three sources domain/catalogReadiness.ts's has3DAsset already treats as valid — never
 * a fourth, different rule — priority: (1) a real R2 modelAsset, (2) a bare modelUrl, (3) the
 * legacy assets.models3d[role="component"] entry. The active Admin-uploaded model must win over
 * stale seed metadata; async signed-URL resolution is the CALLER's job — see
 * components/configurator/BoothCadViewer.tsx, which already resolves R2 StoredAssets elsewhere
 * via lib/storage/assetClient.ts's getAssetDownloadUrl. Stored/bare sources use the legacy model
 * declaration only as unit/anchor metadata when present. All sources use the documented
 * "footprint-center-floor" anchor by default — the one GLB convention this
 * whole system authors against (see the Individual booth_component foundation report) — never a
 * per-kind or per-source anchor variation.
 */
export type ResolvedComponentModelSource =
  | Readonly<{ kind: "legacy"; asset: CadModelAsset }>
  | Readonly<{ kind: "stored"; asset: StoredAsset; anchor: CadModelAsset["anchor"]; unit: CadModelAsset["unit"] }>
  | Readonly<{ kind: "url"; url: string; anchor: CadModelAsset["anchor"]; unit: CadModelAsset["unit"] }>;

export function resolveComponentModelReference(
  component: Pick<PlacedComponent, "assets" | "modelUrl" | "modelAsset">,
): ResolvedComponentModelSource | undefined {
  const legacy = getComponentModel(component.assets);
  const anchor = legacy?.anchor ?? "footprint-center-floor";
  const unit = legacy?.unit ?? "mm";
  if (component.modelAsset) return { kind: "stored", asset: component.modelAsset, anchor, unit };
  if (component.modelUrl) return { kind: "url", url: component.modelUrl, anchor, unit };
  if (legacy) return { kind: "legacy", asset: legacy };
  return undefined;
}

export const M57_MATERIAL_NAMES = [
  "MAT_M57_CHROME",
  "MAT_M57_BLACK",
] as const;

function isM57Component(
  component: Pick<PlacedComponent, "definitionId" | "internalCode">,
): boolean {
  return component.internalCode?.trim().toUpperCase() === "M57" ||
    component.definitionId === "chair-basic";
}

/**
 * Applies the narrowly scoped M57 render policy without replacing any authored GLTF material.
 * The production GLB is a consistently wound, closed manifold but omits vertex normals and its
 * thin chair surfaces are authored FrontSide. Other components are intentionally untouched.
 */
export function applyComponentModelMaterialPolicy(
  root: Object3D,
  component: Pick<PlacedComponent, "definitionId" | "internalCode">,
  doubleSide: number,
): Readonly<{ computedNormals: number; updatedMaterials: number }> {
  if (!isM57Component(component)) {
    return { computedNormals: 0, updatedMaterials: 0 };
  }

  const targetMaterials = new Set<string>(M57_MATERIAL_NAMES);
  const updated = new Set<Material>();
  const geometries = new Set<BufferGeometry>();

  root.traverse((object) => {
    const mesh = object as Object3D & {
      isMesh?: boolean;
      geometry?: BufferGeometry;
      material?: Material | readonly Material[];
    };
    if (!mesh.isMesh) return;
    if (mesh.geometry && !mesh.geometry.getAttribute("normal")) {
      mesh.geometry.computeVertexNormals();
      geometries.add(mesh.geometry);
    }
    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];
    materials.forEach((material) => {
      if (!targetMaterials.has(material.name)) return;
      material.side = doubleSide;
      material.needsUpdate = true;
      updated.add(material);
    });
  });

  return {
    computedNormals: geometries.size,
    updatedMaterials: updated.size,
  };
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
