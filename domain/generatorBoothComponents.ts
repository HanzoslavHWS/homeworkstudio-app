/**
 * Individual-booth component picker — DB catalog_items (kind=booth_component) as the single
 * source of truth for step 3 of the "Individuální stánek" workflow. Mirrors domain/
 * generatorBooths.ts's own booth picker exactly: same repository call, same readiness/
 * eligibility rules (domain/catalogReadiness.ts), same "active + ready + generatorEligible"
 * gate — never a parallel/looser filter, never a second catalog.
 */
import {
  computeGeneratorEligibleLive,
  computeReadiness,
  documentDimensions,
  sortCatalogItemsAdminByName,
  type CatalogItemAdmin,
  type CatalogItemAdminDocument,
} from "./catalogItemsAdmin.ts";
import type { ComponentDefinition, RotationPolicy } from "./models.ts";

/**
 * Default rotation policy applied ONLY when the catalog document itself declares none — never
 * overrides a real one. 45°-step snap (never free rotation): the real Octanorm construction
 * principle this foundation is built for — a reference sloupek's ~40×40 mm footprint has 8
 * radial connection grooves/directions around its axis (0/45/90/135/180/225/270/315°), so
 * booth_component's own default must match that, not furniture's coarser 90° default (see
 * domain/floorZones.ts-adjacent domain/plot.ts's PLOT_ANGLE_SNAP_DEG, the same 45° convention
 * used for drawing the plot polygon itself). Furniture is untouched by this — it keeps whatever
 * rotation policy data/components.ts already declares per item.
 */
const DEFAULT_BOOTH_COMPONENT_ROTATION: RotationPolicy = {
  defaultMode: "snap",
  snapStep: 45,
  quickAngles: [0, 45, 90, 135, 180, 225, 270, 315],
  allowFreeRotation: false,
  locked: false,
};

/**
 * Production-selectable = active AND ready AND generatorEligible, computed live via the exact
 * same domain rules the admin UI and the booth picker already trust (never a stored/cached flag,
 * never a second rule). archived/needs_review/draft/inactive are excluded by construction.
 */
export function isProductionReadyBoothComponent(
  item: Pick<CatalogItemAdmin, "kind" | "lifecycleStatus" | "document">,
): boolean {
  return item.lifecycleStatus === "active" && computeReadiness(item).ready && computeGeneratorEligibleLive(item);
}

/**
 * Whether a production-ready booth_component ALSO carries a real placeable footprint. Readiness
 * itself (domain/catalogReadiness.ts's booth_component case) deliberately never requires
 * widthMm/depthMm for this kind — some construction elements (límec/rastr) have no meaningful
 * single footprint. This is a SEPARATE, additive gate for the placement picker only: a component
 * with no real dimensions is a valid catalog entry without yet being placeable on the 2D/3D grid
 * (basic assembly needs a real footprint for collision/snap math) — excluded, never fabricated.
 */
export function isPlaceableBoothComponent(document: CatalogItemAdminDocument): boolean {
  return documentDimensions(document).hasDimensions;
}

/**
 * Adapts ONE production-ready, placeable catalog_items row into the ComponentDefinition shape
 * the existing scene/placement code (data/components.ts's placeComponent, geometry/placement.ts)
 * already consumes — no new scene model. Never fabricates physical/business data (widthMm/
 * depthMm/assets/pricing come straight from the document); only fills in STRUCTURAL/UI-state
 * fields this kind's readiness rule never required in the first place (rotation policy,
 * systemLocked/userLocked/visible, sceneLabel) — same "structural default, never a price/
 * dimension" spirit as domain/generatorBooths.ts's adaptCatalogItemToBoothType.
 */
export function adaptCatalogItemToComponentDefinition(item: CatalogItemAdmin): ComponentDefinition {
  const document = item.document as unknown as ComponentDefinition;
  return {
    ...document,
    id: item.id,
    internalCode: item.internalCode ?? undefined,
    displayName: item.displayName,
    name: item.displayName,
    category: item.category ?? "",
    lifecycleStatus: item.lifecycleStatus,
    catalogItemKind: item.kind,
    resizable: document.resizable ?? false,
    productionProfiles: document.productionProfiles ?? {},
    rotation: document.rotation ?? DEFAULT_BOOTH_COMPONENT_ROTATION,
    systemLocked: document.systemLocked ?? false,
    userLocked: document.userLocked ?? false,
    visible: document.visible ?? true,
    sceneLabel: document.sceneLabel ?? item.displayName,
    showIn2D: document.showIn2D ?? true,
    showIn3D: document.showIn3D ?? true,
    // "booth" — the physical booth-structure scene layer (domain/models.ts's SceneLayer), kept
    // separate from "furniture" so Phase 1 (construction) and the future Phase 2 (furniture)
    // never mix in the editor/scene tree/export. Never overrides an explicit document value.
    sceneLayer: document.sceneLayer ?? "booth",
  };
}

/**
 * Filters to kind=booth_component + production-ready + placeable, sorts deterministically (same
 * alphabetical-by-displayName convention as "Administrace → Komponenty" — see
 * sortCatalogItemsAdminByName's own doc comment, which names this exact picker), then adapts.
 * Filter happens BEFORE sort/adapt, matching selectGeneratorBooths' own "filter first" convention.
 */
export function selectGeneratorBoothComponents(items: readonly CatalogItemAdmin[]): readonly ComponentDefinition[] {
  const eligible = items.filter(
    (item) =>
      item.kind === "booth_component" &&
      isProductionReadyBoothComponent(item) &&
      isPlaceableBoothComponent(item.document),
  );
  return sortCatalogItemsAdminByName(eligible).map(adaptCatalogItemToComponentDefinition);
}
