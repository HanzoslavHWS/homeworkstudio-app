/**
 * Individual-mode floor zones (Step "PODLAHA / KRYTINA") — the rented plot polygon (domain/
 * plot.ts) is not necessarily fully covered by one uniform floor: e.g. a 20 m² plot might have a
 * 15 m² carpet zone and 5 m² left bare. Each zone is its OWN polygon, base, and finish — never a
 * single project-wide enum.
 */
import { findComponentAnchorsOutsidePlot, plotAreaSquareMeters, type PlotPolygon } from "./plot.ts";
import {
  isPointInOrOnPolygon,
  isPolygonFullyContainedIn,
  polygonsIntersectGeneral,
  validatePolygon,
  type PolygonValidationIssue,
  type PolygonValidationResult,
} from "../geometry/polygons.ts";
import { differencePolygon } from "../geometry/polygonBoolean.ts";

/**
 * Section 21: floor CONSTRUCTION (what physically sits on the raw exhibition-hall floor) is
 * independent of floor FINISH (the visible covering) — "raised" + "carpet"/"vinyl"/... and
 * "ground" + "carpet"/"none"/... are both real, valid combinations. Kept as two small,
 * independently-extensible unions rather than one hardcoded "raised-carpet"/"raised-vinyl"/...
 * enum, which could never cleanly add a new base or finish without renaming every existing value.
 */
export const FLOOR_ZONE_BASES = ["ground", "raised"] as const;
export type FloorZoneBase = (typeof FLOOR_ZONE_BASES)[number];

export const FLOOR_ZONE_BASE_LABELS_CS: Readonly<Record<FloorZoneBase, string>> = {
  ground: "Přímo na podlaze haly",
  raised: "Zvýšená podlaha / pódium",
};

export const FLOOR_ZONE_FINISHES = ["none", "carpet", "vinyl", "laminate", "other"] as const;
export type FloorZoneFinish = (typeof FLOOR_ZONE_FINISHES)[number];

export const FLOOR_ZONE_FINISH_LABELS_CS: Readonly<Record<FloorZoneFinish, string>> = {
  none: "Bez krytiny",
  carpet: "Koberec",
  vinyl: "Vinyl",
  laminate: "Laminát",
  other: "Jiná krytina",
};

/**
 * Section 8: EDIT vs CONFIRMED/LOCKED, mirroring the plot's own lock state (domain/plot.ts's
 * ProjectRecord.individualPlotStatus). Absent (undefined, on a zone saved by the pre-lock
 * foundation) means "draft" — see resolveFloorZoneStatus — so an OLD saved zone safely lands
 * back in an editable state rather than being silently treated as already-confirmed.
 */
export const FLOOR_ZONE_STATUSES = ["draft", "confirmed"] as const;
export type FloorZoneStatus = (typeof FLOOR_ZONE_STATUSES)[number];

export type FloorZone = Readonly<{
  id: string;
  polygon: PlotPolygon;
  base: FloorZoneBase;
  finish: FloorZoneFinish;
  /**
   * Minimal, deliberately free-text color/decor/variant descriptor (e.g. "Černý", "Dub") —
   * there is no DB-backed floor-material catalog yet (section 13), so this is NOT a fake
   * production SKU/enum, just a small extensible metadata field a human can fill in. `label`
   * below stays the zone's own purpose/identity (e.g. "Recepce"), independent of this.
   */
  colorLabel?: string;
  /**
   * Report section 20: the recommended long-term reference — a FinishVariant.id (domain/
   * models.ts's EXISTING id/code/name/swatchColor/textureUrl/active/pricing shape, the same one
   * BoothType.carpetVariants/finishVariants already use for typovka) once a real floor-material
   * variant list exists (e.g. a `floorMaterialVariants` catalog reusing FinishVariant, or a
   * DB-backed swatch admin — see the report's recommended next step). Never populated by this
   * session (no fake production swatches) — colorLabel remains the backward-compatible free-text
   * fallback for as long as no such catalog exists; a UI that DOES resolve a real variant should
   * prefer this field over colorLabel when both are present.
   */
  materialVariantId?: string;
  label?: string;
  status?: FloorZoneStatus;
}>;

