/**
 * Technické rastry — component-driven presentation ADAPTER (spec batch 10 audit, spec batch 11
 * "CONFIG UI + ICON ASSETS" wires it into the real component admin card). See the batch 11 report
 * for the full picture; the short version:
 *
 *   - A catalog component (domain/models.ts's ComponentDefinition / the DB-backed
 *     domain/catalogItemsAdmin.ts's CatalogItemAdmin.document) has NO relationship today to a
 *     Technické rastry TechnicalService beyond the OPTIONAL internalProductId/internalProductCode
 *     domain/technicalServiceProductMapping.ts's resolveTechnicalServiceProduct sets — and that
 *     mapping table (DEFAULT_TECHNICAL_SERVICE_PRODUCT_MAPPING) is deliberately EMPTY today, so in
 *     practice every real service currently resolves "unresolved_product" ("Neznámý produkt").
 *     Nothing here changes that.
 *   - `resolveTechnicalRasterPresentation` is still never called from the real Technické rastry
 *     placement/render/export pipeline (that pipeline is explicitly protected this batch too — see
 *     lib/technicalRasterVectorPdf.ts, components/workflow/technicalRasters/*) — only from the NEW
 *     admin-card preview (components/workflow/ComponentAdminPage.tsx's own, separate preview
 *     renderer) and its own tests. Wiring it into the real pipeline is a distinct future step.
 */
import { resolveTechnicalServicePresentation, type TechnicalServicePlacementBehavior, type TechnicalServicePresentation, type TechnicalServiceSymbolRenderer } from "./technicalRasterServicePresentation.ts";
import type { StoredAsset } from "./assets.ts";

/** Runtime-checkable mirror of TechnicalServicePlacementBehavior (domain/technicalRasterServicePresentation.ts defines it as a plain type union, not a const array) — needed here so domain/catalogItemsAdmin.ts's edit whitelist can validate a raw request body's string value without importing anything from that protected central file beyond its types. */
export const TECHNICAL_SERVICE_PLACEMENT_BEHAVIORS = ["point", "informational", "none"] as const satisfies readonly TechnicalServicePlacementBehavior[];

/** Same reasoning as TECHNICAL_SERVICE_PLACEMENT_BEHAVIORS above, mirroring TechnicalServiceSymbolRenderer. */
export const TECHNICAL_SERVICE_SYMBOL_RENDERERS = ["powerLabel", "refrigeratedStar", "textLabel", "wifiIcon", "waterDrop", "fallback"] as const satisfies readonly TechnicalServiceSymbolRenderer[];

/**
 * The MINIMAL future "TECHNICKÉ RASTRY" section a catalog component's own document could carry.
 * Every field optional — a component with nothing configured (or `enabled: false`) behaves
 * EXACTLY as if this whole object were absent (never a half-filled/broken presentation).
 *
 * Naming deliberately mirrors THIS repo's own established conventions rather than a literal 1:1
 * translation of the spec's own draft interface:
 *   - `symbolType` -> `renderer` (matches TechnicalServicePresentation.renderer's own name)
 *   - `shortLabel` -> `displayLabel` (matches TechnicalServicePresentation.displayLabel)
 *   - `iconAssetId: string | null` -> `iconAsset?: StoredAsset` — EVERY other asset reference in
 *     this codebase (ComponentDefinition.photoAsset/modelAsset, SourceAssetEntry.asset,
 *     CatalogItemAdminEdit.photoAsset/modelAsset) is a full StoredAsset object, never a bare id
 *     string needing a second resolution step; matching that is more valuable than matching the
 *     spec's own literal sketch field-for-field (spec section 3 itself asked for "naming
 *     odpovídající současné architektuře repa").
 *
 * `renderer` is typed as the EXISTING closed TechnicalServiceSymbolRenderer union (spec section
 * 5's "obecnější model" — a generic, per-product-code-free renderer — is a real architectural
 * improvement worth making, e.g. a new `"icon"` case that draws an arbitrary uploaded SVG/PNG via
 * `iconAsset` with ONE shared drawing code path instead of one React component per product — but
 * that touches the actual editor SVG renderer AND the PDF export drawing code in
 * lib/technicalRasterVectorPdf.ts, which this batch was explicitly told not to change. Recommended
 * as the concrete next step, not implemented here.
 */
