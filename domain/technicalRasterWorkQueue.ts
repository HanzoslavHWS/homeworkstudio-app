/**
 * Technické rastry — placement WORK QUEUE (spec batch 8, "WORK QUEUE UX"). Pure, framework-free:
 * derives which MATCHED stands still need technical-service points placed vs. which are done,
 * purely from each stand's own services/placements — never a new persisted status field (spec
 * section 4: "pouze VIEW STATE odvozený z dat"). Scoped to already-matched (spárováno) stands only
 * — the caller (TechnicalStandBuffer.tsx) is expected to have already filtered those, mirroring
 * its own existing unassigned/ambiguous/assigned split; spárování itself is untouched by this file.
 *
 * "Hotovo" (spec section 5) means every "point" service on the stand has `placements.length >=
 * quantity` — informational/none services (WIFI, odpad, úklid regardless of its own quantity, e.g.
 * "Denní úklid" qty=40) never count toward this, exactly mirroring
 * domain/technicalRasterExport.ts's own totalPointCount discipline (kept as a SEPARATE function
 * here rather than reused, since that module's summary is project-wide/export-scoped while this
 * one is deliberately scoped to the matched-stand work queue only — spec section 10: "nad SEZNAMEM").
 */
import { effectiveServicePlacements, type TechnicalStand, type TechnicalService } from "./technicalRaster.ts";
import { resolveTechnicalServicePresentation } from "./technicalRasterServicePresentation.ts";

function isPointService(service: TechnicalService): boolean {
  return resolveTechnicalServicePresentation(service.category, service.externalLabel).placementBehavior === "point";
}

function needsMorePlacements(service: TechnicalService): boolean {
  return isPointService(service) && effectiveServicePlacements(service).length < service.quantity;
}

export type StandPlacementProgress = Readonly<{ placedCount: number; totalCount: number }>;

/** `totalCount` is 0 for a stand with no "point" services at all — see standHasPointServices below, which callers must check before treating 0/0 as "done" (it isn't — it's simply not applicable). */
export function computeStandPlacementProgress(stand: TechnicalStand): StandPlacementProgress {
  let placedCount = 0;
  let totalCount = 0;
  for (const service of stand.services) {
    if (!isPointService(service)) continue;
    totalCount += service.quantity;
    placedCount += Math.min(effectiveServicePlacements(service).length, service.quantity);
  }
  return { placedCount, totalCount };
}

export function standHasPointServices(stand: TechnicalStand): boolean {
  return stand.services.some(isPointService);
}

/** A stand with zero point services is never "complete" (spec section 5's definition only applies to stands that actually have point services) — see groupStandsByPlacementWorkQueue's separate "noPointServices" bucket for that case. */
export function isStandPlacementComplete(stand: TechnicalStand): boolean {
  if (!standHasPointServices(stand)) return false;
  const progress = computeStandPlacementProgress(stand);
  return progress.placedCount >= progress.totalCount;
}

export type TechnicalRasterWorkQueue = Readonly<{
  /** At least one point service still missing a placement (spec section 2: "alespoň jednu POINT službu s chybějícím placementem"). */
  toPlace: readonly TechnicalStand[];
  /** Every point service fully placed (spec section 5) — a VIEW bucket only, never a stored status; removing a placement (spec section 4) moves a stand back to toPlace purely because this function is recomputed from the live data. */
  done: readonly TechnicalStand[];
  /** No point services at all (e.g. only WIFI/odpad/úklid) — kept as its own bucket (spec section 1's optional third group) so such a stand is never simply invisible from both other buckets. */
  noPointServices: readonly TechnicalStand[];
}>;

export function groupStandsByPlacementWorkQueue(matchedStands: readonly TechnicalStand[]): TechnicalRasterWorkQueue {
  const toPlace: TechnicalStand[] = [];
  const done: TechnicalStand[] = [];
  const noPointServices: TechnicalStand[] = [];
  for (const stand of matchedStands) {
    if (!standHasPointServices(stand)) { noPointServices.push(stand); continue; }
    if (isStandPlacementComplete(stand)) done.push(stand); else toPlace.push(stand);
  }
  return { toPlace, done, noPointServices };
}

export type TechnicalRasterPlacementSummary = Readonly<{
  placedPointCount: number;
  totalPointCount: number;
  /** How many matched stands that actually HAVE point services are fully placed. */
  doneStandCount: number;
  /** How many matched stands actually have at least one point service (the denominator for doneStandCount) — a stand with none is never counted on either side. */
  standCountWithPointServices: number;
}>;

/** "Technické body N/M umístěno" + "Stánky N/M hotovo" (spec section 10) — derived entirely from `matchedStands`' own placements, never a redundant stored counter. */
export function computeTechnicalRasterPlacementSummary(matchedStands: readonly TechnicalStand[]): TechnicalRasterPlacementSummary {
  let placedPointCount = 0;
  let totalPointCount = 0;
  let doneStandCount = 0;
  let standCountWithPointServices = 0;
  for (const stand of matchedStands) {
    if (!standHasPointServices(stand)) continue;
    standCountWithPointServices += 1;
    const progress = computeStandPlacementProgress(stand);
    placedPointCount += progress.placedCount;
    totalPointCount += progress.totalCount;
    if (progress.placedCount >= progress.totalCount) doneStandCount += 1;
  }
  return { placedPointCount, totalPointCount, doneStandCount, standCountWithPointServices };
}

// ============================================================================
// Auto-advance (spec section 7/8/35) — a pure UX helper, never a new data model (section 9).
// ============================================================================

export type PlacementTarget = Readonly<{ serviceId: string }>;

/**
 * What the placement UI should do next (spec section 7): if `currentServiceId`'s own service still
 * needs another point, keep targeting it (qty>1 stays on the same service across clicks); else
 * find the NEXT point service on the stand that still needs a point, in the stand's own service
 * order; else undefined (every point service is done — spec section 7's "označ Hotovo"). Passing no
 * `currentServiceId` (or one that no longer needs placements) is exactly how "Umístit chybějící
 * postupně" (spec section 8) starts a sequence — it's the SAME resolution, just with no current
 * target yet.
 */
export function resolveNextPlacementTarget(stand: TechnicalStand, currentServiceId?: string): PlacementTarget | undefined {
  const current = currentServiceId ? stand.services.find((service) => service.id === currentServiceId) : undefined;
  if (current && needsMorePlacements(current)) return { serviceId: current.id };
  const next = stand.services.find((service) => needsMorePlacements(service));
  return next ? { serviceId: next.id } : undefined;
}