export function createFloorZone(input: {
  id: string;
  polygon: PlotPolygon;
  base?: FloorZoneBase;
  finish?: FloorZoneFinish;
  colorLabel?: string;
  materialVariantId?: string;
  label?: string;
  status?: FloorZoneStatus;
}): FloorZone {
  return {
    id: input.id,
    polygon: input.polygon,
    base: input.base ?? "ground",
    finish: input.finish ?? "none",
    // Omit optional keys entirely when unset (never an explicit `label: undefined`) — JSON.
    // stringify already drops them either way, but keeping the in-memory shape and the
    // persisted/round-tripped shape identical avoids a value that looks different from itself
    // after a save/load.
    ...(input.colorLabel !== undefined ? { colorLabel: input.colorLabel } : {}),
    ...(input.materialVariantId !== undefined ? { materialVariantId: input.materialVariantId } : {}),
    ...(input.label !== undefined ? { label: input.label } : {}),
    status: input.status ?? "draft",
  };
}

/** Absent status (a zone saved before locking existed) resolves to "draft" — never silently treated as already-confirmed/reserved. */
export function resolveFloorZoneStatus(zone: Pick<FloorZone, "status">): FloorZoneStatus {
  return zone.status ?? "draft";
}

export function isFloorZoneConfirmed(zone: Pick<FloorZone, "status">): boolean {
  return resolveFloorZoneStatus(zone) === "confirmed";
}

export function confirmFloorZone(zone: FloorZone): FloorZone {
  return { ...zone, status: "confirmed" };
}

export function unlockFloorZone(zone: FloorZone): FloorZone {
  return { ...zone, status: "draft" };
}

export function floorZoneAreaSquareMeters(zone: Pick<FloorZone, "polygon">): number {
  return plotAreaSquareMeters(zone.polygon);
}

/** Section 14/23: per-finish floor area for whatever zone list the caller passes in — deliberately status-agnostic (the caller decides whether "confirmed only" or "all zones" is the right total for a given summary; see uncoveredFloorAreaSquareMeters for the one place status DOES matter). */
export function totalFloorAreaByFinish(zones: readonly FloorZone[]): Readonly<Record<FloorZoneFinish, number>> {
  const totals = Object.fromEntries(FLOOR_ZONE_FINISHES.map((finish) => [finish, 0])) as Record<FloorZoneFinish, number>;
  for (const zone of zones) {
    totals[zone.finish] += floorZoneAreaSquareMeters(zone);
  }
  return totals;
}

/**
 * Section 6/9: "bez krytiny" is never a stored polygon — it's simply booth-plot area minus the
 * CONFIRMED zones' area. Confirmed zones can never overlap each other (enforced at confirm time
 * by validateFloorZoneForConfirm below), so a plain area subtraction is exact — no polygon
 * union/clipping needed. Draft (not-yet-confirmed) zones deliberately do NOT reduce this number:
 * they aren't reserved/committed yet, so the "bez krytiny" total only ever reflects what's
 * actually locked in, staying consistent with the confirmed-zone breakdown from
 * totalFloorAreaByFinish(zones.filter(isFloorZoneConfirmed)).
 */
/**
 * Report sections 16-18: "Vyplnit volnou plochu" — the real remaining area a NEW/draft zone may
 * still use: `plot MINUS union(other CONFIRMED zones)`, via geometry/polygonBoolean.ts's robust
 * difference (never a hand-rolled clip). May return MORE THAN ONE region (e.g. a confirmed zone
 * splitting the leftover area into two separate pieces) — this app's FloorZone is a single simple
 * polygon (no MultiPolygon support, per the report's decision), so the caller (BoothGenerator.tsx)
 * uses the LARGEST returned region as the new zone's polygon and, if there is more than one
 * region, surfaces that the fill was partial rather than silently dropping the smaller piece(s) —
 * see the report for the full A/B/C tradeoff and why "largest region" was chosen over inventing a
 * fake connecting edge between disconnected pieces.
 */
export function freeFloorAreaRegions(plot: PlotPolygon, otherZones: readonly FloorZone[]): readonly PlotPolygon[] {
  const confirmedOthers = otherZones.filter(isFloorZoneConfirmed).map((zone) => zone.polygon);
  return differencePolygon(plot, confirmedOthers);
}

export function uncoveredFloorAreaSquareMeters(plot: PlotPolygon, zones: readonly FloorZone[]): number {
  const confirmedArea = zones.filter(isFloorZoneConfirmed).reduce((sum, zone) => sum + floorZoneAreaSquareMeters(zone), 0);
  return Math.max(0, plotAreaSquareMeters(plot) - confirmedArea);
}

