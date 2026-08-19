import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import {
  planRotationToWorld,
  planViewToWorld,
  worldRotationToPlanView,
  worldToPlanView,
} from "../domain/planView.ts";
import { cadPointToViewer } from "../domain/cad3d.ts";

const W = 2000;
const D = 2000;

// =========================================================================================
// PART A — 2D plan-view convention: back wall at top, front/open edge at bottom, world
// left = plan left, world right = plan right (QA spec, part 2/40).
// =========================================================================================

test("back wall (Y=depthMm) renders at the TOP of the plan (smallest screen/top value)", () => {
  const back = worldToPlanView({ x: 1000, y: D }, W, D);
  assert.equal(back.y, 0);
});

test("front/open edge (Y=0) renders at the BOTTOM of the plan (largest screen/top value)", () => {
  const front = worldToPlanView({ x: 1000, y: 0 }, W, D);
  assert.equal(front.y, D);
});

test("world X is never flipped — plan screen-X equals world X exactly, for every point", () => {
  for (const x of [0, 1, 300, 1000, 1700, W]) {
    assert.equal(worldToPlanView({ x, y: 500 }, W, D).x, x);
  }
});

test("world LEFT stays plan LEFT and world RIGHT stays plan RIGHT — an object further left in world space is never rendered further right in the plan", () => {
  const physicallyLeft = worldToPlanView({ x: 200, y: 900 }, W, D);
  const physicallyRight = worldToPlanView({ x: 1800, y: 900 }, W, D);
  assert.ok(physicallyLeft.x < physicallyRight.x, "left object must have a smaller plan screen-X than the right object");
});

// =========================================================================================
// PART B — forward/inverse round-trip (position + rotation), self-inverse property.
// =========================================================================================

test("world -> plan -> world round-trips exactly for arbitrary points", () => {
  const points = [{ x: 0, y: 0 }, { x: W, y: D }, { x: 300, y: 1600 }, { x: 1234.5, y: 88 }];
  for (const point of points) {
    const plan = worldToPlanView(point, W, D);
    assert.deepEqual(planViewToWorld(plan, W, D), point);
  }
});

test("worldToPlanView/planViewToWorld never mutate their input point", () => {
  const point = Object.freeze({ x: 300, y: 1600 });
  worldToPlanView(point, W, D);
  planViewToWorld(point, W, D);
  assert.deepEqual(point, { x: 300, y: 1600 });
});

test("worldRotationToPlanView/planRotationToWorld round-trip exactly for every angle", () => {
  for (const deg of [0, 30, 45, 90, 135, 180, 225, 270, 315, 359]) {
    const plan = worldRotationToPlanView(deg);
    assert.ok(Math.abs(planRotationToWorld(plan) - deg) < 1e-9 || Math.abs(planRotationToWorld(plan) - deg + 360) < 1e-9);
  }
});

test("worldRotationToPlanView is NOT the old rotationDeg+180 formula — it negates (mod 360), matching the X-preserving position transform", () => {
  assert.equal(worldRotationToPlanView(0), 0);
  assert.equal(worldRotationToPlanView(90), 270);
  assert.equal(worldRotationToPlanView(45), 315);
  assert.equal(worldRotationToPlanView(180), 180);
  assert.equal(worldRotationToPlanView(270), 90);
});

// =========================================================================================
// PART C — pointer/drag inverse conversion: dragging left->right on screen must move the
// object in the correct WORLD direction (no accidental sign flip in the inverse), and this
// must hold consistently for BoothGenerator.tsx's actual pointer-handling code paths.
// =========================================================================================

