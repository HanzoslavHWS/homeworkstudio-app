import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { boothTypes } from "../data/booths.ts";
import { componentCatalog, placeComponent } from "../data/components.ts";
import {
  cadPointToViewer,
  getComponentModel,
  getMasterReferenceModel,
  mmToSceneUnits,
  placedComponentToViewerTransform,
  sceneUnitsToMm,
  viewerPointToCad,
} from "../domain/cad3d.ts";
import { worldToPlanView } from "../domain/planView.ts";
import { measuredDistance3DMm, measuredDistanceMm } from "../domain/spatialAnnotations.ts";

async function modelBounds(path: string) {
  const file = readFileSync(path);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  const gltf = await new Promise<{ scene: THREE.Group }>((resolve, reject) =>
    new GLTFLoader().parse(buffer, "", resolve, reject),
  );
  const bounds = new THREE.Box3().setFromObject(gltf.scene);
  return { bounds, size: bounds.getSize(new THREE.Vector3()) };
}

test("CAD boundary převádí mm centrálně na scene units", () => {
  assert.equal(mmToSceneUnits(1000), 1);
  assert.equal(sceneUnitsToMm(2.5), 2500);
});

test("CAD Z-up osy se mapují na Three.js Y-up", () => {
  assert.deepEqual(cadPointToViewer({ x: 2020, y: 1046, z: 2500 }), {
    x: 2.02,
    y: 2.5,
    z: -1.046,
  });
});

test("Koje 2x2 deklaruje MASTER asset mimo UI komponentu", () => {
  const booth = boothTypes.find((item) => item.id === "koje-2x2");
  const master = getMasterReferenceModel(booth?.assets);

  assert.equal(master?.url, "/models/booths/koje-2x2/master.glb");
  assert.equal(master?.role, "master-reference");
  assert.equal(master?.unit, "mm");
  assert.equal(master?.axisSystem, "x-right-y-depth-z-up");
  assert.equal(
    existsSync("public/models/booths/koje-2x2/master.glb"),
    true,
  );
});

test("MASTER GLB zachovává skutečný CAD offset vůči koberci", async () => {
  const { bounds, size } = await modelBounds(
    "public/models/booths/koje-2x2/master.glb",
  );
  assert.ok(Math.abs(bounds.min.x - 0) < 0.01);
  assert.ok(Math.abs(bounds.min.y - 958.4437) < 0.01);
  assert.ok(Math.abs(bounds.max.y - 2004.4436) < 0.01);
  assert.ok(Math.abs(size.x - 2020) < 0.01);
  assert.ok(Math.abs(size.y - 1046) < 0.01);
  assert.ok(Math.abs(size.z - 2500) < 0.01);
});

test("židle je reálný katalogový asset s CAD rozměry", async () => {
  const chairModel = getComponentModel(componentCatalog.chair.assets);
  assert.equal(chairModel?.url, "/models/chairs/zidle.glb");
  assert.equal(componentCatalog.chair.name, "Židle kovová čalouněná");
  assert.equal(componentCatalog.chair.widthMm, 535);
  assert.equal(componentCatalog.chair.depthMm, 592);
  assert.equal(componentCatalog.chair.heightMm, 795);

  const { size } = await modelBounds("public/models/chairs/zidle.glb");
  assert.ok(Math.abs(size.x - 535) < 0.1);
  assert.ok(Math.abs(size.y - 591.902) < 0.1);
  assert.ok(Math.abs(size.z - 794.797) < 0.1);
});

test("3D židle používá stejnou instanci pozice a rotace jako 2D", () => {
  const placed = {
    ...placeComponent(componentCatalog.chair, "chair-1", 1250, 775),
    rotationDeg: 37,
  };
  const transform = placedComponentToViewerTransform(placed);
  assert.deepEqual(transform.position, { x: 1.25, y: 0, z: -0.775 });
  assert.ok(Math.abs(transform.rotationYRad - (37 * Math.PI) / 180) < 1e-12);
});

