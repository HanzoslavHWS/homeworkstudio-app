import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { boothTypes } from "../data/booths.ts";
import { componentCatalog, placeComponent } from "../data/components.ts";
import {
  BOOTH_PLAN_VISUAL_PADDING_MM,
  applyBoothAssemblyVisibility,
  applyBoothModelTransform,
  applyComponentModelMaterialPolicy,
  cameraPositionAtDistance,
  cameraStateFromView,
  cameraZoomPercent,
  cadPointToViewer,
  createTopDownBoothPlanFrame,
  distanceBetween3DPoints,
  findPrintableModelNodes,
  fitPerspectiveCameraState,
  getComponentModel,
  getMasterReferenceModel,
  isVariantAvailable,
  mmToSceneUnits,
  modelUnitScaleToScene,
  modelUnitsToMillimeters,
  placedComponentToViewerTransform,
  resolveBoothAssemblyVisibility,
  resolveBoothModelSource,
  resolveComponentModelReference,
  sceneUnitsToMm,
  viewerPointToCad,
} from "../domain/cad3d.ts";
import {
  resolveBoothPlanVisualMode,
  shouldRenderCanonicalBoothConstruction,
} from "../domain/boothPlan.ts";
import { createProjectRecord, normalizeProjectRecord } from "../domain/project.ts";
import {
  P86_CANONICAL_PRINT_SURFACES,
  P86_FASCIA_PRINT_HEIGHT_MM,
  P86_FASCIA_PRINT_WIDTH_MM,
  P86_PANEL_PRINT_HEIGHT_MM,
  P86_PANEL_PRINT_SURFACES,
  P86_PANEL_PRINT_WIDTH_MM,
  P86_PRINT_SURFACE_NODE_NAMES,
  resolvePrintSurfaceBinding,
} from "../domain/printSurfaces.ts";
import type { PrintSurface } from "../domain/models.ts";
import type { BoothVariant } from "../domain/models.ts";
import { worldToPlanView } from "../domain/planView.ts";
import { measuredDistance3DMm, measuredDistanceMm } from "../domain/spatialAnnotations.ts";
import {
  applyPrintArtworkOverlays,
  createArtworkMaskMaterial,
  findPrintArtworkOverlays,
  PRINT_ARTWORK_OVERLAY_MARKER,
  type PrintArtworkOverlayMetadata,
} from "../lib/printArtworkOverlays.ts";
import {
  assignArtworkToPrintSurface,
  removeArtworkFromPrintSurface,
} from "../domain/technicalServices.ts";
import type { GraphicFileReference, PrintSurfaceAssignment } from "../domain/project.ts";
import {
  artworkPlacementForMode,
  calculateArtworkUvTransform,
  DEFAULT_ARTWORK_PLACEMENT,
  MAX_ARTWORK_SCALE,
  MIN_ARTWORK_SCALE,
  normalizeArtworkPlacement,
  updatePrintSurfaceArtworkPlacement,
} from "../domain/artworkPlacement.ts";

async function loadModel(path: string) {
  const file = readFileSync(path);
  const buffer = file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
  return new Promise<{ scene: THREE.Group }>((resolve, reject) =>
    new GLTFLoader().parse(buffer, "", resolve, reject),
  );
}

async function modelBounds(path: string) {
  const gltf = await loadModel(path);
  const bounds = new THREE.Box3().setFromObject(gltf.scene);
  return { bounds, size: bounds.getSize(new THREE.Vector3()) };
}

test("CAD boundary převádí mm centrálně na scene units", () => {
  assert.equal(mmToSceneUnits(1000), 1);
  assert.equal(sceneUnitsToMm(2.5), 2500);
});

test("3D camera zoom keeps the view ray, clamps distance and reports a stable percentage", () => {
  const position = { x: 3, y: 4, z: 12 };
  const target = { x: 0, y: 0, z: 0 };
  const referenceDistance = distanceBetween3DPoints(position, target);
  const zoomedIn = cameraPositionAtDistance(
    position,
    target,
    referenceDistance / 1.2,
    2,
    20,
  );

  assert.ok(Math.abs(distanceBetween3DPoints(zoomedIn, target) - referenceDistance / 1.2) < 1e-12);
  assert.equal(cameraZoomPercent(referenceDistance, distanceBetween3DPoints(zoomedIn, target)), 120);
  const clamped = cameraPositionAtDistance(position, target, 100, 2, 20);
  assert.ok(Math.abs(distanceBetween3DPoints(clamped, target) - 20) < 1e-12);
  assert.ok(Math.abs(clamped.x / clamped.z - position.x / position.z) < 1e-12);
  assert.ok(Math.abs(clamped.y / clamped.z - position.y / position.z) < 1e-12);
  assert.equal(cameraZoomPercent(0, 0), 100);
});

