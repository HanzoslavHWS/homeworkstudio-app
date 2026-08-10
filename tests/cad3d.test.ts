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
} from "../domain/cad3d.ts";

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
  assert.equal(componentCatalog.chair.name, "Židle");
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
