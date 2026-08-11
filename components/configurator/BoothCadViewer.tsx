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
import type {
  CadModelAsset,
  FinishVariant,
  NominalDimensions,
  PrintSurface,
  PartDefinition,
  PlacedComponent,
} from "../../domain/models";
import { constructionMaterialOverrides } from "../../domain/materialOverrides";
import type { CameraViewDefinition } from "../../domain/models";
import type { SavedCameraView } from "../../domain/project";

type BoothCadViewerProps = {
  asset?: CadModelAsset;
  footprintWidthMm: number;
  footprintDepthMm: number;
  components: readonly PlacedComponent[];
  defaultViews?: readonly CameraViewDefinition[];
  savedViews?: readonly SavedCameraView[];
  onSaveView?: (view: Omit<SavedCameraView, "id" | "createdAt">) => void;
  onDeleteView?: (viewId: string) => void;
  onCapture?: (capture: {
    imageDataUrl: string;
    view: Omit<SavedCameraView, "id" | "createdAt">;
  }) => void;
  carpetFinish?: FinishVariant;
  constructionFinish?: FinishVariant;
  partDefinitions?: readonly PartDefinition[];
  nominalDimensions?: NominalDimensions;
  printSurfaces?: readonly PrintSurface[];
  showPrintPlaceholder?: boolean;
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
  defaultViews = [],
  savedViews = [],
  onSaveView,
  onDeleteView,
  onCapture,
  carpetFinish,
  constructionFinish,
  partDefinitions,
  nominalDimensions,
  printSurfaces = [],
  showPrintPlaceholder = false,
}: BoothCadViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const fitViewRef = useRef<() => void>(() => undefined);
  const applyViewRef = useRef<(view: CameraViewDefinition) => void>(
    () => undefined,
  );
  const currentViewRef = useRef<
    () => Omit<SavedCameraView, "id" | "createdAt">
  >(() => ({ name: "Pohled", position: [0, 0, 0], target: [0, 0, 0] }));
  const captureRef = useRef<() => string | null>(() => null);
  const [loadingProgress, setLoadingProgress] = useState<number | null>(0);
  const [error, setError] = useState("");
  const [componentLoadError, setComponentLoadError] = useState(false);
  const [pendingComponents, setPendingComponents] = useState(0);
  const [modelDimensions, setModelDimensions] =
    useState<ModelDimensionsMm | null>(null);
  const [showDimensions, setShowDimensions] = useState(false);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return;
    }

    if (
      asset &&
      (asset.axisSystem !== "x-right-y-depth-z-up" || asset.unit !== "mm")
    ) {
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
    setLoadingProgress(asset ? 0 : null);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf4f5f5);

    const camera = new THREE.PerspectiveCamera(38, 1, 0.01, 100);
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({
        antialias: true,
        preserveDrawingBuffer: true,
      });
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

    let carpet: THREE.Mesh | undefined;
    if (carpetFinish && carpetFinish.id !== "none") {
      carpet = new THREE.Mesh(
        new THREE.PlaneGeometry(
          mmToSceneUnits(footprintWidthMm),
          mmToSceneUnits(footprintDepthMm),
        ),
        new THREE.MeshStandardMaterial({
          color: carpetFinish.swatchColor ?? "#c9c6bf",
          roughness: 0.92,
          metalness: 0,
          side: THREE.DoubleSide,
        }),
      );
      carpet.name = `Carpet ${carpetFinish.name}`;
      carpet.rotation.x = -Math.PI / 2;
      carpet.position.set(
        mmToSceneUnits(footprintWidthMm) / 2,
        -0.002,
        -mmToSceneUnits(footprintDepthMm) / 2,
      );
      content.add(carpet);
    }

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
    applyViewRef.current = (view) => {
      camera.position.fromArray(view.position);
      controls.target.fromArray(view.target);
      if (view.fov !== undefined) camera.fov = view.fov;
      camera.updateProjectionMatrix();
      controls.update();
    };
    currentViewRef.current = () => ({
      name: "Vlastní pohled",
      position: camera.position.toArray() as [number, number, number],
      target: controls.target.toArray() as [number, number, number],
      fov: camera.fov,
    });
    captureRef.current = () => {
      renderer.render(scene, camera);
      try {
        return renderer.domElement.toDataURL("image/png");
      } catch {
        return null;
      }
    };

    const loader = new GLTFLoader();
    if (asset) loader.load(
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
        const materialOverrides = constructionMaterialOverrides(
          partDefinitions ?? [],
          constructionFinish,
        );
        gltf.scene.traverse((object) => {
          const override = materialOverrides.find(
            (instruction) => instruction.nodeName === object.name,
          );
          const mesh = object as THREE.Mesh;
          if (!override || !mesh.material) return;
          const materials = Array.isArray(mesh.material)
            ? mesh.material
            : [mesh.material];
          mesh.material = materials.map((material) => {
            const clone = material.clone();
            if ("color" in clone && clone.color instanceof THREE.Color) {
              clone.color.set(override.swatchColor);
            }
            return clone;
          });
        });
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
      return component.visible && component.showIn3D && model
        ? [{ component, model }]
        : [];
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
      applyViewRef.current = () => undefined;
      captureRef.current = () => null;
      if (carpet) disposeObject(carpet);
      loadedModels.forEach(disposeObject);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [asset, carpetFinish, components, constructionFinish, footprintDepthMm, footprintWidthMm, partDefinitions]);

  return (
    <div className="cadViewer">
      <div ref={mountRef} className="cadViewerMount" />

      <div className="cadViewerToolbar">
        <div className="cadViewButtons">
          <button type="button" onClick={() => fitViewRef.current()}>
            Fit model
          </button>
          {defaultViews.map((view) => (
            <button
              type="button"
              key={view.id}
              onClick={() => applyViewRef.current(view)}
            >
              {view.name}
            </button>
          ))}
          {savedViews.map((view) => (
            <span className="savedViewAction" key={view.id}>
              <button type="button" onClick={() => applyViewRef.current(view)}>
                {view.name}
              </button>
              {onDeleteView && (
                <button
                  type="button"
                  aria-label={`Odstranit pohled ${view.name}`}
                  onClick={() => onDeleteView(view.id)}
                >
                  ×
                </button>
              )}
            </span>
          ))}
          {onSaveView && (
            <button
              type="button"
              onClick={() => onSaveView(currentViewRef.current())}
            >
              Uložit pohled
            </button>
          )}
          {onCapture && (
            <button
              type="button"
              onClick={() => {
                const imageDataUrl = captureRef.current();
                if (imageDataUrl) {
                  onCapture({ imageDataUrl, view: currentViewRef.current() });
                }
              }}
            >
              Technický snímek
            </button>
          )}
          {nominalDimensions && (
            <button
              type="button"
              className={showDimensions ? "active" : ""}
              onClick={() => setShowDimensions((visible) => !visible)}
            >
              Kóty
            </button>
          )}
        </div>
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
      {showDimensions && nominalDimensions && (
        <div className="cadNominalDimensions" aria-label="Nominální rozměry">
          <svg viewBox="0 0 360 230" role="img" aria-label={`Šířka ${nominalDimensions.widthMm} mm, hloubka ${nominalDimensions.depthMm} mm, výška ${nominalDimensions.heightMm} mm`}>
            <g className="cadDimensionLine"><line x1="58" y1="184" x2="286" y2="184" /><line x1="58" y1="176" x2="58" y2="192" /><line x1="286" y1="176" x2="286" y2="192" /></g>
            <text x="172" y="174">Šířka {nominalDimensions.widthMm} mm</text>
            <g className="cadDimensionLine"><line x1="286" y1="184" x2="330" y2="143" /><line x1="281" y1="178" x2="292" y2="190" /><line x1="324" y1="137" x2="336" y2="149" /></g>
            <text x="266" y="128">Hloubka {nominalDimensions.depthMm} mm</text>
            <g className="cadDimensionLine"><line x1="42" y1="184" x2="42" y2="38" /><line x1="34" y1="184" x2="50" y2="184" /><line x1="34" y1="38" x2="50" y2="38" /></g>
            <text x="52" y="62">Výška {nominalDimensions.heightMm} mm</text>
          </svg>
        </div>
      )}
      {showPrintPlaceholder && printSurfaces.some((surface) => surface.active) && (
        <div className="cadPrintPlaceholder" role="status">
          <span>Doplnit grafiku</span>
          <small>{printSurfaces.filter((surface) => surface.active).map((surface) => `${surface.name} ${surface.widthMm} × ${surface.heightMm} mm`).join(" · ")}</small>
        </div>
      )}
    </div>
  );
}