test("3D Fit computes a new framed camera state and Reset/100% restores the declared default state", () => {
  const fit = fitPerspectiveCameraState({ x: 1, y: 1.25, z: -0.5 }, 2, 38, 16 / 9);
  assert.deepEqual(fit.target, { x: 1, y: 1.25, z: -0.5 });
  assert.ok(fit.referenceDistance > 2);
  assert.equal(cameraZoomPercent(fit.referenceDistance, distanceBetween3DPoints(fit.position, fit.target)), 100);

  const reset = cameraStateFromView({
    position: [3, 3.1, 5],
    target: [0, 1.1, 0],
    fov: 38,
  }, 50);
  assert.deepEqual(reset.position, { x: 3, y: 3.1, z: 5 });
  assert.deepEqual(reset.target, { x: 0, y: 1.1, z: 0 });
  assert.equal(reset.fov, 38);
  assert.equal(cameraZoomPercent(reset.referenceDistance, distanceBetween3DPoints(reset.position, reset.target)), 100);
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

  assert.equal(master?.url, "/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  assert.equal(master?.role, "master-reference");
  assert.equal(master?.unit, "m");
  assert.equal(master?.axisSystem, "x-right-y-depth-z-up");
  assert.equal(
    existsSync("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb"),
    true,
  );
});

test("MASTER GLB zachovává skutečný CAD offset vůči koberci", async () => {
  const { bounds, size } = await modelBounds(
    "public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb",
  );
  assert.ok(Math.abs(bounds.min.x - -1.01) < 0.0001);
  assert.ok(Math.abs(bounds.min.y - -0.036) < 0.0001);
  assert.ok(Math.abs(bounds.max.y - 1.01) < 0.0001);
  assert.ok(Math.abs(size.x - 2.02) < 0.0001);
  assert.ok(Math.abs(size.y - 1.046) < 0.0001);
  assert.ok(Math.abs(size.z - 2.5) < 0.0001);
});

test("židle je reálný katalogový asset s CAD rozměry", async () => {
  const chairModel = getComponentModel(componentCatalog.chair.assets);
  assert.equal(chairModel?.url, "/models/chairs/M57/M57_ZIDLE.glb");
  assert.equal(chairModel?.unit, "m");
  assert.equal(
    componentCatalog.chair.modelAsset?.originalFileName,
    "M57_ZIDLE.glb",
  );
  assert.equal(componentCatalog.chair.name, "Židle kovová čalouněná");
  assert.equal(componentCatalog.chair.widthMm, 535);
  assert.equal(componentCatalog.chair.depthMm, 592);
  assert.equal(componentCatalog.chair.heightMm, 795);

  const { size } = await modelBounds("public/models/chairs/M57/M57_ZIDLE.glb");
  assert.ok(Math.abs(modelUnitsToMillimeters(size.x, "m") - 530) < 0.1);
  assert.ok(Math.abs(modelUnitsToMillimeters(size.y, "m") - 600) < 0.1);
  assert.ok(Math.abs(modelUnitsToMillimeters(size.z, "m") - 821.463) < 0.1);
});

test("M57 effective resolver preferuje aktivní R2 modelAsset a canonical legacy používá jen bez něj", () => {
  const placed = placeComponent(componentCatalog.chair, "m57-effective", 0, 0);
  const active = resolveComponentModelReference(placed);
  assert.equal(active?.kind, "stored");
  if (active?.kind === "stored") {
    assert.equal(active.asset.originalFileName, "M57_ZIDLE.glb");
    assert.equal(
      active.asset.storageKey,
      "catalog/furniture/m57/models/dbd83002-2ac6-4522-b384-02502761cbe6.glb",
    );
    assert.equal(active.unit, "m");
  }

  const fallback = resolveComponentModelReference({
    ...placed,
    modelAsset: undefined,
  });
  assert.equal(fallback?.kind, "legacy");
  if (fallback?.kind === "legacy") {
    assert.equal(fallback.asset.url, "/models/chairs/M57/M57_ZIDLE.glb");
  }
});

test("produkční M57 GLB zachovává canonical uzly a PBR materiály; scoped policy mění jen normals/side", async () => {
  const { scene } = await loadModel("public/models/chairs/M57/M57_ZIDLE.glb");
  const frame = scene.getObjectByName("M57_FRAME") as THREE.Mesh;
  const seat = scene.getObjectByName("M57_SEAT") as THREE.Mesh;
  const backrest = scene.getObjectByName("M57_BACKREST") as THREE.Mesh;
  assert.ok(frame?.isMesh);
  assert.ok(seat?.isMesh);
  assert.ok(backrest?.isMesh);

  const chrome = frame.material as THREE.MeshStandardMaterial;
  const black = seat.material as THREE.MeshStandardMaterial;
  assert.equal(chrome.name, "MAT_M57_CHROME");
  assert.equal((backrest.material as THREE.Material).name, "MAT_M57_BLACK");
  assert.equal(black.name, "MAT_M57_BLACK");
  const before = {
    chrome: {
      color: chrome.color.getHex(),
      metalness: chrome.metalness,
      roughness: chrome.roughness,
      opacity: chrome.opacity,
      transparent: chrome.transparent,
      name: chrome.name,
    },
    black: {
      color: black.color.getHex(),
      metalness: black.metalness,
      roughness: black.roughness,
      opacity: black.opacity,
      transparent: black.transparent,
      name: black.name,
    },
  };
  assert.equal(frame.geometry.getAttribute("normal"), undefined);

  const result = applyComponentModelMaterialPolicy(
    scene,
    placeComponent(componentCatalog.chair, "m57-material", 0, 0),
    THREE.DoubleSide,
  );
  assert.deepEqual(result, { computedNormals: 3, updatedMaterials: 2 });
  assert.ok(frame.geometry.getAttribute("normal"));
  assert.equal(chrome.side, THREE.DoubleSide);
  assert.equal(black.side, THREE.DoubleSide);
  assert.deepEqual(
    {
      chrome: {
        color: chrome.color.getHex(),
        metalness: chrome.metalness,
        roughness: chrome.roughness,
        opacity: chrome.opacity,
        transparent: chrome.transparent,
        name: chrome.name,
      },
      black: {
        color: black.color.getHex(),
        metalness: black.metalness,
        roughness: black.roughness,
        opacity: black.opacity,
        transparent: black.transparent,
        name: black.name,
      },
    },
    before,
  );
  assert.notEqual(black.color.getHex(), 0xffffff);
});

test("M57 material policy nemá globální side ani normals efekt na jiný katalogový model", () => {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3),
  );
  const material = new THREE.MeshStandardMaterial({ side: THREE.FrontSide });
  material.name = "MAT_M57_BLACK";
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geometry, material));

  const result = applyComponentModelMaterialPolicy(
    root,
    { definitionId: "some-other-component", internalCode: "OTHER" },
    THREE.DoubleSide,
  );
  assert.deepEqual(result, { computedNormals: 0, updatedMaterials: 0 });
  assert.equal(geometry.getAttribute("normal"), undefined);
  assert.equal(material.side, THREE.FrontSide);
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
  assert.match(viewerSource, /viewerPointToCad\(\s*hit\.point\.clone\(\)\.sub\(projectFrameOffset\)/u, "the click handler may undo only the explicit centered-origin translation before the canonical conversion");
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
  const fit = fitPerspectiveCameraState({ x: 0, y: 1, z: -1 }, 2, 38, 1.5);
  assert.ok(fit.position.z > fit.target.z, `fit camera must stay on the positive-Z side of its target — got camera ${fit.position.z}, target ${fit.target.z}`);
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

// =========================================================================================
// GENERÁTOR TYPOVEK (2026-08-19): resolveBoothModelSource / isVariantAvailable — a booth with
// declared variants (T04..T25) must use the SELECTED variant's OWN modelAsset, never one shared
// parent GLB for every variant. P86 (no variants) is completely unaffected.
// =========================================================================================

const storedGlbAsset = {
  id: "variant-glb-1",
  storageKey: "catalog/furniture/t04/models/v1.glb",
  originalFileName: "t04-v1.glb",
  mimeType: "model/gltf-binary" as const,
  size: 500_000,
  createdAt: "2026-08-19T00:00:00.000Z",
  category: "catalog-model" as const,
};

const legacyMasterAsset = { id: "master", url: "/models/booths/koje-2x2/master.glb", role: "master-reference" as const, unit: "mm" as const, axisSystem: "x-right-y-depth-z-up" as const };

test("resolveBoothModelSource: a booth with NO variants (P86) always resolves to its own master-reference asset, regardless of selectedVariantId — completely unaffected by the variant logic", () => {
  const p86 = { variants: [] as readonly BoothVariant[], assets: { sourceId: "p86", scale: 1 as const, unit: "mm" as const, models3d: [legacyMasterAsset] } };
  const resolved = resolveBoothModelSource(p86, [], undefined);
  assert.deepEqual(resolved, { kind: "legacy", asset: legacyMasterAsset });
});

test("resolveBoothModelSource: a booth WITH variants never falls back to the parent's own assets — no variant selected yields undefined even if the parent has a master GLB", () => {
  const boothWithParentAssets = { variants: [{ id: "v1", name: "V1" }] as readonly BoothVariant[], assets: { sourceId: "x", scale: 1 as const, unit: "mm" as const, models3d: [legacyMasterAsset] } };
  const resolved = resolveBoothModelSource(boothWithParentAssets, [], undefined);
  assert.equal(resolved, undefined, "no variant selected -> nothing to load, never the parent's own GLB");
});

test("resolveBoothModelSource: prefers the SELECTED variant's own modelAsset (StoredAsset) over the parent's assets", () => {
  const variants: readonly BoothVariant[] = [{ id: "v1", name: "V1", modelAsset: storedGlbAsset }];
  const booth = { variants, assets: { sourceId: "x", scale: 1 as const, unit: "mm" as const, models3d: [legacyMasterAsset] } };
  const resolved = resolveBoothModelSource(booth, [], "v1");
  assert.deepEqual(resolved, { kind: "stored", asset: storedGlbAsset });
});

test("resolveBoothModelSource: a variant with an explicit assetSourceBoothId (demo/test fixture pattern, e.g. T4-TEST borrowing P86's asset) still resolves via the legacy path when it has no own modelAsset", () => {
  const variants: readonly BoothVariant[] = [{ id: "v1", name: "V1", assetSourceBoothId: "p86" }];
  const booth = { variants, assets: undefined };
  const allBooths = [{ id: "p86", assets: { sourceId: "p86", scale: 1 as const, unit: "mm" as const, models3d: [legacyMasterAsset] } }];
  const resolved = resolveBoothModelSource(booth, allBooths, "v1");
  assert.deepEqual(resolved, { kind: "legacy", asset: legacyMasterAsset });
});

test("resolveBoothModelSource: a variant with NEITHER its own modelAsset NOR an assetSourceBoothId resolves to undefined — never presents as available", () => {
  const variants: readonly BoothVariant[] = [{ id: "v1", name: "V1" }];
  const booth = { variants, assets: undefined };
  const resolved = resolveBoothModelSource(booth, [], "v1");
  assert.equal(resolved, undefined);
});

test("resolveBoothModelSource: configurationBoothId is accepted as an alias for assetSourceBoothId (both legacy fields point at a shared source booth)", () => {
  const variants: readonly BoothVariant[] = [{ id: "v1", name: "V1", configurationBoothId: "p86" }];
  const booth = { variants, assets: undefined };
  const allBooths = [{ id: "p86", assets: { sourceId: "p86", scale: 1 as const, unit: "mm" as const, models3d: [legacyMasterAsset] } }];
  const resolved = resolveBoothModelSource(booth, allBooths, "v1");
  assert.deepEqual(resolved, { kind: "legacy", asset: legacyMasterAsset });
});

test("isVariantAvailable: true for a variant with its own modelAsset, true for one with a resolvable assetSourceBoothId, false when neither exists", () => {
  const withOwnAsset: BoothVariant = { id: "v1", name: "V1", modelAsset: storedGlbAsset };
  const withLegacySource: BoothVariant = { id: "v2", name: "V2", assetSourceBoothId: "p86" };
  const withNothing: BoothVariant = { id: "v3", name: "V3" };
  const allBooths = [{ id: "p86", assets: { sourceId: "p86", scale: 1 as const, unit: "mm" as const, models3d: [legacyMasterAsset] } }];

  assert.equal(isVariantAvailable(withOwnAsset, allBooths), true);
  assert.equal(isVariantAvailable(withLegacySource, allBooths), true);
  assert.equal(isVariantAvailable(withNothing, allBooths), false);
});

test("resolveBoothModelSource: T04-shaped booth with 3 real variants (roh vlevo/roh vpravo/řadová) — an unmodelled variant is unavailable while a modelled one resolves to its own GLB, independent of the other variants' state", () => {
  const t04Variants: readonly BoothVariant[] = [
    { id: "t04-corner-left", name: "Roh – levý", modelAsset: storedGlbAsset },
    { id: "t04-corner-right", name: "Roh – pravý" },
    { id: "t04-inline", name: "Řada / přímý" },
  ];
  const t04 = { variants: t04Variants, assets: undefined };

  assert.deepEqual(resolveBoothModelSource(t04, [], "t04-corner-left"), { kind: "stored", asset: storedGlbAsset });
  assert.equal(resolveBoothModelSource(t04, [], "t04-corner-right"), undefined, "not yet modelled -> must never present as available");
  assert.equal(isVariantAvailable(t04Variants[0]!, []), true);
  assert.equal(isVariantAvailable(t04Variants[1]!, []), false);
  assert.equal(isVariantAvailable(t04Variants[2]!, []), false);
});

test("P86 keeps its catalog identity, price and nominal footprint while using the canonical HWS booth asset", () => {
  const booth = boothTypes.find((item) => item.internalCode === "P86")!;
  assert.equal(booth.id, "koje-2x2");
  assert.equal(booth.code, "P86");
  assert.deepEqual(booth.nominalDimensions, {
    widthMm: 2000,
    depthMm: 2000,
    heightMm: 2500,
  });
  assert.equal(booth.widthMm, 2000);
  assert.equal(booth.depthMm, 2000);
  assert.deepEqual(booth.cadDimensions, {
    widthMm: 2020,
    depthMm: 1046,
    heightMm: 2500,
  });
  assert.equal(booth.pricingEntries?.[0]?.salePrice, 3640);
  assert.equal(booth.boothAsset?.assetId, "HWS_BOOTH_KOJE_2000x2000");
});

test("P86 booth definition maps exactly five canonical GLB assemblies to existing Scene keys", () => {
  const assemblies = boothTypes.find((item) => item.internalCode === "P86")!
    .boothAsset!.assemblies;
  assert.deepEqual(
    assemblies.map((assembly) => [assembly.id, assembly.constructionPartId]),
    [
      ["HWS_ASM_BACK_WALL", "back-wall"],
      ["HWS_ASM_LEFT_WALL", "left-wall"],
      ["HWS_ASM_RIGHT_WALL", "right-wall"],
      ["HWS_ASM_TOP_GRID", "upper-grid"],
      ["HWS_ASM_FASCIA", "collar"],
    ],
  );
});

test("P86 interactive plan selects the GLB top view, while booths without a declared booth GLB keep the canonical fallback", () => {
  const p86 = boothTypes.find((item) => item.internalCode === "P86")!;
  const asset = getMasterReferenceModel(p86.assets);
  assert.equal(resolveBoothPlanVisualMode(p86, asset), "glb-top-view");
  assert.equal(resolveBoothPlanVisualMode(p86, undefined), "canonical-fallback");
  assert.equal(
    resolveBoothPlanVisualMode(
      {
        ...p86,
        id: "booth-without-glb-definition",
        code: "NO-GLB",
        internalCode: "NO-GLB",
        boothAsset: undefined,
      },
      asset,
    ),
    "canonical-fallback",
  );
});

test("P86 top-down GLB frame is governed only by the nominal 2000 x 2000 booth and fixed visual padding", async () => {
  const booth = boothTypes.find((item) => item.internalCode === "P86")!;
  const { size } = await modelBounds(
    "public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb",
  );
  assert.ok(Math.abs(size.x * 1000 - 2020) < 0.001, "real GLB remains physically 2020 mm wide");

  const frame = createTopDownBoothPlanFrame(
    booth.widthMm!,
    booth.depthMm!,
    booth.boothAsset?.originConvention,
  );
  assert.equal(frame.canonicalWidthMm, 2000);
  assert.equal(frame.canonicalDepthMm, 2000);
  assert.equal(frame.visualPaddingMm, BOOTH_PLAN_VISUAL_PADDING_MM);
  assert.equal(frame.cameraCenterX, 0);
  assert.equal(frame.cameraCenterZ, 0);
  assert.deepEqual([frame.left, frame.right, frame.top, frame.bottom], [-1.04, 1.04, 1.04, -1.04]);
  assert.deepEqual(
    [frame.layerLeftPercent, frame.layerTopPercent, frame.layerWidthPercent, frame.layerHeightPercent],
    [-2, -2, 104, 104],
  );
});

test("P86 GLB preserves assembly hierarchy, authored origin and exact physical component counts", async () => {
  const { scene } = await loadModel(
    "public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb",
  );
  const root = scene.getObjectByName("HWS_BOOTH_KOJE_2000x2000")!;
  assert.ok(root);
  assert.equal(root.position.length(), 0, "loader must not recenter the authored root");
  assert.equal(root.userData.origin_rule, "CENTER_OF_COMPLETED_PHYSICAL_BOOTH_ON_FLOOR");

  const countAsset = (assemblyId: string, assetId: string) => {
    let count = 0;
    scene.getObjectByName(assemblyId)!.traverse((node) => {
      if (node.userData.hws_asset_name === assetId) count += 1;
    });
    return count;
  };
  assert.equal(countAsset("HWS_ASM_BACK_WALL", "HWS_POST_40x40_H2500"), 3);
  assert.equal(countAsset("HWS_ASM_BACK_WALL", "HWS_PANEL_950_H2500"), 2);
  assert.equal(countAsset("HWS_ASM_LEFT_WALL", "HWS_POST_40x40_H2500"), 1);
  assert.equal(countAsset("HWS_ASM_LEFT_WALL", "HWS_PANEL_950_H2500"), 1);
  assert.equal(countAsset("HWS_ASM_RIGHT_WALL", "HWS_POST_40x40_H2500"), 1);
  assert.equal(countAsset("HWS_ASM_RIGHT_WALL", "HWS_PANEL_950_H2500"), 1);
  assert.equal(countAsset("HWS_ASM_TOP_GRID", "HWS_GRID_BEAM_950"), 3);
  assert.equal(countAsset("HWS_ASM_TOP_GRID", "HWS_GRID_CONNECTOR_150"), 1);
  assert.equal(countAsset("HWS_ASM_FASCIA", "HWS_FASCIA_2000"), 1);
});

test("P86 authored 40 mm post bounds occupy exactly 30 mm inside the nominal canonical edges", async () => {
  const { scene } = await loadModel(
    "public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb",
  );
  const root = scene.getObjectByName("HWS_BOOTH_KOJE_2000x2000")!;
  assert.deepEqual(root.userData.nominal_footprint_mm, [2000, 2000]);
  assert.deepEqual(root.userData.physical_completed_footprint_mm, [2020, 2020]);

  const bounds = (nodeName: string) => {
    const node = scene.getObjectByName(nodeName);
    assert.ok(node, `${nodeName} must exist in the authored production GLB`);
    return new THREE.Box3().setFromObject(node);
  };
  const left = bounds("HWS_POST_40x40_H2500__LEFT_WALL_01");
  const right = bounds("HWS_POST_40x40_H2500__RIGHT_WALL_01");
  const back = bounds("HWS_POST_40x40_H2500__BACK_WALL_02");

  assert.ok(Math.abs(left.getSize(new THREE.Vector3()).x * 1000 - 40) < 0.001);
  assert.ok(Math.abs(right.getSize(new THREE.Vector3()).x * 1000 - 40) < 0.001);
  assert.ok(Math.abs(back.getSize(new THREE.Vector3()).y * 1000 - 40) < 0.001);
  assert.ok(Math.abs((left.max.x + 1) * 1000 - 30) < 0.001);
  assert.ok(Math.abs((right.min.x + 1) * 1000 - 1970) < 0.001);
  assert.ok(Math.abs((back.min.y + 1) * 1000 - 1970) < 0.001);
});

test("assembly visibility is independent and an old project defaults every P86 assembly to visible", async () => {
  const booth = boothTypes.find((item) => item.internalCode === "P86")!;
  const assemblies = booth.boothAsset!.assemblies;
  const legacy = normalizeProjectRecord({
    id: "legacy-p86-without-assembly-visibility",
    boothId: booth.id,
  });
  const defaults = resolveBoothAssemblyVisibility(
    assemblies,
    legacy.constructionVisibility,
  );
  assert.equal(Object.values(defaults).every(Boolean), true);

  const { scene } = await loadModel(
    "public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb",
  );
  const missing = applyBoothAssemblyVisibility(scene, assemblies, {
    "left-wall": false,
  });
  assert.deepEqual(missing, []);
  assert.equal(scene.getObjectByName("HWS_ASM_LEFT_WALL")!.visible, false);
  assert.equal(scene.getObjectByName("HWS_ASM_BACK_WALL")!.visible, true);
  assert.equal(scene.getObjectByName("HWS_ASM_RIGHT_WALL")!.visible, true);
  assert.equal(scene.getObjectByName("HWS_ASM_TOP_GRID")!.visible, true);
  assert.equal(scene.getObjectByName("HWS_ASM_FASCIA")!.visible, true);

  for (const target of assemblies) {
    const resolved = resolveBoothAssemblyVisibility(assemblies, {
      [target.id]: false,
    });
    for (const assembly of assemblies) {
      assert.equal(
        resolved[assembly.id],
        assembly.id !== target.id,
        `${target.id} must be independently switchable by its canonical assembly id`,
      );
    }
  }

  const topGridMissing = applyBoothAssemblyVisibility(scene, assemblies, {
    HWS_ASM_TOP_GRID: false,
  });
  assert.deepEqual(topGridMissing, []);
  assert.equal(scene.getObjectByName("HWS_ASM_TOP_GRID")!.visible, false);
  assert.equal(scene.getObjectByName("HWS_ASM_FASCIA")!.visible, true);
});

test("interactive 2D and standalone Visualization output share one booth GLB top-view render core", () => {
  const source = readFileSync("components/configurator/BoothCadPlanView.tsx", "utf8");
  const rendererSource = readFileSync("lib/boothPlanGlbRenderer.ts", "utf8");
  const exportSource = readFileSync("lib/planExport.ts", "utf8");
  assert.match(source, /loadBoothPlanModel\(/u);
  assert.match(rendererSource, /applyBoothModelTransform\(/u);
  assert.match(rendererSource, /createTopDownBoothPlanFrame\(/u);
  assert.match(rendererSource, /camera\.up\.set\(0,\s*0,\s*-1\)/u);
  assert.match(exportSource, /renderBoothPlanGlbToCanvas\(/u);
  assert.match(source, /data-plan-source="glb-top-view"/u);
  assert.doesNotMatch(rendererSource, /Box3|setFromObject|getCenter|modelUnitsToMillimeters/u);
  assert.doesNotMatch(exportSource, /querySelector|cadPlanCanvas|cadSnapshot|onSnapshot/u);

  const constructionSource = readFileSync(
    "components/configurator/BoothConstructionPlanView.tsx",
    "utf8",
  );
  assert.match(constructionSource, /visualMode === "glb-top-view"/u);
  assert.match(constructionSource, /<BoothCadPlanView/u);
  assert.match(constructionSource, /showCanonicalConstruction/u);
  assert.doesNotMatch(constructionSource, /canonicalBoothCollision|<line/u);

  const generatorSource = readFileSync("components/BoothGenerator.tsx", "utf8");
  assert.match(generatorSource, /<BoothConstructionPlanView[\s\S]*?asset=\{selectedBoothMasterModel\}/u);
});

test("GLB construction and the black canonical U are mutually exclusive without a normal-editor collision overlay", () => {
  assert.equal(shouldRenderCanonicalBoothConstruction("glb-top-view", "loading"), false);
  assert.equal(shouldRenderCanonicalBoothConstruction("glb-top-view", "ready"), false);
  assert.equal(shouldRenderCanonicalBoothConstruction("glb-top-view", "failed"), true);
  assert.equal(shouldRenderCanonicalBoothConstruction("canonical-fallback", "loading"), true);

  const source = readFileSync(
    "components/configurator/BoothConstructionPlanView.tsx",
    "utf8",
  );
  const conditional = source.indexOf("{showCanonicalConstruction && (");
  const areas = source.indexOf('className="canonicalBoothConstructionAreas"');
  const profiles = source.indexOf('className="canonicalBoothConstructionProfiles"');
  assert.ok(conditional >= 0 && conditional < areas && areas < profiles);
  assert.doesNotMatch(source, /canonicalBoothCollision|<line/u);
  assert.match(source, /shouldRenderCanonicalBoothConstruction\(/u);
});

test("Visualization 2D GLB path obeys booth layer visibility and retains canonical fallback plus independent furniture", () => {
  const source = readFileSync("lib/planExport.ts", "utf8");
  assert.match(source, /layers\.includes\("booth"\)[\s\S]*?renderBoothPlanGlbToCanvas\(/u);
  assert.match(source, /visible:\s*constructionVisibility\.assembly \?\? booth\.visible/u);
  assert.match(source, /if \(layers\.includes\("booth"\) && !renderedBoothGlb\)/u);
  assert.match(source, /content\.boothPlan\.constructionAreas/u);
  assert.match(source, /content\.boothPlan\.constructionProfiles/u);
  assert.match(source, /for \(const item of content\.sceneObjects\)/u);
  assert.match(source, /BOOTH_PLAN_VISUAL_PADDING_MM/u);
});

test("configurator and Visualization preparation preserve identical nested child world transforms", () => {
  const booth = boothTypes.find((item) => item.internalCode === "P86")!;
  const asset = getMasterReferenceModel(booth.assets)!;
  const makeHierarchy = () => {
    const root = new THREE.Group();
    const assembly = new THREE.Group();
    assembly.name = "HWS_ASM_BACK_WALL";
    assembly.position.set(0.35, -0.2, 0.5);
    assembly.rotation.z = Math.PI / 7;
    const nested = new THREE.Group();
    nested.position.set(-0.1, 0.4, 0.2);
    const child = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.3, 0.4));
    child.name = "nested-child";
    child.position.set(0.25, 0.15, -0.05);
    nested.add(child);
    assembly.add(nested);
    root.add(assembly);
    return { root, assembly, nested, child };
  };
  const configurator = makeHierarchy();
  const visualization = makeHierarchy();
  const visibility = { "back-wall": true, "left-wall": false };

  applyBoothModelTransform(configurator.root, asset, booth.boothAsset, visibility);
  applyBoothModelTransform(visualization.root, asset, booth.boothAsset, visibility);

  assert.equal(configurator.child.parent, configurator.nested, "the authored hierarchy must not be flattened");
  assert.deepEqual(configurator.child.position.toArray(), [0.25, 0.15, -0.05]);
  assert.deepEqual(
    configurator.child.getWorldPosition(new THREE.Vector3()).toArray(),
    visualization.child.getWorldPosition(new THREE.Vector3()).toArray(),
  );
  assert.deepEqual(configurator.child.matrixWorld.toArray(), visualization.child.matrixWorld.toArray());
  assert.equal(configurator.root.rotation.x, -Math.PI / 2);
});

test("Visualization step passes the same boothAsset and construction visibility contract as the configurator", () => {
  const source = readFileSync("components/workflow/WorkflowSteps.tsx", "utf8");
  assert.match(source, /boothAsset=\{booth\.boothAsset\}/u);
  assert.match(source, /constructionVisibility=\{project\.constructionVisibility\}/u);
  assert.match(source, /boothVisible=\{project\.constructionVisibility\.assembly \?\? booth\.visible\}/u);
});

test("3D toolbar is wired to the viewer camera controller while 2D keeps its viewport controls", () => {
  const source = readFileSync("components/BoothGenerator.tsx", "utf8");
  assert.match(source, /editorView === "3d" \? \(\) => booth3DCameraControlsRef\.current\?\.zoomOut\(\)/u);
  assert.match(source, /editorView === "3d" \? \(\) => booth3DCameraControlsRef\.current\?\.zoomIn\(\)/u);
  assert.match(source, /editorView === "3d" \? \(\) => booth3DCameraControlsRef\.current\?\.fit\(\)/u);
  assert.match(source, /editorView === "3d" \? \(\) => booth3DCameraControlsRef\.current\?\.reset\(\)/u);
  const viewerSource = readFileSync("components/configurator/BoothCadViewer.tsx", "utf8");
  assert.match(viewerSource, /controls\.enableZoom = true/u, "wheel/OrbitControls zoom stays enabled");
});

test("GLTFLoader retains printable CORE metadata for future front/back graphics workflows", async () => {
  const { scene } = await loadModel(
    "public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb",
  );
  const printable = findPrintableModelNodes(scene);
  const panelCores = printable.filter(
    (node) => node.metadata.hws_asset_name === "HWS_PANEL_950_CORE",
  );
  assert.equal(panelCores.length, 4);
  assert.equal(panelCores.every((node) => node.metadata.printable_front === true), true);
  assert.equal(panelCores.every((node) => node.metadata.printable_back === true), true);
  assert.equal(panelCores.every((node) => node.metadata.surface_role === "PANEL_FACE"), true);
});

test("P86 printable registry has exactly eight stable panel faces plus the backward-compatible fascia id", () => {
  const expectedIds = [
    "back-wall-01-front",
    "back-wall-01-back",
    "back-wall-02-front",
    "back-wall-02-back",
    "left-wall-01-front",
    "left-wall-01-back",
    "right-wall-01-front",
    "right-wall-01-back",
    "fascia-print",
  ];
  assert.equal(P86_PANEL_PRINT_SURFACES.length, 8);
  assert.deepEqual(P86_CANONICAL_PRINT_SURFACES.map((surface) => surface.id), expectedIds);
  assert.equal(new Set(expectedIds).size, 9);
});

test("all P86 panel ids resolve explicitly to the authored CORE node and local physical face", () => {
  const expected = new Map([
    ["back-wall-01", P86_PRINT_SURFACE_NODE_NAMES.backWall01],
    ["back-wall-02", P86_PRINT_SURFACE_NODE_NAMES.backWall02],
    ["left-wall-01", P86_PRINT_SURFACE_NODE_NAMES.leftWall01],
    ["right-wall-01", P86_PRINT_SURFACE_NODE_NAMES.rightWall01],
  ]);
  for (const [panelId, nodeName] of expected) {
    const front = resolvePrintSurfaceBinding(P86_CANONICAL_PRINT_SURFACES, `${panelId}-front`)!;
    const back = resolvePrintSurfaceBinding(P86_CANONICAL_PRINT_SURFACES, `${panelId}-back`)!;
    assert.equal(front.nodeName, nodeName);
    assert.equal(back.nodeName, nodeName);
    assert.equal(front.face, "front");
    assert.equal(back.face, "back");
    assert.equal(front.coordinateSpace, "node-local");
    assert.equal(back.coordinateSpace, "node-local");
    assert.equal(front.localNormalAxis, "-y");
    assert.equal(back.localNormalAxis, "+y");
  }
});

test("authored P86 instance rotations carry local -Y FRONT to the correct physical side", async () => {
  const { scene } = await loadModel(
    "public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb",
  );
  scene.updateWorldMatrix(true, true);
  const expectedWorldFrontNormals = new Map<string, readonly [number, number, number]>([
    [P86_PRINT_SURFACE_NODE_NAMES.backWall01, [0, -1, 0]],
    [P86_PRINT_SURFACE_NODE_NAMES.backWall02, [0, -1, 0]],
    [P86_PRINT_SURFACE_NODE_NAMES.leftWall01, [1, 0, 0]],
    [P86_PRINT_SURFACE_NODE_NAMES.rightWall01, [-1, 0, 0]],
    [P86_PRINT_SURFACE_NODE_NAMES.fascia, [0, -1, 0]],
  ]);
  for (const [nodeName, expected] of expectedWorldFrontNormals) {
    const node = scene.getObjectByName(nodeName)!;
    const worldFront = new THREE.Vector3(0, -1, 0)
      .applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()))
      .toArray()
      .map((coordinate) => {
        const rounded = Math.round(coordinate);
        return Object.is(rounded, -0) ? 0 : rounded;
      });
    assert.deepEqual(worldFront, expected, `${nodeName} local FRONT must follow its authored rotation`);
  }
});

test("P86 canonical print dimensions are 950x2340 per panel face and 2000x300 for fascia", () => {
  assert.equal(P86_PANEL_PRINT_WIDTH_MM, 950);
  assert.equal(P86_PANEL_PRINT_HEIGHT_MM, 2340);
  assert.equal(P86_PANEL_PRINT_SURFACES.every((surface) => surface.widthMm === 950 && surface.heightMm === 2340), true);
  const fascia = P86_CANONICAL_PRINT_SURFACES.find((surface) => surface.id === "fascia-print")!;
  assert.equal(P86_FASCIA_PRINT_WIDTH_MM, 2000);
  assert.equal(P86_FASCIA_PRINT_HEIGHT_MM, 300);
  assert.deepEqual([fascia.widthMm, fascia.heightMm], [2000, 300]);
});

test("fascia-print keeps its business id and resolves to the authored fascia FRONT", () => {
  const fascia = resolvePrintSurfaceBinding(P86_CANONICAL_PRINT_SURFACES, "fascia-print")!;
  assert.equal(fascia.nodeName, P86_PRINT_SURFACE_NODE_NAMES.fascia);
  assert.equal(fascia.face, "front");
  assert.equal(fascia.localNormalAxis, "-y");
});

test("print-surface resolver requires explicit binding and never guesses from id, name or legacy nodeName", () => {
  const traps: readonly PrintSurface[] = [{
    id: "HWS_PANEL_950_H2500__BACK_WALL_01__CORE-front",
    name: "back-wall-01-front HWS_PANEL_950_CORE",
    nodeName: "legacy-whole-node-name",
    widthMm: 950,
    heightMm: 2340,
    active: true,
  }];
  assert.equal(resolvePrintSurfaceBinding(traps, traps[0]!.id), undefined);

  const explicit: readonly PrintSurface[] = [{
    ...traps[0]!,
    sceneBinding: {
      nodeName: "EXPLICIT_AUTHORED_NODE",
      face: "back",
      coordinateSpace: "node-local",
      localNormalAxis: "+y",
    },
  }];
  assert.equal(resolvePrintSurfaceBinding(explicit, explicit[0]!.id)?.nodeName, "EXPLICIT_AUTHORED_NODE");
});

test("all nine P86 bindings point at real authored printable GLB nodes", async () => {
  const { scene } = await loadModel(
    "public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb",
  );
  for (const surface of P86_CANONICAL_PRINT_SURFACES) {
    const binding = resolvePrintSurfaceBinding(P86_CANONICAL_PRINT_SURFACES, surface.id)!;
    const node = scene.getObjectByName(binding.nodeName);
    assert.ok(node, `${surface.id} must resolve to an authored node`);
    assert.equal(node.userData.printable, true);
    if (binding.face === "front") assert.notEqual(node.userData.printable_front, false);
    if (binding.face === "back") assert.equal(node.userData.printable_back, true);
  }
});

test("legacy fascia-only project remains valid and graphicsFiles already carry artwork asset + surface linkage", () => {
  const fasciaAssignment = {
    printSurfaceId: "fascia-print",
    sceneReference: "koje-2x2",
    graphicsKind: "fascia" as const,
    artworkStatus: "received" as const,
    artworkFileId: "artwork-fascia-1",
    selectedForPrint: true,
    canonicalWidthMm: 2000,
    canonicalHeightMm: 300,
    productionWidthMm: 2000,
    productionHeightMm: 300,
    includedInPackage: true,
    pricedSeparately: false,
  };
  const project = createProjectRecord({
    id: "legacy-p86-fascia-only",
    boothId: "koje-2x2",
    printSurfaceAssignments: [fasciaAssignment],
    graphicsFiles: [{
      id: "artwork-fascia-1",
      name: "fascia.pdf",
      size: 1234,
      mimeType: "application/pdf",
      availability: "persistent",
      storageKey: "projects/legacy-p86-fascia-only/graphics/fascia.pdf",
      status: "uploaded",
      printSurfaceId: "fascia-print",
    }],
  });
  const reloaded = normalizeProjectRecord(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(reloaded.printSurfaceAssignments, [fasciaAssignment]);
  assert.equal(reloaded.graphicsFiles[0]?.printSurfaceId, "fascia-print");
  assert.equal(reloaded.graphicsFiles[0]?.storageKey, "projects/legacy-p86-fascia-only/graphics/fascia.pdf");
});

test("declared model units scale the meter-authored P86 GLB exactly once", () => {
  assert.equal(modelUnitScaleToScene("m"), 1);
  assert.equal(modelUnitScaleToScene("mm"), 0.001);
  assert.equal(modelUnitsToMillimeters(2.02, "m"), 2020);
  assert.equal(modelUnitsToMillimeters(2020, "mm"), 2020);
});

const p86ForArtwork = boothTypes.find((item) => item.internalCode === "P86")!;

function artworkFile(id: string, name = `${id}.png`): GraphicFileReference {
  return {
    id,
    name,
    size: 1234,
    mimeType: name.endsWith(".pdf") ? "application/pdf" : "image/png",
    availability: "persistent",
    storageKey: `projects/artwork/${name}`,
    status: "uploaded",
  };
}

function artworkAssignments(
  entries: readonly (readonly [surfaceId: string, artworkFileId: string])[],
): readonly PrintSurfaceAssignment[] {
  return entries.reduce<readonly PrintSurfaceAssignment[]>(
    (current, [surfaceId, fileId]) => assignArtworkToPrintSurface(
      p86ForArtwork,
      "default",
      current,
      surfaceId,
      fileId,
    ),
    [],
  );
}

async function decorateArtworkScene(
  scene: THREE.Object3D,
  assignments: readonly PrintSurfaceAssignment[],
  files: readonly GraphicFileReference[],
) {
  return applyPrintArtworkOverlays({
    scene,
    printSurfaces: p86ForArtwork.printSurfaces ?? [],
    printSurfaceAssignments: assignments,
    graphicsFiles: files,
    modelUnit: "m",
    resolveArtworkUrl: async (file) => `memory://${file.id}`,
    loadTexture: async () => new THREE.Texture(),
  });
}

function overlayMetadata(mesh: THREE.Mesh): PrintArtworkOverlayMetadata {
  return mesh.userData.hwsPrintArtworkOverlay as PrintArtworkOverlayMetadata;
}

test("artwork FRONT overlay binds only to the explicit back-wall-01 CORE node", async () => {
  const { scene } = await loadModel("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  await decorateArtworkScene(scene, artworkAssignments([["back-wall-01-front", "front-a"]]), [artworkFile("front-a")]);
  const [overlay] = findPrintArtworkOverlays(scene);
  assert.ok(overlay);
  assert.equal(overlay.parent?.name, P86_PRINT_SURFACE_NODE_NAMES.backWall01);
  assert.deepEqual(overlayMetadata(overlay), {
    printSurfaceId: "back-wall-01-front",
    artworkFileId: "front-a",
    nodeName: P86_PRINT_SURFACE_NODE_NAMES.backWall01,
    face: "front",
    localNormalAxis: "-y",
    artworkRightAxis: "+x",
    artworkUpAxis: "+z",
    canonicalWidthMm: 950,
    canonicalHeightMm: 2340,
    sourceWidthPx: 950,
    sourceHeightPx: 2340,
    uvTransform: {
      mode: "stretch",
      scale: 1,
      offsetXmm: 0,
      offsetYmm: 0,
      displayedWidthMm: 950,
      displayedHeightMm: 2340,
      repeatU: 1,
      repeatV: 1,
      offsetU: 0,
      offsetV: 0,
    },
  });
});

test("FRONT and BACK create independent overlays on the same CORE and opposite local faces", async () => {
  const { scene } = await loadModel("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  await decorateArtworkScene(scene, artworkAssignments([
    ["back-wall-01-front", "front-a"],
    ["back-wall-01-back", "back-b"],
  ]), [artworkFile("front-a"), artworkFile("back-b")]);
  const overlays = findPrintArtworkOverlays(scene);
  assert.equal(overlays.length, 2);
  assert.equal(new Set(overlays.map((overlay) => overlay.parent?.name)).size, 1);
  assert.deepEqual(new Set(overlays.map((overlay) => overlayMetadata(overlay).artworkFileId)), new Set(["front-a", "back-b"]));
  const front = overlays.find((overlay) => overlayMetadata(overlay).face === "front")!;
  const back = overlays.find((overlay) => overlayMetadata(overlay).face === "back")!;
  assert.ok(front.geometry.getAttribute("position").getY(0) < 0);
  assert.ok(back.geometry.getAttribute("position").getY(0) > 0);
  assert.ok(front.geometry.getAttribute("normal").getY(0) < -0.999);
  assert.ok(back.geometry.getAttribute("normal").getY(0) > 0.999);
});

test("BACK UV contract reverses local X so artwork is not mirrored from its physical side", async () => {
  const { scene } = await loadModel("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  await decorateArtworkScene(scene, artworkAssignments([
    ["back-wall-01-front", "front-a"],
    ["back-wall-01-back", "back-b"],
  ]), [artworkFile("front-a"), artworkFile("back-b")]);
  const overlays = findPrintArtworkOverlays(scene);
  const front = overlays.find((overlay) => overlayMetadata(overlay).face === "front")!;
  const back = overlays.find((overlay) => overlayMetadata(overlay).face === "back")!;
  const frontPosition = front.geometry.getAttribute("position");
  const backPosition = back.geometry.getAttribute("position");
  assert.ok(frontPosition.getX(1) > frontPosition.getX(0), "FRONT artwork right is local +X");
  assert.ok(backPosition.getX(1) < backPosition.getX(0), "BACK artwork right is local -X");
  assert.deepEqual(Array.from(front.geometry.getAttribute("uv").array), [0, 0, 1, 0, 1, 1, 0, 1]);
  assert.deepEqual(Array.from(back.geometry.getAttribute("uv").array), [0, 0, 1, 0, 1, 1, 0, 1]);
  assert.equal((front.material as THREE.MeshBasicMaterial).map?.flipY, true);
  assert.equal((back.material as THREE.MeshBasicMaterial).map?.flipY, true);
});

test("fascia-print uses the authored fascia FRONT and all overlay dimensions are canonical", async () => {
  const { scene } = await loadModel("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  await decorateArtworkScene(scene, artworkAssignments([
    ["back-wall-01-front", "panel"],
    ["fascia-print", "fascia"],
  ]), [artworkFile("panel"), artworkFile("fascia")]);
  const overlays = findPrintArtworkOverlays(scene);
  const panel = overlays.find((overlay) => overlayMetadata(overlay).printSurfaceId === "back-wall-01-front")!;
  const fascia = overlays.find((overlay) => overlayMetadata(overlay).printSurfaceId === "fascia-print")!;
  assert.equal(fascia.parent?.name, P86_PRINT_SURFACE_NODE_NAMES.fascia);
  assert.equal(overlayMetadata(fascia).face, "front");
  const size = (mesh: THREE.Mesh) => mesh.geometry.boundingBox!.getSize(new THREE.Vector3());
  assert.deepEqual(size(panel).toArray().map((value) => Math.round(value * 1000)), [950, 0, 2340]);
  assert.deepEqual(size(fascia).toArray().map((value) => Math.round(value * 1000)), [2000, 0, 300]);
});