test("dragging a screen point left-to-right increases world X (no flip); dragging toward the top of the screen increases world Y (toward the back)", () => {
  const startScreen = { x: 300, y: 1200 };
  const endScreenRight = { x: 1700, y: 1200 };
  const endScreenUp = { x: 300, y: 200 };

  const startWorld = planViewToWorld(startScreen, W, D);
  const afterDragRight = planViewToWorld(endScreenRight, W, D);
  const afterDragUp = planViewToWorld(endScreenUp, W, D);

  assert.ok(afterDragRight.x > startWorld.x, "dragging right on screen must increase world X");
  assert.equal(afterDragRight.y, startWorld.y, "a purely horizontal drag must never change world Y");
  assert.ok(afterDragUp.y > startWorld.y, "dragging toward the top of the screen must increase world Y (move toward the back)");
  assert.equal(afterDragUp.x, startWorld.x, "a purely vertical drag must never change world X");
});

test("BoothGenerator.tsx's pointer/drag paths use the renamed planViewToWorld/worldToPlanView consistently — no leftover old-name call or a stale, differently-signed inverse", () => {
  const source = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /planView180ToWorld|worldToPlanView180|worldRotationToPlanView180/u, "no call site may still reference the retired 180°-rotation transform");
  assert.match(source, /planViewToWorld\(/u);
  assert.match(source, /worldToPlanView\(/u);
  assert.match(source, /worldRotationToPlanView\(/u);
  // pointFromPlanPointer (used by measurement/annotation click+drag) must convert display -> world via the shared inverse, not a hand-rolled formula.
  const pointerFn = source.match(/function pointFromPlanPointer\([\s\S]{0,900}?\n {2}\}/u);
  assert.ok(pointerFn, "expected to find pointFromPlanPointer");
  assert.match(pointerFn![0], /planViewToWorld\(/u);
  // handleComponentPointerMove (component drag) must also go through the same inverse.
  const dragFn = source.match(/function handleComponentPointerMove\([\s\S]{0,700}?planViewToWorld\(/u);
  assert.ok(dragFn, "expected handleComponentPointerMove to convert its display pointer via planViewToWorld");
});

test("lib/planExport.ts (PNG/print export) uses the same renamed transform, never the retired 180° one", () => {
  const source = readFileSync(new URL("../lib/planExport.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /worldToPlanView180|worldRotationToPlanView180/u);
  assert.match(source, /worldToPlanView\(/u);
  assert.match(source, /worldRotationToPlanView\(/u);
});

// =========================================================================================
// PART D — rotation consistency across ALL THREE representations (canonical world formula,
// 2D plan rotate() angle, 3D Three.js rotation.y) for a battery of angles. An asymmetric
// object's rotation must look the same physical direction everywhere.
// =========================================================================================

/** Ground truth world-space rotation — identical to geometry/polygons.ts's getRotatedCorners, applied to a single local offset. */
function rotateWorld(local: { x: number; y: number }, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return {
    x: local.x * Math.cos(rad) - local.y * Math.sin(rad),
    y: local.x * Math.sin(rad) + local.y * Math.cos(rad),
  };
}

/** Applies a CSS/canvas rotate(deg) matrix to a local screen offset — the exact matrix both `transform: rotate()` and CanvasRenderingContext2D.rotate() use. */
function rotateScreen(local: { x: number; y: number }, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return {
    x: local.x * Math.cos(rad) - local.y * Math.sin(rad),
    y: local.x * Math.sin(rad) + local.y * Math.cos(rad),
  };
}

test("rotations 0/30/45/90/135/180/225/270/315 stay physically consistent between the world formula (via worldToPlanView) and CSS rotate(worldRotationToPlanView(deg)) applied to the icon's own reference offset", () => {
  const localOffset = { x: 100, y: 0 }; // icon's own artwork points screen-right at rotationDeg=0
  for (const deg of [0, 30, 45, 90, 135, 180, 225, 270, 315]) {
    // Path 1: rotate in WORLD space, then convert the absolute delta to screen space via worldToPlanView.
    const worldRotated = rotateWorld(localOffset, deg);
    const originScreen = worldToPlanView({ x: 1000, y: 1000 }, W, D);
    const rotatedScreen = worldToPlanView({ x: 1000 + worldRotated.x, y: 1000 + worldRotated.y }, W, D);
    const screenDeltaViaWorld = { x: rotatedScreen.x - originScreen.x, y: rotatedScreen.y - originScreen.y };

    // Path 2: apply CSS rotate(worldRotationToPlanView(deg)) directly to the reference screen offset.
    // The reference offset itself must ALSO be expressed in screen terms: a world +X/+Y-pointing
    // local offset maps to screen (dx, -dy) under worldToPlanView (Y flips, X doesn't).
    const referenceScreenOffset = { x: localOffset.x, y: -localOffset.y };
    const screenDeltaViaCss = rotateScreen(referenceScreenOffset, worldRotationToPlanView(deg));

    assert.ok(Math.abs(screenDeltaViaWorld.x - screenDeltaViaCss.x) < 1e-9, `x mismatch at ${deg}°: viaWorld=${screenDeltaViaWorld.x} viaCss=${screenDeltaViaCss.x}`);
    assert.ok(Math.abs(screenDeltaViaWorld.y - screenDeltaViaCss.y) < 1e-9, `y mismatch at ${deg}°: viaWorld=${screenDeltaViaWorld.y} viaCss=${screenDeltaViaCss.y}`);
  }
});

test("rotations stay consistent with the REAL Three.js engine's rotation.y too — a local +X marker rotated by world θ ends up at the same canonical (x,y) whether computed via the world formula or via a real THREE.Object3D rotation.y, for every tested angle", () => {
  for (const deg of [0, 30, 45, 90, 135, 180, 225, 270, 315]) {
    const expected = rotateWorld({ x: 100, y: 0 }, deg);

    const pivot = new THREE.Object3D();
    pivot.rotation.y = (deg * Math.PI) / 180;
    const child = new THREE.Object3D();
    const localViewer = cadPointToViewer({ x: 100, y: 0, z: 0 });
    child.position.set(localViewer.x, localViewer.y, localViewer.z);
    pivot.add(child);
    pivot.updateMatrixWorld(true);
    const worldPos = child.getWorldPosition(new THREE.Vector3());
    // Convert back to CAD mm via the exact inverse cadPointToViewer uses.
    const actual = { x: worldPos.x / 0.001, y: -worldPos.z / 0.001 };

    assert.ok(Math.abs(actual.x - expected.x) < 1e-6, `3D x mismatch at ${deg}°: engine=${actual.x} expected=${expected.x}`);
    assert.ok(Math.abs(actual.y - expected.y) < 1e-6, `3D y mismatch at ${deg}°: engine=${actual.y} expected=${expected.y}`);
  }
});

// =========================================================================================
// PART E — default 3D camera's screen-right matches the 2D plan's screen-right (world+X on
// the right in both), verified against the REAL Three.js camera basis, not just a sign
// assumption. This is what makes "2D left = 3D left" actually true rather than coincidental.
// =========================================================================================

test("the default front-facing 3D camera's own screen-right vector points toward world +X — matching the 2D plan's unflipped X, so an object further right in 2D is also further right in the default 3D view", () => {
  // Mirrors fitCameraToObject's actual setup: camera offset along a positive-Z isometric
  // direction from the target, standard up=(0,1,0), looking at the target.
  const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
  const target = new THREE.Vector3(0, 0, 0);
  const isometricDirection = new THREE.Vector3(1, 0.78, 1).normalize();
  camera.position.copy(target).addScaledVector(isometricDirection, 5);
  camera.up.set(0, 1, 0);
  camera.lookAt(target);
  camera.updateMatrixWorld(true);

  const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  assert.ok(cameraRight.x > 0, `camera-right must point toward +X (matching 2D's unflipped screen-X) — got ${cameraRight.x}`);

  const cameraUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  assert.ok(cameraUp.y > 0, "camera must stay right-side up (never upside down)");
});

// =========================================================================================
// PART F — manual orientation scenario from the QA spec: booth 2000x2000, item A far
// left-front (rotation 30-45°), item B far right-back. 2D must show A left-of-front and B
// right-of-back; the SAME physical relationship must hold in 3D (cadPointToViewer), and
// moving A left-to-right in 2D must correspond to the same physical move in 3D.
// =========================================================================================

test("manual orientation scenario: A (left-front, rotated) and B (right-back) render on the correct sides in 2D AND in 3D, matching each other", () => {
  const a = { xMm: 300, yMm: 300, rotationDeg: 40 };
  const b = { xMm: 1700, yMm: 1700, rotationDeg: 10 };

  // 2D: A must be left-of and below (front) B; B must be right-of and above (back) A.
  const aPlan = worldToPlanView({ x: a.xMm, y: a.yMm }, W, D);
  const bPlan = worldToPlanView({ x: b.xMm, y: b.yMm }, W, D);
  assert.ok(aPlan.x < bPlan.x, "A must render left of B in the 2D plan");
  assert.ok(aPlan.y > bPlan.y, "A (front) must render below B (back) in the 2D plan (larger top% = lower on screen)");

  // 3D: A must have a smaller (more front-ward, i.e. less negative) three.z than B, and a
  // smaller three.x than B — i.e. physically left and closer to the front-facing camera.
  const aViewer = cadPointToViewer({ x: a.xMm, y: a.yMm, z: 0 });
  const bViewer = cadPointToViewer({ x: b.xMm, y: b.yMm, z: 0 });
  assert.ok(aViewer.x < bViewer.x, "A must sit left of B in 3D scene space (matching camera-right=+X)");
  assert.ok(aViewer.z > bViewer.z, "A must sit closer to the front boundary (less negative three.z) than B");
});

test("manual orientation scenario: dragging A from left to right in 2D moves it the same physical direction in 3D, never a mirrored move", () => {
  const before = { xMm: 300, yMm: 300 };
  // Simulate a 2D drag: pointer moves from screen-x=300 to screen-x=1700 (dragging right).
  const beforeScreen = worldToPlanView({ x: before.xMm, y: before.yMm }, W, D);
  const afterScreen = { x: 1700, y: beforeScreen.y };
  const afterWorld = planViewToWorld(afterScreen, W, D);

  assert.ok(afterWorld.x > before.xMm, "dragging right in 2D must increase world X");

  const beforeViewer = cadPointToViewer({ x: before.xMm, y: before.yMm, z: 0 });
  const afterViewer = cadPointToViewer({ x: afterWorld.x, y: afterWorld.y, z: 0 });
  assert.ok(afterViewer.x > beforeViewer.x, "the SAME physical move must increase three.x in 3D too — never a mirrored/decreasing move");
  assert.equal(afterViewer.z, beforeViewer.z, "a purely horizontal 2D drag must never change the 3D depth (Y/three.z)");
});

// =========================================================================================
// PART G — no forbidden hacks, no canonical data touched, no migration.
// =========================================================================================

test("no CSS scaleX(-1) / negative scale / mirror hack anywhere in the 2D plan-view code", () => {
  for (const path of ["../domain/planView.ts", "../components/BoothGenerator.tsx", "../lib/planExport.ts", "../components/configurator/BoothCadPlanView.tsx"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /scaleX\(-1\)|scale\.set\(-1|scale\.x\s*=\s*-1|\.scale\.setScalar\(-1\)/u, `${path} must never use a mirror/negative-scale hack`);
  }
});

test("canonical PlacedComponent.xMm/yMm/rotationDeg are never written through the plan-view transform — saving a project always persists raw world values", () => {
  const source = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  const saveProjectMatch = source.match(/function saveProject\(\)[\s\S]{0,2000}?\n {2}\}/u);
  assert.ok(saveProjectMatch, "expected to find saveProject()");
  assert.doesNotMatch(saveProjectMatch![0], /worldToPlanView|worldRotationToPlanView|planViewToWorld/u);
});

test("no data-migration script or DB write is introduced by this transform change — domain/planView.ts stays a pure, dependency-free module", () => {
  const source = readFileSync(new URL("../domain/planView.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /supabase|createClient|\.update\(|\.insert\(|fetch\(/iu);
});

// =========================================================================================
// PART H — BoothCadPlanView.tsx's top-down CAD-outline camera (2026-08-19 audit/fix): this is
// a SEPARATE, hand-rolled orthographic camera (not cadPointToViewer/worldToPlanView) that
// renders the booth's structural outline behind placed furniture in the 2D plan. Its old
// up=(0,0,1) made its own screen-right equal world -X (a real mirror), compensated for by a
// CSS `rotate(180deg)` + mirrored-position hack (`rotateView180` prop) whose X-compensation was
// only exact when the model's bounding box was centered on the footprint — an untested, latent
// left/right bug for any asymmetric master GLB. Root-cause fix: up=(0,0,-1) makes the raw
// snapshot correctly oriented from the start, so no rotate/mirror compensation is needed at all.
// =========================================================================================

test("BoothCadPlanView's top-down CAD-outline camera: up=(0,0,-1) makes its own screen-right equal world +X — matching cadPointToViewer's viewer frame and the default front-facing camera (Part E), verified against the REAL THREE.Matrix4.lookAt construction, not just a sign assumption", () => {
  // Mirrors BoothCadPlanView.tsx's actual camera setup: an orthographic camera positioned
  // directly above the model's center (positive viewer-Y = up), looking straight down.
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
  const center = new THREE.Vector3(0.4, 0, -0.6); // arbitrary off-origin center, like a real model
  camera.position.set(center.x, 2, center.z);
  camera.up.set(0, 0, -1);
  camera.lookAt(center.x, 0, center.z);
  camera.updateMatrixWorld(true);

  const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  assert.ok(cameraRight.x > 0.99, `camera-right must point toward +X (matching every other view in the app) — got ${cameraRight.x}`);

  // Screen-up (camera local +Y) must point toward world -Z — the BACK direction, since
  // cadPointToViewer maps depth (cad Y) to viewer Z = -cadY: larger depth = more negative Z.
  const cameraImageUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
  assert.ok(cameraImageUp.z < -0.99, `camera's own screen-up must point toward -Z (the back-wall direction) — got ${cameraImageUp.z}`);
});

test("BoothCadPlanView's OLD up=(0,0,1) camera (pre-fix, reconstructed here only to document the bug) really did mirror X — proves the fix wasn't a no-op", () => {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
  camera.position.set(0.4, 2, -0.6);
  camera.up.set(0, 0, 1);
  camera.lookAt(0.4, 0, -0.6);
  camera.updateMatrixWorld(true);
  const cameraRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  assert.ok(cameraRight.x < -0.99, `sanity check: the OLD up vector really did point camera-right toward -X — got ${cameraRight.x}`);
});

/** The exact placement formula BoothCadPlanView.tsx's DOM style and lib/planExport.ts's drawImage now both use — X-preserving, Y-flip-only, same convention as worldToPlanView. */
function cadOutlinePlacement(bounds: { minX: number; minY: number; width: number; depth: number }, footprintWidthMm: number, footprintDepthMm: number) {
  return {
    left: bounds.minX,
    top: footprintDepthMm - bounds.minY - bounds.depth,
    width: bounds.width,
    height: bounds.depth,
  };
}

test("CAD-outline placement formula is exact for an ASYMMETRIC bounding box (model not centered on the footprint) — the old rotateView180 X-compensation was only exact when centered; this formula has no such dependency", () => {
  const footprintWidthMm = 2000;
  const footprintDepthMm = 2000;
  // Model's bounds are NOT centered: minX=340 (not 0), width=1500 (center at 1090, not 1000).
  const bounds = { minX: 340, minY: 100, width: 1500, depth: 1800 };
  const placed = cadOutlinePlacement(bounds, footprintWidthMm, footprintDepthMm);

  // Left edge stays exactly at the model's own minX — X is never touched, matching worldToPlanView.
  assert.equal(placed.left, 340);
  // Top edge: the model's back edge (minY+depth, closest to depthMm) maps to the SMALLEST
  // top value (closest to the plan's top/back) — same worldToPlanView(depthMm - y) formula.
  assert.equal(placed.top, footprintDepthMm - bounds.minY - bounds.depth);
  assert.equal(placed.top, 100);
});

test("CAD-outline placement's Y-flip is self-consistent with worldToPlanView: the top-left corner of the model's raw bounding box maps to the SAME plan point worldToPlanView would give its back-left corner", () => {
  const footprintWidthMm = 2000;
  const footprintDepthMm = 2000;
  const bounds = { minX: 340, minY: 100, width: 1500, depth: 1800 };
  const placed = cadOutlinePlacement(bounds, footprintWidthMm, footprintDepthMm);
  // The model rectangle's back-left corner in world/CAD terms is (minX, minY+depth).
  const backLeftPlan = worldToPlanView({ x: bounds.minX, y: bounds.minY + bounds.depth }, footprintWidthMm, footprintDepthMm);
  assert.equal(placed.left, backLeftPlan.x);
  assert.equal(placed.top, backLeftPlan.y);
});

test("rotateView180 (the retired CSS-rotate/mirror-position compensation) no longer exists anywhere in the codebase", () => {
  for (const path of ["../components/configurator/BoothCadPlanView.tsx", "../components/BoothGenerator.tsx", "../components/workflow/WorkflowSteps.tsx", "../components/workflow/AdminPages.tsx"]) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.doesNotMatch(source, /rotateView180/u, `${path} must no longer reference the retired rotateView180 prop`);
  }
});

test("lib/planExport.ts no longer applies a rotate(Math.PI) compensation when drawing the CAD outline snapshot — the snapshot is correctly oriented at the source", () => {
  const source = readFileSync(new URL("../lib/planExport.ts", import.meta.url), "utf8");
  assert.doesNotMatch(source, /rotate\(Math\.PI\)/u);
});

test("BoothCadPlanView.tsx's camera up vector is (0,0,-1), not the old mirroring (0,0,1)", () => {
  const source = readFileSync(new URL("../components/configurator/BoothCadPlanView.tsx", import.meta.url), "utf8");
  assert.match(source, /camera\.up\.set\(0,\s*0,\s*-1\)/u);
  assert.doesNotMatch(source, /camera\.up\.set\(0,\s*0,\s*1\)/u);
});

// =========================================================================================
// PART I — UI leftovers from the retired 180° convention (2026-08-19 follow-up session): the
// core world<->plan transform was already fixed and is untouched here. These regressions cover
// the presentation-only layers that still carried a stale compensation for it.
// =========================================================================================

test("front-direction marker (.frontMarker): CSS anchors it at the BOTTOM (not top) of its component — Y=0/front-open-side renders at the plan's bottom, so a marker meant to point 'front' must be anchored there at zero rotation", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const rule = css.match(/\.frontMarker\s*\{[^}]*\}/u);
  assert.ok(rule, "expected to find a .frontMarker rule");
  assert.match(rule![0], /bottom:\s*3px/u);
  assert.doesNotMatch(rule![0], /\btop:\s*3px/u);
});

test("front-direction marker glyph is ▼ (not ▲) in BoothGenerator.tsx — at frontDirectionDeg=0 a downward-pointing glyph anchored at the bottom edge points straight at the front/open side", () => {
  const source = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  const markerMatch = source.match(/className="frontMarker"[\s\S]{0,400}?>\s*(.)\s*<\/i>/u);
  assert.ok(markerMatch, "expected to find the frontMarker <i> element");
  assert.equal(markerMatch![1], "▼");
});

test("front marker's zero orientation is consistent with worldToPlanView's own front/back convention — front (Y=0) is the LARGEST plan-Y (bottom), matching where .frontMarker is now anchored", () => {
  const front = worldToPlanView({ x: 1000, y: 0 }, W, D);
  const back = worldToPlanView({ x: 1000, y: D }, W, D);
  assert.ok(front.y > back.y, "front must have a larger plan-Y (rendered lower/bottom) than back");
});

test("no orphaned whole-canvas 180° text counter-rotation remains — the retired '.planViewRotated .placedComponentName / small { rotate(180deg) }' rule (a leftover compensation for the OLD worldToPlanView180 convention) has been removed, not left silently applying an extra flip", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(css, /\.planViewRotated/u, "the retired marker class and its counter-rotation rule must both be gone");
});

test("BoothGenerator.tsx no longer applies the retired 'planViewRotated' class to the 2D canvas — nothing in the current CSS depends on it, so keeping it around would be a misleading dead artifact", () => {
  const source = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /"planViewRotated"/u);
});

test("placed-component name/dimension labels rotate WITH their component (worldRotationToPlanView(item.rotationDeg) on the wrapper) and receive NO separate/extra rotation of their own — .placedComponentName and .placedComponent small carry no CSS transform at all", () => {
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const nameRule = css.match(/\.placedComponentName\s*\{[^}]*\}/u);
  assert.ok(nameRule, "expected a .placedComponentName rule");
  assert.doesNotMatch(nameRule![0], /transform\s*:/u);
});

test("editor annotations (.planAnnotation free-text notes) are position-only — ProjectAnnotation has no rotation field, and the live editor never applies a rotate() to .planAnnotation, so they stay upright by design, not by accidental compensation", () => {
  const domainSource = readFileSync(new URL("../domain/spatialAnnotations.ts", import.meta.url), "utf8");
  const annotationType = domainSource.match(/export type ProjectAnnotation = Readonly<\{[\s\S]*?\}>;/u);
  assert.ok(annotationType);
  assert.doesNotMatch(annotationType![0], /rotation|rotate/iu, "ProjectAnnotation intentionally has no rotation concept — never add one without an explicit product decision");

  const generatorSource = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  const start = generatorSource.indexOf("annotations.filter((annotation) => annotation.visible)");
  assert.ok(start >= 0, "expected to find the live .planAnnotation render block");
  const end = generatorSource.indexOf('editorView === "3d"', start);
  assert.ok(end > start);
  const annotationBlock = generatorSource.slice(start, end);
  assert.doesNotMatch(annotationBlock, /rotate\(/u);
});

test("export (renderTechnicalPlanPng) draws annotation text upright too — the annotations block never wraps its fillText in a context.rotate(), matching the editor's own unrotated .planAnnotation rendering", () => {
  const source = readFileSync(new URL("../lib/planExport.ts", import.meta.url), "utf8");
  const start = source.indexOf('if (layers.includes("annotations"))');
  assert.ok(start >= 0, "expected to find the annotations export block");
  const end = source.indexOf('if (layers.includes("dimensions"))', start);
  assert.ok(end > start);
  const annotationsBlock = source.slice(start, end);
  assert.doesNotMatch(annotationsBlock, /context\.rotate\(/u);
});

test("export's placed-component labels use the SAME worldRotationToPlanView rotation as the live editor's CSS transform — one shared geometry convention across editor and export, not two", () => {
  const exportSource = readFileSync(new URL("../lib/planExport.ts", import.meta.url), "utf8");
  assert.match(exportSource, /context\.rotate\(\(worldRotationToPlanView\(item\.rotationDeg\) \* Math\.PI\) \/ 180\)/u);
  const generatorSource = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  assert.match(generatorSource, /rotate\(\$\{worldRotationToPlanView\(item\.rotationDeg\)\}deg\)/u);
});
