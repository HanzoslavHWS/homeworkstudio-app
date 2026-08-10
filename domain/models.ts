export type ProjectType = "typovy" | "individualni";
export type Currency = "CZK" | "EUR";
export type RotationControlMode = "free" | "snap";
export type PlanViewType = "ground" | "overhead";
export type PlanRenderStyle2D = "solid" | "dashed" | "hatched";

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
}>;

export type AssetReference = Readonly<{
  /** Stable external identifier used when the placeholder is replaced 1:1. */
  sourceId: string;
  revision?: string;
  cad2dUrl?: string;
  model3dUrl?: string;
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
}>;

export type ComponentDefinition = Readonly<{
  id: string;
  type: string;
  name: string;
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
}>;

export type PlacedComponent = Notes & {
  id: string;
  definitionId: string;
  type: string;
  name: string;
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
};

export type Placement = Readonly<{
  x: number;
  y: number;
  rotationDeg: number;
}>;
