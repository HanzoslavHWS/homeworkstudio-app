import type { SourceAssetEntry, StoredAsset } from "./assets.ts";

export type ProjectType = "typovy" | "individualni";
export type Currency = "CZK" | "EUR";
export type RotationControlMode = "free" | "snap";
export type PlanViewType = "ground" | "overhead";
export type PlanRenderStyle2D = "solid" | "dashed" | "hatched";
export type SceneLayer =
  | "furniture"
  | "electrical"
  | "water"
  | "waste"
  | "annotations";

/** Catalog publication lifecycle. Undefined on an item means "legacy seed, predates this field" — treated as active for backward compatibility. */
export const CATALOG_ITEM_STATUSES = [
  "draft",
  "needs_review",
  "active",
  "inactive",
  "archived",
] as const;
export type CatalogItemStatus = (typeof CATALOG_ITEM_STATUSES)[number];

/**
 * Classification used to select which readiness rules apply — see domain/catalogReadiness.ts.
 * "booth_component" is an individual booth-construction element (sloupek/panel/dveře/límec/
 * rastr/koberec, ...) evidenced for future individual-booth assembly — distinct from "booth"
 * (a complete, placeable type-booth) because it needs its OWN mandatory-asset rule (GLB+SKP)
 * rather than booth's footprint-dimensions rule. Deliberately reuses the same ComponentDefinition
 * document shape and the same catalog_items table as every other kind — never a parallel model.
 */
export const CATALOG_ITEM_KINDS = [
  "booth",
  "booth_component",
  "construction",
  "furniture",
  "technical_point",
  "service",
  "graphics_service",
  "floor_finish",
  "other",
] as const;
export type CatalogItemKind = (typeof CATALOG_ITEM_KINDS)[number];

export type MaterialRole =
  | "OCTANORM_WHITE"
  | "OCTANORM_BLACK"
  | "PANEL_WHITE"
  | "PRINT_SURFACE"
  | "METAL"
  | "FABRIC"
  | "CARPET";

export type NominalDimensions = Readonly<{
  widthMm: number;
  depthMm: number;
  heightMm: number;
}>;

export type FinishVariant = Readonly<{
  id: string;
  code: string;
  name: string;
  swatchColor?: string;
  textureUrl?: string;
  materialRole: MaterialRole;
  active: boolean;
  pricingUnit?: "piece" | "square-meter" | "fixed";
  pricingEntries?: readonly PricingEntry[];
}>;

export type CatalogCategory = Readonly<{
  id: string;
  name: string;
  active: boolean;
  order?: number;
}>;

export type PartRole =
  | "frame"
  | "panel"
  | "print_surface"
  | "post"
  | "fascia"
  | "furniture_body";

export type PrintSurface = Readonly<{
  id: string;
  name: string;
  widthMm: number;
  heightMm: number;
  nodeName?: string;
  materialRole?: MaterialRole;
  orientation?: "portrait" | "landscape" | "custom";
  active: boolean;
  allowanceLinearMeters?: number;
  pricingUnit?: "bm" | "m²";
  productionProfiles?: Readonly<
    Record<string, Readonly<{ widthMm?: number; heightMm?: number }>>
  >;
}>;

export type BoothPackageItem = Readonly<{
  id: string;
  kind: "floor-finish" | "construction" | "print-allowance";
  name: string;
  quantity: number;
  unit: "ks" | "m²" | "bm";
  includedInBasePrice: true;
  catalogItemId?: string;
  finishId?: string;
  printSurfaceId?: string;
}>;

export type PartDefinition = Readonly<{
  id: string;
  nodeName: string;
  role: PartRole;
  printable: boolean;
  materialRole?: MaterialRole;
  printSurfaceId?: string;
}>;

export type RealizationProfile = Readonly<{
  id: string;
  name: string;
}>;

export type ComponentDimensions = Readonly<{
  widthMm: number;
  depthMm?: number;
  heightMm?: number;
}>;

export type ProductionDimensionsOverride = Readonly<{
  exportWidthMm?: number;
  exportDepthMm?: number;
  exportHeightMm?: number;
}>;

export type ProductionProfiles = Readonly<
  Record<string, ProductionDimensionsOverride>
>;

export type Notes = Readonly<{
  internalNote: string;
  customerNote: string;
}>;

export type RotationPolicy = Readonly<{
  defaultMode: RotationControlMode;
  snapStep: 45 | 90;
  quickAngles: readonly number[];
  allowFreeRotation: boolean;
  locked: boolean;
}>;

export type Point = Readonly<{ x: number; y: number }>;