test("re-applying changed artwork disposes the old overlay and never duplicates it", async () => {
  const { scene } = await loadModel("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  await decorateArtworkScene(scene, artworkAssignments([["back-wall-01-front", "old"]]), [artworkFile("old")]);
  const old = findPrintArtworkOverlays(scene)[0]!;
  let geometryDisposed = false;
  let materialDisposed = false;
  let textureDisposed = false;
  old.geometry.addEventListener("dispose", () => { geometryDisposed = true; });
  (old.material as THREE.Material).addEventListener("dispose", () => { materialDisposed = true; });
  (old.material as THREE.MeshBasicMaterial).map!.addEventListener("dispose", () => { textureDisposed = true; });
  await decorateArtworkScene(scene, artworkAssignments([["back-wall-01-front", "new"]]), [artworkFile("new")]);
  const overlays = findPrintArtworkOverlays(scene);
  assert.equal(overlays.length, 1);
  assert.equal(overlayMetadata(overlays[0]!).artworkFileId, "new");
  assert.equal(geometryDisposed, true);
  assert.equal(materialDisposed, true);
  assert.equal(textureDisposed, true);
});

test("removing artwork clears only the overlay and keeps the authored base CORE", async () => {
  const { scene } = await loadModel("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  const assigned = artworkAssignments([["back-wall-01-front", "front-a"]]);
  await decorateArtworkScene(scene, assigned, [artworkFile("front-a")]);
  const base = scene.getObjectByName(P86_PRINT_SURFACE_NODE_NAMES.backWall01)!;
  const withoutArtwork = removeArtworkFromPrintSurface(assigned, "back-wall-01-front");
  await decorateArtworkScene(scene, withoutArtwork, [artworkFile("front-a")]);
  assert.equal(findPrintArtworkOverlays(scene).length, 0);
  assert.equal(scene.getObjectByName(P86_PRINT_SURFACE_NODE_NAMES.backWall01), base);
  assert.equal(withoutArtwork[0]?.artworkFileId, undefined);
  assert.equal(withoutArtwork[0]?.artworkStatus, "missing");
});

test("one graphicsFiles id can decorate multiple explicitly bound surfaces without asset copies", async () => {
  const { scene } = await loadModel("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  const shared = artworkFile("shared");
  await decorateArtworkScene(scene, artworkAssignments([
    ["back-wall-01-front", shared.id],
    ["left-wall-01-front", shared.id],
    ["right-wall-01-back", shared.id],
  ]), [shared]);
  const overlays = findPrintArtworkOverlays(scene);
  assert.equal(overlays.length, 3);
  assert.equal(overlays.every((overlay) => overlayMetadata(overlay).artworkFileId === shared.id), true);
});

test("PDF remains a persisted production source but intentionally creates no 3D overlay", async () => {
  const { scene } = await loadModel("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  const pdf = artworkFile("source-pdf", "panel.pdf");
  const result = await decorateArtworkScene(scene, artworkAssignments([["back-wall-01-front", pdf.id]]), [pdf]);
  assert.deepEqual(result.sourceOnlySurfaceIds, ["back-wall-01-front"]);
  assert.equal(findPrintArtworkOverlays(scene).length, 0);
});

// =========================================================================================
// Visualization v3.2 — Artwork Mask fix (report section 7). A minimal SYNTHETIC scene (never a
// full GLB load) using the real production marker constant, proving findPrintArtworkOverlays'
// discovery contract independent of the koje-2x2 asset: it returns exactly the marked mesh(es),
// never an unrelated sibling mesh, and never anything from the printSurface registry (which has
// no scene presence at all — only PRINT_ARTWORK_OVERLAY_MARKER on a live Object3D matters).
// =========================================================================================

function markedOverlayMesh(name: string): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
  mesh.name = name;
  mesh.userData[PRINT_ARTWORK_OVERLAY_MARKER] = { printSurfaceId: name } satisfies Partial<PrintArtworkOverlayMetadata>;
  return mesh;
}

test("SYNTHETIC SCENE — discovery finds the marked mesh and ignores an unrelated sibling", () => {
  const scene = new THREE.Group();
  const panel = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
  panel.name = "unrelated-panel";
  const overlay = markedOverlayMesh("overlay-a");
  scene.add(panel, overlay);

  const found = findPrintArtworkOverlays(scene);
  assert.equal(found.length, 1);
  assert.equal(found[0], overlay);
  assert.notEqual(found[0], panel);
});

test("SYNTHETIC SCENE — the overlay marker lives on the Mesh itself; a Group carrying it as a CHILD's userData is not conflated with the Group being marked", () => {
  const scene = new THREE.Group();
  const groupWithMarkedChild = new THREE.Group();
  const overlay = markedOverlayMesh("nested-overlay");
  groupWithMarkedChild.add(overlay);
  scene.add(groupWithMarkedChild);

  const found = findPrintArtworkOverlays(scene);
  assert.equal(found.length, 1);
  assert.equal(found[0], overlay);
  assert.equal(groupWithMarkedChild.userData[PRINT_ARTWORK_OVERLAY_MARKER], undefined);
});

test("SYNTHETIC SCENE — MULTIPLE overlays under different parents are all found", () => {
  const scene = new THREE.Group();
  const panelA = new THREE.Object3D();
  const panelB = new THREE.Object3D();
  const overlayA = markedOverlayMesh("overlay-a");
  const overlayB = markedOverlayMesh("overlay-b");
  panelA.add(overlayA);
  panelB.add(overlayB);
  scene.add(panelA, panelB);

  const found = findPrintArtworkOverlays(scene);
  assert.equal(found.length, 2);
  assert.ok(found.includes(overlayA));
  assert.ok(found.includes(overlayB));
});

test("V3.2 ROOT CAUSE, PINNED: hiding an overlay's PARENT stops WebGLRenderer's own scene-graph traversal from ever reaching the overlay child — proves why the artwork-mask pass must never toggle mesh.visible to 'isolate' overlays (report section 2/4). This mirrors three.js's projectObject: `if (object.visible === false) return;` before recursing into children.", () => {
  const scene = new THREE.Group();
  const panel = new THREE.Object3D();
  const overlay = markedOverlayMesh("overlay-under-hidden-panel");
  panel.add(overlay);
  scene.add(panel);

  panel.visible = false;

  const visited: THREE.Object3D[] = [];
  const projectObject = (object: THREE.Object3D) => {
    if (object.visible === false) return;
    visited.push(object);
    for (const child of object.children) projectObject(child);
  };
  projectObject(scene);

  assert.ok(!visited.includes(overlay), "hiding the panel must have prevented the renderer from ever visiting its overlay child");
  // findPrintArtworkOverlays itself is unaffected (it's a plain traverse, not a renderer walk) —
  // the bug was specific to how the OLD artwork-mask pass abused Object3D.visible, not discovery.
  assert.equal(findPrintArtworkOverlays(scene).length, 1);
});

test("ARTWORK MASK MATERIAL CONTRACT: createArtworkMaskMaterial binds the given texture, keeps depth test/write on (occlusion must match Beauty — report section 4), and is a distinct program from the beauty material (own onBeforeCompile/cache key, so it can't silently render the artwork's real colors instead of a flat mask)", () => {
  const texture = new THREE.Texture();
  const maskMaterial = createArtworkMaskMaterial(texture);
  assert.equal(maskMaterial.map, texture);
  assert.equal(maskMaterial.depthTest, true);
  assert.equal(maskMaterial.depthWrite, true);
  assert.equal(typeof maskMaterial.onBeforeCompile, "function");
  assert.equal(maskMaterial.customProgramCacheKey(), "hws-artwork-mask-alpha-v1");

  const fakeShader = { fragmentShader: "#include <map_fragment>" };
  maskMaterial.onBeforeCompile(fakeShader as never, undefined as never);
  assert.match(fakeShader.fragmentShader, /discard/u);
  assert.match(fakeShader.fragmentShader, /hwsArtworkSample\.a </u, "must gate on the texture's OWN alpha channel, not render the full rectangular quad unconditionally");
  assert.match(fakeShader.fragmentShader, /diffuseColor = vec4\(1\.0, 1\.0, 1\.0, 1\.0\)/u, "visible artwork pixels must become flat opaque white, never the artwork's real color");
});

test("artwork project save/load keeps stable file id and FRONT/BACK assignment links", () => {
  const assignments = artworkAssignments([
    ["back-wall-01-front", "front-a"],
    ["back-wall-01-back", "back-b"],
  ]);
  const project = createProjectRecord({
    id: "p86-artwork-roundtrip",
    boothId: p86ForArtwork.id,
    graphicsFiles: [artworkFile("front-a"), artworkFile("back-b")],
    printSurfaceAssignments: assignments,
  });
  const reloaded = normalizeProjectRecord(JSON.parse(JSON.stringify(project)));
  assert.deepEqual(reloaded.graphicsFiles.map((file) => file.id), ["front-a", "back-b"]);
  assert.deepEqual(reloaded.printSurfaceAssignments.map((assignment) => [assignment.printSurfaceId, assignment.artworkFileId]), [
    ["back-wall-01-front", "front-a"],
    ["back-wall-01-back", "back-b"],
  ]);
});

test("legacy project with no graphicsFiles or panel assignments remains empty and valid", () => {
  const legacy = normalizeProjectRecord({ id: "legacy-without-artwork", boothId: p86ForArtwork.id });
  assert.deepEqual(legacy.graphicsFiles, []);
  assert.deepEqual(legacy.printSurfaceAssignments, []);
});

test("Graphics UI groups canonical surfaces and reuses graphicsFiles/artworkFileId upload flow", () => {
  const panelSource = readFileSync("components/configurator/GraphicsSurfacePanel.tsx", "utf8");
  const generatorSource = readFileSync("components/BoothGenerator.tsx", "utf8");
  for (const label of ["Zadní stěna", "Levá stěna", "Pravá stěna", "Límec"]) {
    assert.ok(P86_CANONICAL_PRINT_SURFACES.some((surface) => surface.group?.name === label));
  }
  assert.match(panelSource, /surface\.group\?\.name/u);
  assert.match(panelSource, /surface\.sceneBinding\?\.face === "back"/u);
  assert.match(panelSource, /950|surface\.widthMm/u);
  assert.match(panelSource, /onAssignExisting\(surface\.id, event\.target\.value\)/u);
  // Graphics Export v1: uploadAsset now also passes a surface-derived displayName (report
  // section 1) — the category/ownerId upload target itself is unchanged.
  assert.match(generatorSource, /uploadAsset\(file, \{ category: "project-graphics", ownerId, displayName \}/u);
  assert.match(generatorSource, /assignArtworkToPrintSurface\([\s\S]*?additions\[0\]!\.id/u);
  assert.match(panelSource, /\["stretch", "fit", "fill"\]/u);
  assert.match(panelSource, /offsetXmm/u);
  assert.match(panelSource, /offsetYmm/u);
  assert.match(panelSource, />Reset</u);
  assert.match(panelSource, /file && isRasterArtworkFile\(file\) && assignment/u);
  assert.match(generatorSource, /readRasterImageDimensions\(file\)/u);
  assert.match(generatorSource, /widthPx: dimensions\?\.widthPx/u);
  assert.match(generatorSource, /heightPx: dimensions\?\.heightPx/u);
  assert.doesNotMatch(generatorSource, /graphicAssets|artworkAssets|graphicUploads/u);
});

test("Graphics placement controls are compact by default and expand independently per surface", () => {
  const panelSource = readFileSync("components/configurator/GraphicsSurfacePanel.tsx", "utf8");
  assert.match(panelSource, /useState<ReadonlySet<string>>\(\s*\(\) => new Set\(\)/u);
  assert.match(panelSource, /const next = new Set\(current\)/u);
  assert.match(panelSource, /if \(next\.has\(surfaceId\)\) next\.delete\(surfaceId\);\s*else next\.add\(surfaceId\)/u);
  assert.match(panelSource, /expandedSurfaceIds\.has\(surface\.id\)/u);
  assert.match(panelSource, /graphicsPlacementSummary/u);
  assert.match(panelSource, /placementModeLabel\}[\s\S]*?Math\.round\(placement\.scale \* 100\)[\s\S]*?X \{placement\.offsetXmm\}[\s\S]*?Y \{placement\.offsetYmm\}/u);
  assert.match(panelSource, /aria-expanded=\{isPlacementExpanded\}/u);
  assert.match(panelSource, /\{isPlacementExpanded && \(\s*<div className="graphicsPlacementControls"/u);
  assert.match(panelSource, /\["stretch", "fit", "fill"\]/u);
  assert.match(panelSource, /artworkPlacementForMode\("stretch"\)[\s\S]*?>Reset</u);
});

test("legacy artworkPlacement absence is exactly the v1 Stretch mapping", () => {
  const legacy = calculateArtworkUvTransform({
    surfaceWidthMm: 950,
    surfaceHeightMm: 2340,
    sourceWidthPx: 1600,
    sourceHeightPx: 900,
  });
  assert.deepEqual(legacy, {
    ...DEFAULT_ARTWORK_PLACEMENT,
    displayedWidthMm: 950,
    displayedHeightMm: 2340,
    repeatU: 1,
    repeatV: 1,
    offsetU: 0,
    offsetV: 0,
  });
});

test("Fit preserves source aspect ratio and keeps the complete artwork inside the surface", () => {
  const fit = calculateArtworkUvTransform({
    surfaceWidthMm: 950,
    surfaceHeightMm: 2340,
    sourceWidthPx: 1600,
    sourceHeightPx: 900,
    placement: artworkPlacementForMode("fit"),
  });
  assert.ok(fit.displayedWidthMm <= 950 && fit.displayedHeightMm <= 2340);
  assert.ok(Math.abs(fit.displayedWidthMm / fit.displayedHeightMm - 1600 / 900) < 1e-12);
  assert.equal(fit.displayedWidthMm, 950);
  assert.ok(fit.repeatV > 1, "UV outside the image is clipped and reveals the base panel");
});

test("Fill preserves aspect ratio, fills the surface and crops from the exact center", () => {
  const fill = calculateArtworkUvTransform({
    surfaceWidthMm: 950,
    surfaceHeightMm: 2340,
    sourceWidthPx: 1600,
    sourceHeightPx: 900,
    placement: artworkPlacementForMode("fill"),
  });
  assert.ok(fill.displayedWidthMm >= 950 && fill.displayedHeightMm >= 2340);
  assert.ok(Math.abs(fill.displayedWidthMm / fill.displayedHeightMm - 1600 / 900) < 1e-12);
  assert.equal(fill.displayedHeightMm, 2340);
  assert.ok(Math.abs(fill.offsetU - (1 - fill.repeatU) / 2) < 1e-12);
  assert.equal(fill.offsetV, 0);
});

test("physical X/Y offsets affect only their matching UV axis", () => {
  const base = calculateArtworkUvTransform({ surfaceWidthMm: 950, surfaceHeightMm: 2340, sourceWidthPx: 1000, sourceHeightPx: 1000, placement: artworkPlacementForMode("fit") });
  const x = calculateArtworkUvTransform({ surfaceWidthMm: 950, surfaceHeightMm: 2340, sourceWidthPx: 1000, sourceHeightPx: 1000, placement: { ...artworkPlacementForMode("fit"), offsetXmm: 100 } });
  const y = calculateArtworkUvTransform({ surfaceWidthMm: 950, surfaceHeightMm: 2340, sourceWidthPx: 1000, sourceHeightPx: 1000, placement: { ...artworkPlacementForMode("fit"), offsetYmm: 100 } });
  assert.notEqual(x.offsetU, base.offsetU);
  assert.equal(x.offsetV, base.offsetV);
  assert.equal(y.offsetU, base.offsetU);
  assert.notEqual(y.offsetV, base.offsetV);
});

test("custom scale is a uniform multiplier over the selected Fit/Fill base", () => {
  const base = calculateArtworkUvTransform({ surfaceWidthMm: 950, surfaceHeightMm: 2340, sourceWidthPx: 1600, sourceHeightPx: 900, placement: artworkPlacementForMode("fill") });
  const zoomed = calculateArtworkUvTransform({ surfaceWidthMm: 950, surfaceHeightMm: 2340, sourceWidthPx: 1600, sourceHeightPx: 900, placement: { ...artworkPlacementForMode("fill"), scale: 2 } });
  assert.equal(zoomed.displayedWidthMm, base.displayedWidthMm * 2);
  assert.equal(zoomed.displayedHeightMm, base.displayedHeightMm * 2);
  assert.equal(zoomed.repeatU, base.repeatU / 2);
  assert.equal(zoomed.repeatV, base.repeatV / 2);
});

test("fascia uses the same placement math and fixed-quad clipping shader as panel faces", async () => {
  const { scene } = await loadModel("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  const file = { ...artworkFile("fascia-wide"), widthPx: 1000, heightPx: 1000 };
  const assignment = updatePrintSurfaceArtworkPlacement(
    artworkAssignments([["fascia-print", file.id]]),
    "fascia-print",
    artworkPlacementForMode("fit"),
  );
  await decorateArtworkScene(scene, assignment, [file]);
  const overlay = findPrintArtworkOverlays(scene)[0]!;
  const metadata = overlayMetadata(overlay);
  assert.equal(metadata.printSurfaceId, "fascia-print");
  assert.equal(metadata.uvTransform.mode, "fit");
  assert.equal(metadata.uvTransform.displayedWidthMm, 300);
  assert.equal(metadata.uvTransform.displayedHeightMm, 300);
  assert.match((overlay.material as THREE.MeshBasicMaterial).customProgramCacheKey(), /surface-clip/u);
});

test("one graphics file has independent placement per assignment", async () => {
  const { scene } = await loadModel("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  const shared = { ...artworkFile("shared-placement"), widthPx: 1600, heightPx: 900 };
  let assignments = artworkAssignments([
    ["back-wall-01-front", shared.id],
    ["left-wall-01-front", shared.id],
  ]);
  assignments = updatePrintSurfaceArtworkPlacement(assignments, "back-wall-01-front", { mode: "fill", scale: 1.4, offsetXmm: 120, offsetYmm: -40 });
  assignments = updatePrintSurfaceArtworkPlacement(assignments, "left-wall-01-front", artworkPlacementForMode("fit"));
  await decorateArtworkScene(scene, assignments, [shared]);
  const metadata = findPrintArtworkOverlays(scene).map(overlayMetadata);
  assert.deepEqual(metadata.find((item) => item.printSurfaceId === "back-wall-01-front")!.uvTransform.mode, "fill");
  assert.deepEqual(metadata.find((item) => item.printSurfaceId === "left-wall-01-front")!.uvTransform.mode, "fit");
  assert.equal(assignments[0]?.artworkFileId, assignments[1]?.artworkFileId);
});

test("placement update reuses the live overlay texture and does not rebuild the booth scene", async () => {
  const { scene } = await loadModel("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  const file = { ...artworkFile("live-placement"), widthPx: 1600, heightPx: 900 };
  const initial = artworkAssignments([["back-wall-01-front", file.id]]);
  let textureLoads = 0;
  const apply = (assignments: readonly PrintSurfaceAssignment[]) => applyPrintArtworkOverlays({
    scene,
    printSurfaces: p86ForArtwork.printSurfaces ?? [],
    printSurfaceAssignments: assignments,
    graphicsFiles: [file],
    modelUnit: "m",
    resolveArtworkUrl: async () => "memory://live-placement",
    loadTexture: async () => { textureLoads += 1; return new THREE.Texture(); },
  });
  await apply(initial);
  const firstOverlay = findPrintArtworkOverlays(scene)[0]!;
  const firstTexture = (firstOverlay.material as THREE.MeshBasicMaterial).map;
  await apply(updatePrintSurfaceArtworkPlacement(initial, "back-wall-01-front", { mode: "fill", scale: 1.2, offsetXmm: 25, offsetYmm: 50 }));
  const secondOverlay = findPrintArtworkOverlays(scene)[0]!;
  assert.equal(secondOverlay, firstOverlay);
  assert.equal((secondOverlay.material as THREE.MeshBasicMaterial).map, firstTexture);
  assert.equal(textureLoads, 1);
  assert.equal(overlayMetadata(secondOverlay).uvTransform.offsetYmm, 50);
});

test("placement and raster dimensions persist, while Reset keeps artworkFileId assigned", () => {
  const file = { ...artworkFile("persist-placement"), widthPx: 2400, heightPx: 1600 };
  const assigned = updatePrintSurfaceArtworkPlacement(
    artworkAssignments([["back-wall-01-front", file.id]]),
    "back-wall-01-front",
    { mode: "fill", scale: 1.3, offsetXmm: 80, offsetYmm: -35 },
  );
  const reloaded = normalizeProjectRecord(JSON.parse(JSON.stringify(createProjectRecord({
    id: "placement-roundtrip",
    graphicsFiles: [file],
    printSurfaceAssignments: assigned,
  }))));
  assert.equal(reloaded.graphicsFiles[0]?.id, file.id);
  assert.equal(reloaded.graphicsFiles[0]?.widthPx, 2400);
  assert.equal(reloaded.graphicsFiles[0]?.heightPx, 1600);
  assert.deepEqual(reloaded.printSurfaceAssignments[0]?.artworkPlacement, { mode: "fill", scale: 1.3, offsetXmm: 80, offsetYmm: -35 });
  const reset = updatePrintSurfaceArtworkPlacement(reloaded.printSurfaceAssignments, "back-wall-01-front", artworkPlacementForMode("stretch"));
  assert.deepEqual(reset[0]?.artworkPlacement, DEFAULT_ARTWORK_PLACEMENT);
  assert.equal(reset[0]?.artworkFileId, file.id);
});

test("placement normalization clamps scale and rejects non-finite offsets", () => {
  assert.deepEqual(normalizeArtworkPlacement({
    mode: "fit",
    scale: MAX_ARTWORK_SCALE + 10,
    offsetXmm: Number.NaN,
    offsetYmm: Number.POSITIVE_INFINITY,
  }), {
    mode: "fit",
    scale: MAX_ARTWORK_SCALE,
    offsetXmm: 0,
    offsetYmm: 0,
  });
  assert.equal(normalizeArtworkPlacement({
    mode: "fill",
    scale: 0,
    offsetXmm: 0,
    offsetYmm: 0,
  }).scale, MIN_ARTWORK_SCALE);
});

test("physical millimeter offsets have a precise, viewport-independent UV mapping", () => {
  const moved = calculateArtworkUvTransform({
    surfaceWidthMm: 1000,
    surfaceHeightMm: 1000,
    sourceWidthPx: 1000,
    sourceHeightPx: 1000,
    placement: { mode: "stretch", scale: 1, offsetXmm: 100, offsetYmm: -50 },
  });
  assert.equal(moved.offsetU, -0.1);
  assert.equal(moved.offsetV, 0.05);
});

test("Stretch remains the legacy base while manual zoom is clipped on the fixed surface quad", () => {
  const zoomed = calculateArtworkUvTransform({
    surfaceWidthMm: 950,
    surfaceHeightMm: 2340,
    sourceWidthPx: 1600,
    sourceHeightPx: 900,
    placement: { mode: "stretch", scale: 2, offsetXmm: 0, offsetYmm: 0 },
  });
  assert.equal(zoomed.displayedWidthMm, 1900);
  assert.equal(zoomed.displayedHeightMm, 4680);
  assert.equal(zoomed.repeatU, 0.5);
  assert.equal(zoomed.repeatV, 0.5);
  assert.equal(zoomed.offsetU, 0.25);
  assert.equal(zoomed.offsetV, 0.25);
});

test("renderer can recover real raster dimensions from the loaded texture for older file metadata", async () => {
  const { scene } = await loadModel("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  const file = artworkFile("legacy-raster-dimensions");
  const assignments = updatePrintSurfaceArtworkPlacement(
    artworkAssignments([["back-wall-01-front", file.id]]),
    "back-wall-01-front",
    artworkPlacementForMode("fit"),
  );
  await applyPrintArtworkOverlays({
    scene,
    printSurfaces: p86ForArtwork.printSurfaces ?? [],
    printSurfaceAssignments: assignments,
    graphicsFiles: [file],
    modelUnit: "m",
    resolveArtworkUrl: async () => "memory://legacy-raster-dimensions",
    loadTexture: async () => {
      const texture = new THREE.Texture();
      texture.image = { width: 1600, height: 900 };
      return texture;
    },
  });
  const metadata = overlayMetadata(findPrintArtworkOverlays(scene)[0]!);
  assert.equal(metadata.sourceWidthPx, 1600);
  assert.equal(metadata.sourceHeightPx, 900);
  assert.equal(metadata.uvTransform.mode, "fit");
});

test("PDF remains an assigned production source but never creates a placement overlay", async () => {
  const { scene } = await loadModel("public/models/booths/koje-2x2/HWS_BOOTH_KOJE_2000x2000.glb");
  const pdf: GraphicFileReference = {
    ...artworkFile("production-pdf"),
    name: "production.pdf",
    mimeType: "application/pdf",
  };
  const assignments = artworkAssignments([["back-wall-01-front", pdf.id]]);
  const result = await applyPrintArtworkOverlays({
    scene,
    printSurfaces: p86ForArtwork.printSurfaces ?? [],
    printSurfaceAssignments: assignments,
    graphicsFiles: [pdf],
    modelUnit: "m",
    resolveArtworkUrl: async () => "memory://production-pdf",
    loadTexture: async () => { throw new Error("PDF texture must not load"); },
  });
  assert.deepEqual(result.sourceOnlySurfaceIds, ["back-wall-01-front"]);
  assert.equal(findPrintArtworkOverlays(scene).length, 0);
});

test("Reset changes only the requested surface placement and keeps both artwork links", () => {
  const sharedFileId = "shared-reset";
  let assignments = artworkAssignments([
    ["back-wall-01-front", sharedFileId],
    ["left-wall-01-front", sharedFileId],
  ]);
  assignments = updatePrintSurfaceArtworkPlacement(assignments, "back-wall-01-front", {
    mode: "fill", scale: 1.5, offsetXmm: 40, offsetYmm: -20,
  });
  assignments = updatePrintSurfaceArtworkPlacement(assignments, "left-wall-01-front", artworkPlacementForMode("fit"));
  const reset = updatePrintSurfaceArtworkPlacement(assignments, "back-wall-01-front", artworkPlacementForMode("stretch"));
  assert.deepEqual(reset[0]?.artworkPlacement, DEFAULT_ARTWORK_PLACEMENT);
  assert.deepEqual(reset[1]?.artworkPlacement, artworkPlacementForMode("fit"));
  assert.deepEqual(reset.map((assignment) => assignment.artworkFileId), [sharedFileId, sharedFileId]);
});
