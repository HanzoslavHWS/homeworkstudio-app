import type { Point } from "./models.ts";

/**
 * World → 2D floor-plan screen-space transform (and its own inverse).
 *
 * Canonical world (never touched by this file): X = width, growing right; Y = depth, where
 * Y=0 is the booth's front/open side and Y=depthMm is the back wall.
 *
 * Desired 2D floor plan (QA spec): back wall at the TOP of the screen, front/open side at the
 * BOTTOM, and the booth's physical LEFT/RIGHT rendered at the screen's LEFT/RIGHT — i.e. an
 * object physically on the left must never appear on the right in the plan.
 *
 * X is left UNCHANGED. CSS/SVG/canvas `left`/x already grows rightward exactly like world X,
 * so there is nothing to correct there — a left/right swap was never a property of the X axis.
 *
 * Y is inverted (planY = depthMm − worldY) ONLY because CSS/SVG/canvas `top`/y grows DOWNWARD
 * while "back wall at the top" needs the LARGEST world Y (the back) to land at the SMALLEST
 * screen Y (the top). This is the same routine world-Y-away-vs-screen-Y-down conversion every
 * top-down 2D renderer needs — not a mirror of the world: X is never touched, so left stays
 * left and right stays right for every object, always.
 *
 * (History: an earlier version of this file flipped BOTH axes as one 180° rotation, reasoning
 * that "back wall at top" could only be achieved via a full proper rotation. That reasoning was
 * wrong — flipping only the screen Y axis is not a world mirror, it is a standard coordinate
 * convention change, and it is the ONLY option that also satisfies "world left = plan left",
 * which a full 180° rotation cannot do. See domain/cad3d.ts for the matching default 3D camera,
 * which already renders world+X on the right with no rotation needed.)
 *
 * Because only one axis is touched, this transform is its own inverse: applying it twice
 * returns the original point. The same function therefore serves as both the forward (render)
 * and inverse (pointer/drag) conversion — see planViewToWorld below.
 */
export function worldToPlanView(point: Point, widthMm: number, depthMm: number): Point {
  return { x: point.x, y: depthMm - point.y };
}

export function planViewToWorld(point: Point, widthMm: number, depthMm: number): Point {
  return worldToPlanView(point, widthMm, depthMm);
}

/**
 * World rotationDeg → CSS/canvas rotate() degrees for the SAME plan-view transform above.
 *
 * The canonical world-rotation formula (x'=x·cosθ−y·sinθ, y'=x·sinθ+y·cosθ — the exact formula
 * geometry/polygons.ts's getRotatedCorners uses for collision) is mathematically identical in
 * form to the CSS/canvas rotate() matrix, but CSS/canvas rotate() is applied in a Y-DOWN screen
 * space while the world formula treats Y as a plain coordinate axis. worldToPlanView above
 * flips only Y (not X) to go from world to screen — and flipping exactly one axis while
 * evaluating an otherwise-identical rotation formula reverses the apparent rotational sense.
 * Concretely: a local +X-offset marker rotated by world θ=+45° ends up at world (+X,+Y) — i.e.
 * physically toward the right AND the back. Through worldToPlanView that renders in the upper
 * right of a back-at-top plan, which is exactly what `rotate(-45deg)` (CSS rotates clockwise
 * for positive values, so −45° is 45° counter-clockwise, i.e. "right" rotated toward "up") also
 * produces for an icon whose own artwork points screen-right at 0°. Hence: plan rotation =
 * −rotationDeg, NOT the old `rotationDeg + 180` (which belonged to the retired full-180°
 * transform and would rotate an asymmetric object 180° away from where it actually is now that
 * X is no longer flipped).
 *
 * Self-inverse for the same reason as worldToPlanView: negating twice returns the original.
 */
export function worldRotationToPlanView(rotationDeg: number): number {
  return ((-rotationDeg % 360) + 360) % 360;
}

export function planRotationToWorld(planRotationDeg: number): number {
  return worldRotationToPlanView(planRotationDeg);
}