export type CollisionRect = Readonly<{
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type PlanRect = Readonly<{
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
}>;

export type ConstructionPart = Readonly<{
  id: string;
  name: string;
  collisionObstacleId?: string;
  planViewType: PlanViewType;
  collision2D: boolean;
  renderStyle2D: PlanRenderStyle2D;
  planRects?: readonly PlanRect[];
  rotation: RotationPolicy;
  systemLocked: boolean;
  userLocked: boolean;
  visible: boolean;
}>;

export type Fair = Readonly<{
  id: string;
  name: string;
  priceList: string;
  defaultCurrency: Currency;
  logo: string;
}>;

export type BoothVariant = Readonly<{
  id: string;
  name: string;
  configurationBoothId?: string;
  assetSourceBoothId?: string;
  widthMm?: number;
  depthMm?: number;
  heightMm?: number;
  /** Own runtime GLB for this variant — independent of any other variant's/parent's modelAsset. */
  modelAsset?: StoredAsset;
  photoAsset?: StoredAsset;
  /**
   * Generic source/manufacturing files (SKP authoring source, DWG/DXF/PDF, other) — the SAME
   * model as ComponentDefinition.sourceAssets (see domain/assets.ts's SourceAssetEntry), never a
   * hardcoded skpAsset/dwgAsset/dxfAsset per-kind field. domain/catalogReadiness.ts's booth rule
   * requires a "sketchup"-kind entry here per variant; dwg/dxf/pdf/other are always optional.
   */
  sourceAssets?: readonly SourceAssetEntry[];
}>;

export type CadAxisSystem = "x-right-y-depth-z-up";
export type CadModelRole =
  | "master-reference"
  | "construction-part"
  | "component";

export type CadModelAsset = Readonly<{
  id: string;
  url: string;
  role: CadModelRole;
  unit: "mm";
  axisSystem: CadAxisSystem;
  anchor?: "cad-origin" | "footprint-center-floor";
}>;

export type AssetReference = Readonly<{
  /** Stable external identifier used when the placeholder is replaced 1:1. */
  sourceId: string;
  revision?: string;
  cad2dUrl?: string;
  model3dUrl?: string;
  models3d?: readonly CadModelAsset[];
  scale: 1;
  unit: "mm";
}>;

export type ConstructionPricingPolicy = Readonly<{
  mode: "fixed" | "configuration-dependent";
  structuralChangesAffectPrice: boolean;
  orderedItemsAffectPrice: true;
}>;

export type BoothType = Readonly<{
  id: string;
  code: string;
  name: string;
  description: string;
  projectType: ProjectType;
  size: string;
  area: string;
  widthMm: number | null;
  depthMm: number | null;
  heightMm: number | null;
  nominalDimensions?: NominalDimensions;
  cadDimensions?: ComponentDimensions;
  collarHeightMm: number | null;
  profileWidthMm: number | null;
  configReady: boolean;
  systemLocked: boolean;
  userLocked: boolean;
  visible: boolean;
  variants: readonly BoothVariant[];
  constructionParts: readonly ConstructionPart[];
  collisionObstacles: readonly CollisionRect[];
  pricing: ConstructionPricingPolicy;
  assets?: AssetReference;
  internalCode?: string;
  thumbnailUrl?: string;
  thumbnailAsset?: StoredAsset;
  active?: boolean;
  defaultViews?: readonly CameraViewDefinition[];
  pricingEntries?: readonly PricingEntry[];
  parts?: readonly BoothPartReference[];
  category?: string;
  photoUrl?: string;
  photoAsset?: StoredAsset;
  modelUrl?: string;
  sketchupUrl?: string;
  /** See ComponentDefinition.sourceAssets — same generic SKP/DWG/DXF/PDF/other model, reused verbatim for booths. */
  sourceAssets?: readonly SourceAssetEntry[];
  printable?: boolean;
  printSurfaces?: readonly PrintSurface[];
  partDefinitions?: readonly PartDefinition[];
  finishVariants?: readonly FinishVariant[];
  carpetVariants?: readonly FinishVariant[];
  packageContents?: readonly BoothPackageItem[];
  defaultCarpetFinishId?: string;
  graphicsRequired?: boolean;
  vatRatePercent?: number;
  /** Absent = legacy seed item (e.g. P86), treated as active for backward compatibility. */
  lifecycleStatus?: CatalogItemStatus;
}>;

export type Vector3Tuple = readonly [number, number, number];

export type CameraViewDefinition = Readonly<{
  id: string;
  name: string;
  position: Vector3Tuple;
  target: Vector3Tuple;
  fov?: number;
}>;

export type BoothPartReference = Readonly<{
  id: string;
  catalogItemId: string;
  quantity: number;
}>;

/**
 * Absent salePrice is ambiguous on its own (does it mean "not priced yet" or "priced at
 * zero on purpose"?) — priceMode disambiguates it. Absent priceMode = "fixed" for full
 * backward compatibility with existing seed PricingEntry data (M57/L02/...).
 * - "fixed": salePrice is a real number, use it directly.
 * - "individual": must be quoted per case (e.g. Kontejner) — salePrice stays undefined.
 * - "included": already covered by a package (e.g. P86 fascia graphics) — salePrice is 0
 *   and must never be charged again; see domain/technicalServices.ts includedInPackage.
 */
export type PricingEntryMode = "fixed" | "individual" | "included";

export type PricingEntry = Readonly<{
  id: string;
  itemId: string;
  exhibitionId?: string;
  realizationCompanyId?: string;
  priceListId?: string;
  currency: Currency;
  salePrice?: number;
  purchasePrice?: number;
  validFrom?: string;
  validTo?: string;
  priceMode?: PricingEntryMode;
}>;

export type ComponentDefinition = Readonly<{
  id: string;
  internalCode?: string;
  officialName?: string;
  /** Customer-facing catalog name. `name` remains the legacy compatibility field. */
  displayName?: string;
  type: string;
  name: string;
  category: string;
  description?: string;
  /** Canonical nominal CAD dimensions used by editor, snap and collision. */
  widthMm: number;
  depthMm: number;
  heightMm?: number;
  resizable: boolean;
  productionProfiles: ProductionProfiles;
  rotation: RotationPolicy;
  systemLocked: boolean;
  userLocked: boolean;
  visible: boolean;
  frontDirectionDeg?: number;
  sceneLabel: string;
  assets?: AssetReference;
  modelUrl?: string;
  /** R2-backed GLB reference (source of truth = storageKey), resolved to a signed URL the same way photoAsset/thumbnailAsset already are — see domain/catalog.ts's catalogModelAsset/catalogModelUrl and hooks/useAssetUrl. Coexists with the legacy modelUrl string; never inferred from geometry/material. */
  modelAsset?: StoredAsset;
  thumbnailUrl?: string;
  thumbnailAsset?: StoredAsset;
  photoUrl?: string;
  photoAsset?: StoredAsset;
  sketchupUrl?: string;
  /**
   * Generic source/manufacturing files (SKP authoring source, DWG/DXF/PDF production
   * documents, other) — see domain/assets.ts's SourceAssetEntry/SourceAssetKind and
   * domain/catalogReadiness.ts for which kinds are mandatory. Never a set of hardcoded
   * per-kind fields; adding a new file kind never needs a model change.
   */
  sourceAssets?: readonly SourceAssetEntry[];
  footprint2D?: Readonly<{
    shape: "rectangle" | "circle" | "symbol";
    symbol?: string;
  }>;
  showIn2D?: boolean;
  showIn3D?: boolean;
  sceneLayer?: SceneLayer;
  printable?: boolean;
  printWidthMm?: number;
  printHeightMm?: number;
  unit?: string;
  active?: boolean;
  pricingEntries?: readonly PricingEntry[];
  printSurfaces?: readonly PrintSurface[];
  partDefinitions?: readonly PartDefinition[];
  finishVariants?: readonly FinishVariant[];
  catalogItemType?: "physical" | "service";
  /** Explicit pricing unit — deliberately separate from the physical `unit` field, since
   * a service's charging unit (e.g. graphics "bm" vs "m²") can differ from how the item
   * would otherwise be measured. See domain/catalogReadiness.ts for which kinds require it. */
  pricingUnit?: "piece" | "square-meter" | "linear-meter" | "day" | "cubic-meter";
  vatRatePercent?: number;
  /** Absent = legacy seed item (e.g. M57), treated as active for backward compatibility. */
  lifecycleStatus?: CatalogItemStatus;
  catalogItemKind?: CatalogItemKind;
  /** Set once a human has reviewed/approved this item for activation. */
  reviewedAt?: string;
  /**
   * A type-booth line with several distinct variants (e.g. T04..T25 — one catalog_item per
   * line, four variants inside it) — see domain/catalogReadiness.ts for how this changes the
   * booth 3D-asset rule. Reuses BoothType's own BoothVariant shape rather than a second variant
   * type; absent/empty means "not a multi-variant line" (e.g. P86), never "4 unknown variants".
   */
  variants?: readonly BoothVariant[];
  /**
   * Whether `variants` represents real, human-confirmed catalog data (e.g. T04's 3 named
   * variants) rather than a generic placeholder scaffold (e.g. T06..T25's 4 "Varianta N" stubs
   * pending real construction data — see domain/typeBoothCanonicalization.ts's session decision
   * log, 2026-08-19). Absent/false means unconfirmed. See domain/catalogReadiness.ts's booth
   * case: a variants line can never become generatorEligible while this isn't strictly true,
   * however complete its variants' individual GLB/SKP assets happen to be.
   */
  variantsConfirmed?: boolean;
}>;

export type PlacedComponent = Notes & {
  id: string;
  definitionId: string;
  type: string;
  name: string;
  category: string;
  /** Instance CAD geometry; realization profiles never mutate these values. */
  widthMm: number;
  depthMm: number;
  heightMm?: number;
  resizable: boolean;
  productionProfiles: ProductionProfiles;
  xMm: number;
  yMm: number;
  rotationDeg: number;
  rotationMode: RotationControlMode;
  rotation: RotationPolicy;
  systemLocked: boolean;
  userLocked: boolean;
  visible: boolean;
  frontDirectionDeg?: number;
  sceneLabel: string;
  assets?: AssetReference;
  showIn2D: boolean;
  showIn3D: boolean;
  sceneLayer: SceneLayer;
  /** Editor-only 2D stacking metadata; never changes world geometry. */
  displayOrder2D?: number;
};

export type Placement = Readonly<{
  x: number;
  y: number;
  rotationDeg: number;
}>;