export type TechnicalRasterComponentConfig = Readonly<{
  /**
   * "Zobrazovat v technickém rastru" (spec batch 11 section 4) — `undefined` (config omitted, or
   * this one field left unset) means "no opinion, use the central default entirely". `true` means
   * "yes, participate" (other fields/central defaults decide how). `false` is an explicit,
   * deliberate suppression: the component is FORCED to `placementBehavior: "none"` regardless of
   * what the central config or any other field here would otherwise say — a real placement point
   * already stored for this service is NEVER deleted by this (spec: "nesmí to smazat již uložené
   * placement coordinates... pouze presentation/render behavior"), it simply stops being drawn.
   */
  enabled?: boolean;
  placementBehavior?: TechnicalServicePlacementBehavior;
  renderer?: TechnicalServiceSymbolRenderer;
  displayLabel?: string;
  /** A hex string, same shape as domain/technicalRasterServicePresentation.ts's TECHNICAL_RASTER_COLORS values — a future color-picker UI would write here, never a one-off literal validated differently from the central config's own colors. */
  color?: string;
  legendLabel?: string;
  iconAsset?: StoredAsset;
}>;

function hasAnyFieldOverride(config: TechnicalRasterComponentConfig): boolean {
  return (
    config.placementBehavior !== undefined ||
    config.renderer !== undefined ||
    config.displayLabel !== undefined ||
    config.color !== undefined ||
    config.legendLabel !== undefined
  );
}

/**
 * Precedence (spec batch 10 section 10): 1) `componentConfig`'s own explicit fields, 2)
 * domain/technicalRasterServicePresentation.ts's central defaults (per field, not all-or-nothing —
 * a component overriding only `color` still gets every other value from the central default), 3)
 * that module's own "?" fallback when the category/label is entirely unrecognized.
 *
 * BACKWARD COMPATIBILITY: calling this with `componentConfig` omitted (or `{}`, or
 * `{enabled:false}`) returns EXACTLY resolveTechnicalServicePresentation(...)'s own result — see
 * tests/technicalRasterComponentPresentation.test.ts's "no config" test, asserting deep equality,
 * not just similar shape.
 *
 * PLACEMENT COORDINATES ARE NEVER TOUCHED: this function's own signature has no placement
 * parameter and returns no placement data — it only ever resolves a PRESENTATION (color/renderer/
 * labels), never a TechnicalServicePlacement. An existing placement's stored x/y/page is
 * completely independent of whatever this function returns; changing a component's color later
 * changes what the SAME stored placement is drawn with NEXT time it renders/exports — never a
 * migration, never touching domain/technicalRaster.ts's placement data at all (spec section 11).
 */
export function resolveTechnicalRasterPresentation(
  service: Readonly<{ category: string; externalLabel: string }>,
  componentConfig?: TechnicalRasterComponentConfig,
): TechnicalServicePresentation {
  const central = resolveTechnicalServicePresentation(service.category, service.externalLabel);
  if (!componentConfig) return central;

  // Explicit suppression (spec batch 11 section 4) — forces "none", but every OTHER field still
  // resolves normally underneath it (color/labels stay meaningful for e.g. a disabled-state
  // preview in the admin UI; nothing is actually drawn either way once placementBehavior is "none").
  if (componentConfig.enabled === false) {
    return {
      placementBehavior: "none",
      renderer: componentConfig.renderer ?? central.renderer,
      displayLabel: componentConfig.displayLabel ?? central.displayLabel,
      color: componentConfig.color ?? central.color,
      legendLabel: componentConfig.legendLabel ?? central.legendLabel,
      isFallback: false,
    };
  }

  const overridden = hasAnyFieldOverride(componentConfig);
  return {
    placementBehavior: componentConfig.placementBehavior ?? central.placementBehavior,
    renderer: componentConfig.renderer ?? central.renderer,
    displayLabel: componentConfig.displayLabel ?? central.displayLabel,
    color: componentConfig.color ?? central.color,
    legendLabel: componentConfig.legendLabel ?? central.legendLabel,
    // An unknown category/label with zero actual overrides is still exactly the central fallback;
    // a component that deliberately configured at least one field is no longer "unresolved", even
    // for an otherwise-unrecognized category — it now has a real, intentional presentation.
    isFallback: central.isFallback && !overridden,
  };
}