// =========================================================================================
// 2D/3D coordinate consistency — regression tests.
//
// History: an earlier fix rotated the 3D viewer's `content`/`editorOverlays` groups by 180° at
// render time, reasoning that the 2D floor plan's own "back wall at top" rotation had to be a
// full 180° (flipping both X and Y) since that's the only PROPER (non-mirror) 2D rotation. That
// 180° group rotation was mathematically valid (determinant +1) and never broke relative
// positions — but it had an unintended side effect: BoothCadViewer.tsx's fitCameraToObject
// default camera direction (a fixed, orientation-agnostic isometric offset with a POSITIVE Z
// component) already put the default camera outside the booth's canonical front boundary
// (Y=0mm → cadPointToViewer's three.z=0; the booth interior extends toward negative three.z,
// toward the back at Y=depthMm). Rotating `content` by 180° moved the BACK to the positive-Z
// side instead, so the unchanged camera direction ended up looking at the booth from behind —
// i.e. it caused the "default 3D view shows the back" bug rather than fixing anything. That
// group rotation was removed (BoothCadViewer.tsx no longer sets content.rotation.y/
// editorOverlays.rotation.y); fitCameraToObject's positive-Z isometric offset now sits outside
// the front boundary by construction — see the "front boundary" tests below.
//
// The follow-up "2D shows an object on the left, 3D's default view shows it on the right"
// report turned out to have a real, fixable root cause too: domain/planView.ts's
// worldToPlanView180 flipped BOTH the X and Y axes to put the back wall at the top of the 2D
// plan — but flipping X was never necessary for that goal. CSS/SVG's `top`/y already grows
// downward, so putting the back (high Y) at the top only ever needed a Y flip; X was always
// meant to render exactly as-is (world+X on the right, matching the 3D camera's own natural
// camera-right=+X with no rotation needed — see domain/cad3d.ts). worldToPlanView180 has been
// replaced by domain/planView.ts's worldToPlanView (X unchanged, Y flipped) — see
// tests/planView.test.ts for full coverage of the corrected transform, its inverse, and the
// matching rotation-angle mapping.
//
// cadPointToViewer/placedComponentToViewerTransform were never touched by any of this — they
// stay the pure, canonical mapping tests/geometry.test.ts's collision math also relies on.
// =========================================================================================

test("inverse 3D→project round-trips exactly: viewerPointToCad(cadPointToViewer(p)) === p", () => {
  const points = [
    { x: 0, y: 0, z: 0 },
    { x: 2020, y: 1046, z: 2500 },
    { x: -300, y: 1600, z: 795 },
    { x: 1234.5, y: -678.25, z: 0 },
  ];
  for (const p of points) {
    const roundTripped = viewerPointToCad(cadPointToViewer(p));
    assert.ok(Math.abs(roundTripped.x - p.x) < 1e-9, `x round-trip failed for ${JSON.stringify(p)}`);
    assert.ok(Math.abs(roundTripped.y - p.y) < 1e-9, `y round-trip failed for ${JSON.stringify(p)}`);
    assert.ok(Math.abs(roundTripped.z - p.z) < 1e-9, `z round-trip failed for ${JSON.stringify(p)}`);
  }
});

test("no mirror on X: cadPointToViewer never negates/flips the X axis", () => {
  for (const x of [-500, 0, 500, 2020]) {
    assert.equal(cadPointToViewer({ x, y: 0, z: 0 }).x, mmToSceneUnits(x));
  }
});

function toVector3(point: { x: number; y: number; z: number }): THREE.Vector3 {
  return new THREE.Vector3(point.x, point.y, point.z);
}

test("handedness/cross-product test: cadPointToViewer preserves right-handedness — a mirror (reflection) would flip this sign", () => {
  const origin = toVector3(cadPointToViewer({ x: 0, y: 0, z: 0 }));
  const ex = toVector3(cadPointToViewer({ x: 1, y: 0, z: 0 })).sub(origin);
  const ey = toVector3(cadPointToViewer({ x: 0, y: 1, z: 0 })).sub(origin);
  const ez = toVector3(cadPointToViewer({ x: 0, y: 0, z: 1 })).sub(origin);
  const cross = new THREE.Vector3().crossVectors(ex, ey);
  const triple = cross.dot(ez);
  assert.ok(triple > 0, `(ex × ey) · ez must stay positive (right-handed) — got ${triple}, a negative value would mean cadPointToViewer introduces a mirror`);
});

