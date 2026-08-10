"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  CAD_TO_VIEWER_ROTATION_X_RAD,
  SCENE_UNITS_PER_MILLIMETER,
  getComponentModel,
  mmToSceneUnits,
  placedComponentToViewerTransform,
} from "../../domain/cad3d";
import type { CadModelAsset, PlacedComponent } from "../../domain/models";

type BoothCadViewerProps = {
  asset?: CadModelAsset;
  footprintWidthMm: number;
  footprintDepthMm: number;
  components: readonly PlacedComponent[];
};

type ModelDimensionsMm = {
  width: number;
  depth: number;
  height: number;
};

function disposeObject(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();

    const materials = Array.isArray(mesh.material)
      ? mesh.material
      : mesh.material
        ? [mesh.material]
        : [];

    materials.forEach((material) => {
      Object.values(material).forEach((value) => {
        if (value instanceof THREE.Texture) {
          value.dispose();
        }
      });
      material.dispose();
    });
  });
}

function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  object: THREE.Object3D,
) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) {
    return;
  }

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const verticalFov = THREE.MathUtils.degToRad(camera.fov);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * camera.aspect);
  const limitingFov = Math.min(verticalFov, horizontalFov);
  const distance = Math.max(
    0.5,
    (sphere.radius / Math.sin(limitingFov / 2)) * 1.15,
  );
  const isometricDirection = new THREE.Vector3(1, 0.78, 1).normalize();

  camera.position.copy(sphere.center).addScaledVector(isometricDirection, distance);
  camera.near = Math.max(0.001, distance / 100);
  camera.far = Math.max(100, distance * 100);
  camera.updateProjectionMatrix();

  controls.target.copy(sphere.center);
  controls.minDistance = Math.max(0.05, sphere.radius * 0.12);
  controls.maxDistance = Math.max(20, sphere.radius * 20);
  controls.update();
}