export function validateFloorZonePolygon(polygon: PlotPolygon): PolygonValidationResult {
  return validatePolygon(polygon);
}

export type FloorZoneConfirmIssue = "invalid_polygon" | PolygonValidationIssue | "outside_plot" | "overlaps_confirmed_zone";

export const FLOOR_ZONE_CONFIRM_ISSUE_LABELS_CS: Readonly<Record<FloorZoneConfirmIssue, string>> = {
  invalid_polygon: "Hranice zóny není platná.",
  too_few_points: "Potřeba alespoň 3 body.",
  duplicate_points: "Dva body mají stejnou pozici.",
  zero_length_edge: "Hrana s nulovou délkou.",
  self_intersecting: "Hranice se sama protíná.",
  outside_plot: "Zóna leží (částečně) mimo potvrzenou plochu stánku.",
  overlaps_confirmed_zone: "Zóna se překrývá s jinou potvrzenou zónou.",
};

export type FloorZoneConfirmResult = Readonly<{ valid: boolean; issues: readonly FloorZoneConfirmIssue[] }>;

/**
 * Section 9/11: HARD validation for confirming a (new or re-edited) zone — never "save now, warn
 * later". A zone can only be confirmed when its polygon is valid, lies ENTIRELY inside the plot
 * (isPolygonFullyContainedIn — touching the plot's own boundary is fine, poking through it is
 * not), and does not overlap (real shared area, not just a touching edge — polygonsIntersectGeneral)
 * any OTHER zone that is ALREADY confirmed. A draft zone never blocks another draft zone (only one
 * zone is ever actively edited at a time in this UI) — only confirmed zones form the reserved set.
 */
export function validateFloorZoneForConfirm(
  zone: Pick<FloorZone, "id" | "polygon">,
  plot: PlotPolygon,
  otherZones: readonly FloorZone[],
): FloorZoneConfirmResult {
  const polygonResult = validatePolygon(zone.polygon);
  if (!polygonResult.valid) {
    return { valid: false, issues: polygonResult.issues };
  }

  const issues: FloorZoneConfirmIssue[] = [];
  if (!isPolygonFullyContainedIn(zone.polygon, plot)) issues.push("outside_plot");

  const confirmedOthers = otherZones.filter((other) => other.id !== zone.id && isFloorZoneConfirmed(other));
  if (confirmedOthers.some((other) => polygonsIntersectGeneral(zone.polygon, other.polygon))) {
    issues.push("overlaps_confirmed_zone");
  }

  return { valid: issues.length === 0, issues };
}

/** Section 30/31: a zone with ANY vertex outside the current plot boundary — e.g. after the plot polygon was edited smaller. Never auto-clipped/auto-deleted; the caller surfaces this as a conflict for the user to resolve. Deliberately unaffected by lock status — this is the "parent plot changed later" conflict path, distinct from validateFloorZoneForConfirm's own-edit hard validation (section 11/12). */
export function findFloorZonesOutsidePlot(zones: readonly FloorZone[], plot: PlotPolygon): readonly string[] {
  return zones
    .filter((zone) => !zone.polygon.every((vertex) => isPointInOrOnPolygon(vertex, plot)))
    .map((zone) => zone.id);
}

/** Section 22: pairwise floor-zone overlap — flagged as a conflict, never silently resolved/clipped. Returns each conflicting PAIR once (id order matches input order). Kept status-agnostic (unlike validateFloorZoneForConfirm) since this is the general "something's wrong somewhere" conflict scan used for the tab warning badge, not a specific confirm gate. */
export function findOverlappingFloorZonePairs(zones: readonly FloorZone[]): readonly (readonly [string, string])[] {
  const conflicts: (readonly [string, string])[] = [];
  for (let i = 0; i < zones.length; i += 1) {
    for (let j = i + 1; j < zones.length; j += 1) {
      if (polygonsIntersectGeneral(zones[i]!.polygon, zones[j]!.polygon)) {
        conflicts.push([zones[i]!.id, zones[j]!.id]);
      }
    }
  }
  return conflicts;
}

/** Re-exported for callers that already have plain {id,x,y} anchors and want the exact same "outside plot" semantics as booth_component placement (domain/plot.ts) — never a second, subtly different rule for floor zones vs. components. */
export const findAnchorsOutsidePlot = findComponentAnchorsOutsidePlot;
