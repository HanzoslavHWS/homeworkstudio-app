import type {
  BoothAssemblyDefinition,
  BoothAssetDefinition,
  BoothType,
  CadModelAsset,
  CollisionRect,
} from "./models.ts";
import { P86_CANONICAL_PRINT_SURFACES } from "./printSurfaces.ts";

export const P86_BOOTH_ASSET_ID = "HWS_BOOTH_KOJE_2000x2000";
export const P86_BOOTH_GLB_PATH =
  "/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb";

/**
 * Canonical P86 hard-collision geometry in WORLD mm (Y=0 front, Y=2000 rear).
 *
 * The authored GLB has a nominal 2000 mm footprint, a completed physical footprint of
 * 2020 mm, and 40 mm posts centred 10 mm inside the nominal edge. Each post therefore
 * occupies 30 mm inside the canonical footprint and 10 mm outside it. These rectangles
 * model only that physical inward obstruction; they add no furniture-clearance padding.
 */
export const P86_CANONICAL_COLLISION_OBSTACLES = [
  { id: "back-wall", x: 0, y: 1970, width: 2000, height: 30 },
  { id: "left-wall", x: 0, y: 1000, width: 30, height: 1000 },
  { id: "right-wall", x: 1970, y: 1000, width: 30, height: 1000 },
] as const satisfies readonly CollisionRect[];

export const P86_BOOTH_ASSEMBLIES = [
  {
    id: "HWS_ASM_BACK_WALL",
    constructionPartId: "back-wall",
    defaultVisible: true,
  },
  {
    id: "HWS_ASM_LEFT_WALL",
    constructionPartId: "left-wall",
    defaultVisible: true,
  },
  {
    id: "HWS_ASM_RIGHT_WALL",
    constructionPartId: "right-wall",
    defaultVisible: true,
  },
  {
    id: "HWS_ASM_TOP_GRID",
    constructionPartId: "upper-grid",
    defaultVisible: true,
  },
  {
    id: "HWS_ASM_FASCIA",
    constructionPartId: "collar",
    defaultVisible: true,
  },
] as const satisfies readonly BoothAssemblyDefinition[];

export const P86_BOOTH_ASSET_DEFINITION = {
  assetId: P86_BOOTH_ASSET_ID,
  catalogItemId: "koje-2x2",
  boothCode: "P86",
  glbAssetPath: P86_BOOTH_GLB_PATH,
  nominalDimensions: { widthMm: 2000, depthMm: 2000, heightMm: 2500 },
  originConvention: "completed-physical-footprint-center-floor",
  assemblies: P86_BOOTH_ASSEMBLIES,
  printableSurfaceCapability: "gltf-node-metadata",
} as const satisfies BoothAssetDefinition;

export const P86_MASTER_MODEL_ASSET = {
  id: P86_BOOTH_ASSET_ID,
  url: P86_BOOTH_GLB_PATH,
  role: "master-reference",
  unit: "m",
  axisSystem: "x-right-y-depth-z-up",
  anchor: "cad-origin",
} as const satisfies CadModelAsset;

type BoothAssetDocument = Readonly<{
  id?: unknown;
  code?: unknown;
  internalCode?: unknown;
  boothAsset?: unknown;
}>;

function isBoothAssetDefinition(value: unknown): value is BoothAssetDefinition {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<BoothAssetDefinition>;
  return (
    typeof candidate.assetId === "string" &&
    typeof candidate.glbAssetPath === "string" &&
    Array.isArray(candidate.assemblies)
  );
}

/** Resolves persisted booth metadata, including the pre-boothAsset P86 compatibility case. */
export function resolveBoothAssetDefinition(
  booth: BoothAssetDocument,
): BoothAssetDefinition | undefined {
  if (isBoothAssetDefinition(booth.boothAsset)) return booth.boothAsset;
  if (
    booth.id === P86_BOOTH_ASSET_DEFINITION.catalogItemId ||
    booth.code === P86_BOOTH_ASSET_DEFINITION.boothCode ||
    booth.internalCode === P86_BOOTH_ASSET_DEFINITION.boothCode
  ) {
    return P86_BOOTH_ASSET_DEFINITION;
  }
  return undefined;
}

/**
 * Runtime compatibility bridge for historical P86 documents. It keeps business/catalog fields
 * and non-master assets intact while normalizing the canonical production GLB, printable
 * surface registry and the three WORLD-space hard-collision rectangles that older catalog
 * snapshots stored at Y=0 or with the legacy 80 mm visual profile instead of the authored
 * physical footprint.
 */
export function withP86BoothAsset(booth: BoothType): BoothType {
  const hasCanonicalP86Identity =
    booth.internalCode === P86_BOOTH_ASSET_DEFINITION.boothCode ||
    (booth.id === P86_BOOTH_ASSET_DEFINITION.catalogItemId &&
      booth.code === P86_BOOTH_ASSET_DEFINITION.boothCode);
  if (!hasCanonicalP86Identity) {
    return booth;
  }

  const otherModels =
    booth.assets?.models3d?.filter(
      (asset) => asset.role !== "master-reference",
    ) ?? [];

  return {
    ...booth,
    modelUrl: P86_BOOTH_GLB_PATH,
    boothAsset: P86_BOOTH_ASSET_DEFINITION,
    // Compatibility guard for catalog snapshots that only knew the legacy fascia-print entry.
    printSurfaces: P86_CANONICAL_PRINT_SURFACES,
    // Compatibility guard for catalog_items documents persisted before P86's collision
    // geometry was moved into canonical WORLD coordinates and reduced from the legacy 80 mm
    // visual profile to the authored 30 mm inward physical footprint.
    collisionObstacles: P86_CANONICAL_COLLISION_OBSTACLES,
    assets: {
      ...booth.assets,
      sourceId: booth.assets?.sourceId ?? "booth-koje-2x2",
      scale: 1,
      unit: "mm",
      models3d: [P86_MASTER_MODEL_ASSET, ...otherModels],
    },
  };
}

export function hasAssemblyMapping(
  assemblies: readonly BoothAssemblyDefinition[] | undefined,
  constructionPartId: string,
): boolean {
  return Boolean(
    assemblies?.some(
      (assembly) => assembly.constructionPartId === constructionPartId,
    ),
  );
}