export function BoothCadViewer({
  asset,
  footprintWidthMm,
  footprintDepthMm,
  components,
}: BoothCadViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const fitViewRef = useRef<() => void>(() => undefined);
  const [loadingProgress, setLoadingProgress] = useState<number | null>(0);
  const [error, setError] = useState("");
  const [componentLoadError, setComponentLoadError] = useState(false);
  const [pendingComponents, setPendingComponents] = useState(0);
  const [modelDimensions, setModelDimensions] =
    useState<ModelDimensionsMm | null>(null);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !asset) {
      setLoadingProgress(null);
      setError("3D model není pro tuto sestavu dostupný.");
      return;
    }

    if (asset.axisSystem !== "x-right-y-depth-z-up" || asset.unit !== "mm") {
      setLoadingProgress(null);
      setError("3D model používá nepodporovaný souřadný systém nebo jednotky.");
      return;
    }

    let active = true;
    let animationFrame = 0;
    const loadedModels: THREE.Object3D[] = [];

    setError("");
    setComponentLoadError(false);
    setModelDimensions(null);
    setLoadingProgress(0);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f5f5);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch (reason) {
      console.error("WebGL renderer initialization failed", reason);
      setLoadingProgress(null);
      setError("3D náhled není na tomto zařízení dostupný.");
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.domElement.className = "cadViewerCanvas";
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.07;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;

    const content = new THREE.Group();
    scene.add(content);
    const furniture = new THREE.Group();
    furniture.name = "Placed project components";
    content.add(furniture);

    const carpet = new THREE.Mesh(
      new THREE.PlaneGeometry(
        mmToSceneUnits(footprintWidthMm),
        mmToSceneUnits(footprintDepthMm),
      ),
      new THREE.MeshStandardMaterial({
        color: 0xc9c6bf,
        roughness: 0.92,
        metalness: 0,
        side: THREE.DoubleSide,
      }),
    );
    carpet.name = `Reference carpet ${footprintWidthMm} × ${footprintDepthMm} mm`;
    carpet.rotation.x = -Math.PI / 2;
    carpet.position.set(
      mmToSceneUnits(footprintWidthMm) / 2,
      -0.002,
      -mmToSceneUnits(footprintDepthMm) / 2,
    );
    content.add(carpet);

    scene.add(new THREE.HemisphereLight(0xffffff, 0x9ba0a3, 2.15));
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.7);
    keyLight.position.set(4, 7, 5);
    scene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xdde7ee, 1.2);
    fillLight.position.set(-4, 3, -5);
    scene.add(fillLight);

    const resize = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(mount);

    const fitView = () => fitCameraToObject(camera, controls, content);
    fitViewRef.current = fitView;

    const loader = new GLTFLoader();
    loader.load(
      asset.url,
      (gltf) => {
        if (!active) {
          disposeObject(gltf.scene);
          return;
        }

        const cadBounds = new THREE.Box3().setFromObject(gltf.scene);
        const cadSize = cadBounds.getSize(new THREE.Vector3());
        setModelDimensions({
          width: cadSize.x,
          depth: cadSize.y,
          height: cadSize.z,
        });

        // Central CAD boundary: mm -> meters and Z-up -> Three.js Y-up.
        gltf.scene.scale.setScalar(SCENE_UNITS_PER_MILLIMETER);
        gltf.scene.rotation.x = CAD_TO_VIEWER_ROTATION_X_RAD;
        gltf.scene.updateMatrixWorld(true);
        loadedModels.push(gltf.scene);
        content.add(gltf.scene);

        setLoadingProgress(null);
        fitView();
      },
      (event) => {
        if (!active) {
          return;
        }
        setLoadingProgress(
          event.total > 0 ? Math.round((event.loaded / event.total) * 100) : 0,
        );
      },
      (reason) => {
        if (!active) {
          return;
        }
        console.error("CAD model load failed", reason);
        setLoadingProgress(null);
        setError("3D model se nepodařilo načíst.");
        fitView();
      },
    );

    const componentModels = components.flatMap((component) => {
      const model = getComponentModel(component.assets);
      return component.visible && model ? [{ component, model }] : [];
    });
    setPendingComponents(componentModels.length);

    componentModels.forEach(({ component, model }) => {
      new GLTFLoader().load(
        model.url,
        (gltf) => {
          if (!active) {
            disposeObject(gltf.scene);
            return;
          }

          gltf.scene.scale.setScalar(SCENE_UNITS_PER_MILLIMETER);
          gltf.scene.rotation.x = CAD_TO_VIEWER_ROTATION_X_RAD;
          gltf.scene.updateMatrixWorld(true);

          if (model.anchor === "footprint-center-floor") {
            const bounds = new THREE.Box3().setFromObject(gltf.scene);
            const center = bounds.getCenter(new THREE.Vector3());
            gltf.scene.position.x -= center.x;
            gltf.scene.position.y -= bounds.min.y;
            gltf.scene.position.z -= center.z;
          }

          const transform = placedComponentToViewerTransform(component);
          const instance = new THREE.Group();
          instance.name = component.id;
          instance.position.set(
            transform.position.x,
            transform.position.y,
            transform.position.z,
          );
          instance.rotation.y = transform.rotationYRad;
          instance.add(gltf.scene);
          furniture.add(instance);
          loadedModels.push(gltf.scene);

          setPendingComponents((count) => Math.max(0, count - 1));
          fitView();
        },
        undefined,
        (reason) => {
          if (!active) {
            return;
          }
          console.error(`Component model load failed: ${component.id}`, reason);
          setComponentLoadError(true);
          setPendingComponents((count) => Math.max(0, count - 1));
        },
      );
    });

    fitView();

    const render = () => {
      controls.update();
      renderer.render(scene, camera);
      animationFrame = window.requestAnimationFrame(render);
    };
    render();

    return () => {
      active = false;
      window.cancelAnimationFrame(animationFrame);
      resizeObserver.disconnect();
      controls.dispose();
      fitViewRef.current = () => undefined;
      disposeObject(carpet);
      loadedModels.forEach(disposeObject);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [asset, components, footprintDepthMm, footprintWidthMm]);

  return (
    <div className="cadViewer">
      <div ref={mountRef} className="cadViewerMount" />

      <div className="cadViewerToolbar">
        <button type="button" onClick={() => fitViewRef.current()}>
          Fit model
        </button>
        <span>Levý tah: orbit · Pravý tah: pan · Kolečko: zoom</span>
      </div>

      {(loadingProgress !== null || pendingComponents > 0) && (
        <div className="cadViewerState" role="status">
          <span className="cadViewerSpinner" aria-hidden="true" />
          Načítání CAD scény
          {loadingProgress !== null && loadingProgress > 0
            ? ` ${loadingProgress} %`
            : "…"}
        </div>
      )}

      {error && (
        <div className="cadViewerState cadViewerError" role="alert">
          {error}
        </div>
      )}

      {componentLoadError && !error && (
        <div className="cadViewerComponentError" role="status">
          Některý model mobiliáře se nepodařilo načíst.
        </div>
      )}

      {modelDimensions && !error && (
        <div className="cadViewerDimensions">
          MASTER · {Math.round(modelDimensions.width)} ×{" "}
          {Math.round(modelDimensions.depth)} ×{" "}
          {Math.round(modelDimensions.height)} mm
        </div>
      )}
    </div>
  );
}