test("raycast click handler converts hit points straight through viewerPointToCad — no residual view-rotation undo needed", () => {
  const viewerSource = readFileSync(new URL("../components/configurator/BoothCadViewer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(viewerSource, /undoViewOnlyYaw180|VIEW_ONLY_YAW_180_RAD/u, "BoothCadViewer.tsx must not reintroduce the reverted content-group view rotation");
  assert.match(viewerSource, /viewerPointToCad\(hit\.point\)/u, "the click handler should convert hit.point directly, since content/editorOverlays no longer carry any render-time rotation");
});

test("content and editorOverlays groups carry no render-time rotation", () => {
  const viewerSource = readFileSync(new URL("../components/configurator/BoothCadViewer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(viewerSource, /content\.rotation\.y\s*=/u);
  assert.doesNotMatch(viewerSource, /editorOverlays\.rotation\.y\s*=/u);
});

/** Ground truth world-space rotation formula — mirrors geometry/polygons.ts's getRotatedCorners exactly, applied to a single point instead of box corners. */
function rotateWorldPoint(point: { x: number; y: number }, deg: number): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return {
    x: point.x * Math.cos(rad) - point.y * Math.sin(rad),
    y: point.x * Math.sin(rad) + point.y * Math.cos(rad),
  };
}

test("rotations 0/45/90/180/270° stay physically consistent between world-space rotation and the REAL Three.js engine applying placedComponentToViewerTransform's rotationYRad", () => {
  const localOffset = { x: 300, y: 150 };
  for (const deg of [0, 45, 90, 180, 270]) {
    const worldRotated = rotateWorldPoint(localOffset, deg);
    const expectedViewer = cadPointToViewer({ x: worldRotated.x, y: worldRotated.y, z: 0 });

    const unrotatedViewer = cadPointToViewer({ x: localOffset.x, y: localOffset.y, z: 0 });
    const pivot = new THREE.Object3D();
    const transform = placedComponentToViewerTransform({ xMm: 0, yMm: 0, rotationDeg: deg });
    pivot.rotation.y = transform.rotationYRad;
    const child = new THREE.Object3D();
    child.position.set(unrotatedViewer.x, unrotatedViewer.y, unrotatedViewer.z);
    pivot.add(child);
    pivot.updateMatrixWorld(true);
    const actual = child.getWorldPosition(new THREE.Vector3());

    assert.ok(Math.abs(actual.x - expectedViewer.x) < 1e-9, `x mismatch at ${deg}°: engine=${actual.x} expected=${expectedViewer.x}`);
    assert.ok(Math.abs(actual.z - expectedViewer.z) < 1e-9, `z mismatch at ${deg}°: engine=${actual.z} expected=${expectedViewer.z}`);
  }
});

test("3D relative positions between two placed points equal their raw world-space delta — content carries no render-time rotation, so cadPointToViewer's output is the canonical mapping end to end", () => {
  const a = { x: 200, y: 1800 };
  const b = { x: 1700, y: 300 };
  const rawRelative = { x: b.x - a.x, y: b.y - a.y };

  const aViewer = cadPointToViewer({ ...a, z: 0 });
  const bViewer = cadPointToViewer({ ...b, z: 0 });
  const relative3DAsMm = viewerPointToCad({
    x: bViewer.x - aViewer.x,
    y: bViewer.y - aViewer.y,
    z: bViewer.z - aViewer.z,
  });

  assert.ok(Math.abs(relative3DAsMm.x - rawRelative.x) < 1e-6);
  assert.ok(Math.abs(relative3DAsMm.y - rawRelative.y) < 1e-6);
});

test("front boundary (Y=0mm) maps to three.z=0; the back boundary (Y=depthMm) maps to a negative three.z — the booth interior extends toward negative Z from the front", () => {
  const depthMm = 2000;
  const front = cadPointToViewer({ x: 1000, y: 0, z: 0 });
  const back = cadPointToViewer({ x: 1000, y: depthMm, z: 0 });
  assert.ok(Math.abs(front.z) < 1e-9, `front boundary must map to three.z≈0, got ${front.z}`);
  assert.ok(back.z < 0, `back boundary must sit at negative Z, got ${back.z}`);
});

test("default 3D camera direction sits on the positive-Z side (outside the canonical front boundary at Y=0), never negative-Z (which would sit outside the back)", () => {
  const viewerSource = readFileSync(new URL("../components/configurator/BoothCadViewer.tsx", import.meta.url), "utf8");
  const isometricMatch = viewerSource.match(/isometricDirection\s*=\s*new THREE\.Vector3\(([^)]+)\)/u);
  assert.ok(isometricMatch, "expected fitCameraToObject to define an isometricDirection Vector3");
  const components = isometricMatch![1].split(",").map((part) => Number(part.trim()));
  const [, , zComponent] = components;
  assert.ok(zComponent > 0, `isometric direction's Z component must stay positive so the default camera sits outside the front (Y=0) boundary — got ${zComponent}`);
});

// Full 2D plan-view transform coverage (back-at-top, world-left=plan-left, rotation mapping,
// pointer/drag inverse, round-trips, ...) now lives in tests/planView.test.ts — this file keeps
// only the 3D-side and cross-cutting canonical-data-untouched guards below.

test("view-only 2D transform never mutates its input and is never called from the project save path", () => {
  const point = { x: 300, y: 1600 };
  const frozen = Object.freeze({ ...point });
  worldToPlanView(frozen, 2000, 2000);
  assert.deepEqual(frozen, { x: 300, y: 1600 }, "worldToPlanView must never mutate its input point");

  const boothGeneratorSource = readFileSync(new URL("../components/BoothGenerator.tsx", import.meta.url), "utf8");
  const saveProjectMatch = boothGeneratorSource.match(/function saveProject\(\)[\s\S]{0,2000}?\n  \}/u);
  if (saveProjectMatch) {
    assert.doesNotMatch(saveProjectMatch[0], /worldToPlanView|worldRotationToPlanView/u, "saving a project must persist raw xMm/yMm/rotationDeg, never the view-transformed presentation values");
  }
});

test("canonical dimensions/measurements are unchanged by the view transform — distance between two world points is identical whether measured in raw project mm or after either view transform (a single-axis flip and a pure 3D mapping are both distance-preserving)", () => {
  const a = { x: 0, y: 0 };
  const b = { x: 850, y: 640 };
  const rawDistance = measuredDistanceMm(a, b);

  const a2D = worldToPlanView(a, 2000, 2000);
  const b2D = worldToPlanView(b, 2000, 2000);
  assert.equal(measuredDistanceMm(a2D, b2D), rawDistance);

  const a3D: readonly [number, number, number] = [a.x, a.y, 0];
  const b3D: readonly [number, number, number] = [b.x, b.y, 0];
  assert.equal(measuredDistance3DMm(a3D, b3D), rawDistance);
});

test("no CSS scaleX(-1) / negative global scene scale hack anywhere in the 3D viewer", () => {
  const viewerSource = readFileSync(new URL("../components/configurator/BoothCadViewer.tsx", import.meta.url), "utf8");
  const cad3dSource = readFileSync(new URL("../domain/cad3d.ts", import.meta.url), "utf8");
  const globalsCss = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(viewerSource, /scaleX\(-1\)|scale\.set\(-1|scale\.x\s*=\s*-1|\.scale\.setScalar\(-1\)/u);
  assert.doesNotMatch(cad3dSource, /scaleX\(-1\)|scale\.set\(-1/u);
  assert.doesNotMatch(globalsCss, /scaleX\(-1\)|scale\(-1\)/iu);
});

test("placedComponentToViewerTransform stays the pure, canonical mapping — never a view-rotated one", () => {
  // Regression guard: any future view-only transform must live ONLY at the Three.js
  // scene-graph level, never inside these pure functions — otherwise every caller (including
  // tests/geometry.test.ts's collision math, which never goes through cad3d.ts) would silently
  // disagree about what "rotationDeg" means.
  const transform = placedComponentToViewerTransform({ xMm: 1250, yMm: 775, rotationDeg: 37 });
  assert.deepEqual(transform.position, { x: 1.25, y: 0, z: -0.775 });
});
