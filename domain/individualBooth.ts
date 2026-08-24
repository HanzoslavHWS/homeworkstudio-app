/**
 * Individual mode never picks a catalog booth — it synthesizes an empty BoothType-shaped
 * scaffold (no constructionParts/collisionObstacles/variants/master GLB) so every existing
 * selectedBooth-driven read in components/BoothGenerator.tsx (viewport sizing, placement/
 * collision math for typovka's rectangle rules, save snapshot, ...) works for Individual for
 * free — no separate scene model, no second code path.
 *
 * IMPORTANT (polygon foundation): widthMm/depthMm here are the WORKSPACE canvas size (domain/
 * plot.ts's IndividualWorkspace — a 10×10 m drawing surface), NOT the real plot footprint. The
 * real, possibly non-rectangular plot is a PlotPolygon, carried as its own separate piece of
 * project state (ProjectRecord.individualPlotPolygon) and validated/rendered with dedicated
 * polygon-aware logic (domain/plot.ts's isAnchorInsidePlot, geometry/polygons.ts) — never through
 * BoothType's generic rectangle-based isPlacementValid/applySnap, which stays exactly as-is for
 * typovka. size/area below reflect the REAL plot polygon when one exists, not the workspace.
 */
import { pricingPolicyFor } from "./pricing.ts";
import { plotAreaSquareMeters, plotBoundsMm, type PlotPolygon } from "./plot.ts";
import type { BoothType } from "./models.ts";
import type { IndividualWorkspace } from "./plot.ts";

export const INDIVIDUAL_BOOTH_ID = "individual";

/**
 * heightMm/nominalDimensions are deliberately omitted (null/undefined) — the user never enters a
 * height in this foundation phase, and fabricating one would misrepresent real data. Downstream
 * reads that key off nominalDimensions (e.g. the 3D height-dimension overlay) already treat its
 * absence as "nothing to show", never a crash.
 */
export function createIndividualBooth(workspace: IndividualWorkspace, plotPolygon?: PlotPolygon): BoothType {
  const bounds = plotPolygon ? plotBoundsMm(plotPolygon) : undefined;
  const areaSquareMeters = plotPolygon ? plotAreaSquareMeters(plotPolygon) : undefined;
  return {
    id: INDIVIDUAL_BOOTH_ID,
    code: "INDIVIDUAL",
    name: "Individuální stánek",
    description: "Vlastní půdorys sestavený z komponent stánku.",
    projectType: "individualni",
    size: bounds
      ? `${((bounds.maxX - bounds.minX) / 1000).toFixed(2)} × ${((bounds.maxY - bounds.minY) / 1000).toFixed(2)} m`
      : `${workspace.widthMm / 1000} × ${workspace.depthMm / 1000} m (pracovní prostor)`,
    area: areaSquareMeters !== undefined ? `${areaSquareMeters.toFixed(2)} m²` : "—",
    widthMm: workspace.widthMm,
    depthMm: workspace.depthMm,
    heightMm: null,
    collarHeightMm: null,
    profileWidthMm: null,
    // No variant-selection step for Individual — configReady lets canOpenConfigurator proceed
    // straight to the configurator once a plot size has been entered, mirroring how a
    // variants-less typovka booth (P86) already skips the variant screen.
    configReady: true,
    systemLocked: false,
    userLocked: false,
    visible: true,
    variants: [],
    constructionParts: [],
    collisionObstacles: [],
    pricing: pricingPolicyFor("individualni"),
    category: "individualni",
  };
}
