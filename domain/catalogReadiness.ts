import {
  CATALOG_ITEM_STATUSES,
  type CatalogItemKind,
  type CatalogItemStatus,
  type ComponentDefinition,
} from "./models.ts";

export const CATALOG_ITEM_STATUS_LABELS_CS: Readonly<Record<CatalogItemStatus, string>> = {
  draft: "Koncept",
  needs_review: "K doplnění",
  active: "Aktivní",
  inactive: "Neaktivní",
  archived: "Archiv",
};

export type ReadinessIssue =
  | "missing_internal_code"
  | "missing_display_name"
  | "missing_category"
  | "missing_unit"
  | "missing_dimensions"
  | "missing_scene_capability"
  | "missing_2d_representation"
  | "missing_3d_asset"
  | "missing_pricing_unit"
  | "requires_review";

export const READINESS_ISSUE_LABELS_CS: Readonly<Record<ReadinessIssue, string>> = {
  missing_internal_code: "Chybí interní kód",
  missing_display_name: "Chybí zobrazovaný název",
  missing_category: "Chybí kategorie",
  missing_unit: "Chybí jednotka",
  missing_dimensions: "Chybí rozměry",
  missing_scene_capability: "Chybí nastavení zobrazení ve 2D/3D",
  missing_2d_representation: "Chybí platná 2D reprezentace",
  missing_3d_asset: "Chybí platný 3D model (GLB)",
  missing_pricing_unit: "Chybí typ jednotky pro cenotvorbu",
  requires_review: "Čeká na kontrolu/schválení",
};

export type ReadinessResult = Readonly<{
  ready: boolean;
  issues: readonly ReadinessIssue[];
}>;

function hasText(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0);
}

function hasDimensions(item: ComponentDefinition): boolean {
  return Number.isFinite(item.widthMm) && item.widthMm > 0 && Number.isFinite(item.depthMm) && item.depthMm > 0;
}

function has2DRepresentation(item: ComponentDefinition): boolean {
  return Boolean(item.footprint2D);
}

function has3DAsset(item: ComponentDefinition): boolean {
  return Boolean(item.modelUrl) || Boolean(item.assets?.models3d?.length);
}

/**
 * Readiness rules differ by item kind — a technical point never needs a GLB, a service
 * never needs 2D/3D at all. See section 7 of the catalog-readiness spec.
 *
 * Deliberately NOT checked here for service/graphics_service: a base sale price.
 * A service is a valid, activatable catalog item even with no fixed price — its price may
 * live entirely in Event → PriceList → PricingEntry (event-specific technical services),
 * be "individual" (e.g. Kontejner — quoted per case), or be "included" in a booth package
 * (e.g. P86 fascia graphics). Whether a *specific project/event* currently has a number to
 * charge is a separate, later concern — see domain/catalog.ts resolvePricingAvailability,
 * which returns "missing" / "individual" / "included" / "fixed" without ever touching
 * whether the CatalogItem itself is allowed to be active.
 */
export function evaluateCatalogReadiness(item: ComponentDefinition, kind: CatalogItemKind): ReadinessResult {
  const issues: ReadinessIssue[] = [];
  const displayName = item.displayName ?? item.name;

  if (!hasText(displayName)) issues.push("missing_display_name");
  if (!hasText(item.category)) issues.push("missing_category");

  switch (kind) {
    case "furniture": {
      if (!hasText(item.internalCode)) issues.push("missing_internal_code");
      if (!hasText(item.unit)) issues.push("missing_unit");
      if (!hasDimensions(item)) issues.push("missing_dimensions");
      if (!item.showIn2D && !item.showIn3D) issues.push("missing_scene_capability");
      if (item.showIn2D && !has2DRepresentation(item)) issues.push("missing_2d_representation");
      if (item.showIn3D && !has3DAsset(item)) issues.push("missing_3d_asset");
      if (!item.reviewedAt) issues.push("requires_review");
      break;
    }
    case "technical_point": {
      if (!item.showIn2D && !item.showIn3D) issues.push("missing_scene_capability");
      if (item.showIn2D && !has2DRepresentation(item)) issues.push("missing_2d_representation");
      if (item.showIn3D && !has3DAsset(item)) issues.push("missing_3d_asset");
      break;
    }
    case "service": {
      if (!hasText(item.unit)) issues.push("missing_unit");
      break;
    }
    case "graphics_service": {
      if (!item.pricingUnit) issues.push("missing_pricing_unit");
      break;
    }
    case "construction":
    case "floor_finish":
    case "other":
    default: {
      // Minimal generic requirement — kind-specific rules can be added as these
      // catalog areas mature; nothing else is safe to assume yet.
      break;
    }
  }

  return { ready: issues.length === 0, issues };
}

/**
 * Section 6: an item may exist in the DB without being selectable in the generator.
 * Undefined lifecycleStatus means the item predates this field (current seeds like
 * M57/L02/P86) and stays eligible, so nothing already shipped silently disappears.
 */
export function isGeneratorEligible(item: ComponentDefinition, kind?: CatalogItemKind): boolean {
  if (item.lifecycleStatus === undefined) return true;
  if (item.lifecycleStatus !== "active") return false;
  const resolvedKind = kind ?? item.catalogItemKind ?? inferCatalogItemKind(item);
  return evaluateCatalogReadiness(item, resolvedKind).ready;
}

export function inferCatalogItemKind(item: Pick<ComponentDefinition, "catalogItemType" | "sceneLayer" | "printable">): CatalogItemKind {
  if (item.catalogItemType === "service") {
    return item.printable ? "graphics_service" : "service";
  }
  if (item.sceneLayer && item.sceneLayer !== "furniture") return "technical_point";
  return "furniture";
}

export class CatalogReadinessError extends Error {
  readonly issues: readonly ReadinessIssue[];

  constructor(issues: readonly ReadinessIssue[]) {
    super(`Položku nelze aktivovat – chybí: ${issues.map((issue) => READINESS_ISSUE_LABELS_CS[issue]).join(", ")}.`);
    this.name = "CatalogReadinessError";
    this.issues = issues;
  }
}

/**
 * Section 9: activation must be enforced server-side too, not just hidden by the UI.
 * Call this before persisting a status transition into "active".
 */
export function assertCanActivate(item: ComponentDefinition, kind: CatalogItemKind): void {
  const result = evaluateCatalogReadiness(item, kind);
  if (!result.ready) throw new CatalogReadinessError(result.issues);
}

export function isValidCatalogItemStatus(value: string): value is CatalogItemStatus {
  return (CATALOG_ITEM_STATUSES as readonly string[]).includes(value);
}

export class DuplicateInternalCodeError extends Error {
  readonly internalCode: string;

  constructor(internalCode: string) {
    super(`Interní kód "${internalCode}" už je v katalogu použitý.`);
    this.name = "DuplicateInternalCodeError";
    this.internalCode = internalCode;
  }
}

/**
 * Mirrors the DB's partial unique index (catalog_items_internal_code_key — unique only
 * where internal_code is not null, see the init migration): a missing/null code is always
 * fine, but two non-null codes must never collide, case/whitespace-insensitively.
 */
export function assertUniqueInternalCode(existingItems: readonly Pick<ComponentDefinition, "internalCode">[], candidateCode: string | undefined): void {
  if (!candidateCode || !candidateCode.trim()) return;
  const normalized = candidateCode.trim().toLocaleUpperCase("cs");
  const collision = existingItems.some((item) => item.internalCode && item.internalCode.trim().toLocaleUpperCase("cs") === normalized);
  if (collision) throw new DuplicateInternalCodeError(candidateCode);
}
