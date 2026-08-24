/**
 * Thin adapter around the `polygon-clipping` npm package (MIT, pure JS, no native deps, no
 * transitive dependencies of its own) — the one place this app performs real polygon boolean
 * operations (union/difference). Added for Turn 5's rectangle-primitive union ("Sloučit do plochy
 * stánku") and floor-zone "Vyplnit volnou plochu" — deliberately NOT a hand-rolled clipping engine;
 * robust polygon boolean ops (self-intersection, shared-edge, floating-point edge cases) are
 * exactly the kind of thing not worth re-implementing ad-hoc.
 *
 * This app's own polygons (geometry/polygons.ts's `readonly Point[]`) are always a SINGLE ring,
 * no holes — this adapter only ever reads/returns the OUTER ring of each result polygon. A
 * boolean op that happens to produce a hole (a contrived input for this app's real use cases —
 * e.g. a "frame" of primitives fully enclosing empty space) has that hole silently dropped; this
 * is a documented, acceptable simplification for the current scope, never a silently-wrong shape
 * merge (the caller still gets a real, valid simple polygon back, just without the hole).
 */
import * as polygonClippingNs from "polygon-clipping";
import type { Point } from "../domain/models.ts";

/**
 * The package is CJS (`module.exports = {union, intersection, xor, difference}`, no per-name
 * `exports.foo = ...` a bundler's static analysis could pick up). Next.js's bundler resolves
 * `import * as ns` to the flat `{union, ...}` shape directly; this project's OTHER runtime —
 * `node --test`'s native TS/ESM loader — instead only exposes those functions under `ns.default`
 * (Node's CJS/ESM interop shim, since polygon-clipping isn't marked `__esModule`). Unwrapping
 * `.default` when present (falling back to the namespace itself otherwise) works correctly under
 * both.
 */
const polygonClipping = ((polygonClippingNs as unknown as { default?: typeof polygonClippingNs }).default ?? polygonClippingNs);

type SimplePolygon = readonly Point[];

/** Floating-point cleanup only (0.01mm) — never a grid/snap decision, which stays the caller's job. */
function cleanupPoint(pair: readonly [number, number]): Point {
  return { x: Math.round(pair[0] * 100) / 100, y: Math.round(pair[1] * 100) / 100 };
}

function toRing(points: SimplePolygon): polygonClippingNs.Ring {
  return points.map((point) => [point.x, point.y] as [number, number]);
}

function toPolygon(points: SimplePolygon): polygonClippingNs.Polygon {
  return [toRing(points)];
}

/**
 * Live QA finding (Turn 5 report section 48): polygon-clipping returns EXPLICITLY closed rings
 * (the first point repeated as the last) — this app's own polygon convention is IMPLICITLY closed
 * (see domain/plot.ts's PlotPolygon doc comment: "the edge back to the first vertex is
 * implicit"). Left unconverted, every merge/fill-free-area result carried a trailing zero-length
 * edge back to its own start point — invisible to area math (shoelace treats a zero-length edge
 * as a zero contribution, so areas came out correct) but a hard failure under validatePolygon
 * (exactly the "Hrana s nulovou délkou" banner seen live for two exactly-overlapping primitives).
 * Also collapses any OTHER consecutive duplicate that the 0.01mm cleanup rounding can create.
 */
function dropClosingDuplicate(ring: readonly Point[]): Point[] {
  const deduped: Point[] = [];
  for (const point of ring) {
    const previous = deduped[deduped.length - 1];
    if (!previous || previous.x !== point.x || previous.y !== point.y) deduped.push(point);
  }
  if (deduped.length > 1) {
    const first = deduped[0]!;
    const last = deduped[deduped.length - 1]!;
    if (first.x === last.x && first.y === last.y) deduped.pop();
  }
  return deduped;
}

/** Outer ring of each region in the result MultiPolygon — see file doc comment re: dropped holes. */
function outerRingsFrom(multiPolygon: polygonClippingNs.MultiPolygon): Point[][] {
  return multiPolygon.map((polygon) => dropClosingDuplicate(polygon[0]!.map(cleanupPoint)));
}

/**
 * Unions any number of simple polygons. Returns one region per element of the result array — a
 * caller that requires the input polygons to form a single connected shape (e.g. "merge these
 * rectangle primitives into ONE booth polygon") must check `.length === 1` itself; this function
 * never silently picks/merges disconnected regions.
 */
export function unionPolygons(polygons: readonly SimplePolygon[]): Point[][] {
  if (polygons.length === 0) return [];
  const [first, ...rest] = polygons;
  return outerRingsFrom(polygonClipping.union(toPolygon(first!), ...rest.map(toPolygon)));
}

/**
 * `subject` minus the union of `subtract` — used for "Vyplnit volnou plochu" (booth polygon minus
 * already-confirmed floor zones). May return more than one disconnected region (e.g. a confirmed
 * zone splitting the remaining plot area into two separate leftover pieces) — the caller decides
 * how to present that (see domain/floorZones.ts's freeFloorAreaRegions).
 */
export function differencePolygon(subject: SimplePolygon, subtract: readonly SimplePolygon[]): Point[][] {
  if (subtract.length === 0) return [subject.map((point) => ({ x: point.x, y: point.y }))];
  return outerRingsFrom(polygonClipping.difference(toPolygon(subject), ...subtract.map(toPolygon)));
}
