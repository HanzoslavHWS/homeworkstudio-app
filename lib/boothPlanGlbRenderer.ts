import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  applyBoothModelTransform,
  createTopDownBoothPlanFrame,
} from "../domain/cad3d.ts";
import type {
  BoothAssetDefinition,
  CadModelAsset,
} from "../domain/models.ts";

export type BoothPlanGlbRenderInput = Readonly<{
  asset: CadModelAsset;
  boothAsset?: BoothAssetDefinition;
  constructionVisibility: Readonly<Record<string, boolean>>;
  footprintWidthMm: number;
  footprintDepthMm: number;
  visible: boolean;
}>;

export function disposeBoothPlanModel(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = (object as THREE.LineSegments).material ?? mesh.material;
    const materials = Array.isArray(material)
      ? material
      : material
        ? [material]
        : [];
    materials.forEach((item) => item.dispose());
  });
}

export function createBoothPlanCamera(
  footprintWidthMm: number,
  footprintDepthMm: number,
  originConvention: BoothAssetDefinition["originConvention"] | undefined,
): THREE.OrthographicCamera {
  const frame = createTopDownBoothPlanFrame(
    footprintWidthMm,
    footprintDepthMm,
    originConvention,
  );
  const camera = new THREE.OrthographicCamera(
    frame.left,
    frame.right,
    frame.top,
    frame.bottom,
    0.01,
    20,
  );
  camera.position.set(frame.cameraCenterX, 10, frame.cameraCenterZ);
  camera.up.set(0, 0, -1);
  camera.lookAt(frame.cameraCenterX, 0, frame.cameraCenterZ);
  camera.updateProjectionMatrix();
  return camera;
}

/**
 * One GLB loading/preparation path for both the live configurator and the standalone 2D output.
 * It preserves the authored hierarchy/origin and delegates units plus assembly visibility to the
 * same transform boundary as the perspective 3D viewer.
 */
export async function loadBoothPlanModel(
  input: BoothPlanGlbRenderInput,
): Promise<THREE.Object3D> {
  const model = await new GLTFLoader().loadAsync(input.asset.url);
  applyBoothModelTransform(
    model.scene,
    input.asset,
    input.boothAsset,
    input.constructionVisibility,
    input.visible,
  );

  model.scene.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const originalMaterials = Array.isArray(mesh.material)
      ? mesh.material
      : [mesh.material];
    originalMaterials.forEach((material) => material.dispose());
    mesh.material = new THREE.MeshBasicMaterial({
      color: 0x858b8f,
      transparent: true,
      opacity: 0.5,
      side: THREE.DoubleSide,
    });
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(mesh.geometry, 18),
      new THREE.LineBasicMaterial({
        color: 0x4f565a,
        transparent: true,
        opacity: 0.78,
      }),
    );
    edges.name = "CAD plan edges";
    mesh.add(edges);
  });

  return model.scene;
}

export type RenderedBoothPlanGlb = Readonly<{
  canvas: HTMLCanvasElement;
  dispose: () => void;
}>;

/** Dedicated offscreen render; it never reads or captures the live configurator canvas. */
export async function renderBoothPlanGlbToCanvas(
  input: BoothPlanGlbRenderInput,
  widthPx: number,
  heightPx: number,
): Promise<RenderedBoothPlanGlb> {
  let model: THREE.Object3D | undefined;
  let renderer: THREE.WebGLRenderer | undefined;
  try {
    model = await loadBoothPlanModel(input);
    const scene = new THREE.Scene();
    scene.add(model);
    const camera = createBoothPlanCamera(
      input.footprintWidthMm,
      input.footprintDepthMm,
      input.boothAsset?.originConvention,
    );
    renderer = new THREE.WebGLRenderer({
      alpha: true,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.setClearColor(0x000000, 0);
    renderer.setSize(Math.max(1, widthPx), Math.max(1, heightPx), false);
    renderer.render(scene, camera);

    const renderedModel = model;
    const renderedRenderer = renderer;
    return {
      canvas: renderedRenderer.domElement,
      dispose: () => {
        disposeBoothPlanModel(renderedModel);
        renderedRenderer.dispose();
      },
    };
  } catch (error) {
    if (model) disposeBoothPlanModel(model);
    renderer?.dispose();
    throw error;
  }
}
