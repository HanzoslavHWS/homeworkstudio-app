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
import type { Measurement3D, PrintSurfaceAssignment } from "../../domain/project";
import { createMeasurement3D, nominalDimensionAnchors } from "../../domain/spatialAnnotations";

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
  measurements?: readonly Measurement3D[];
  onMeasurementsChange?: (measurements: readonly Measurement3D[]) => void;
  dimensionOffsets?: Readonly<Record<"width" | "depth" | "height", number>>;
  onDimensionOffsetsChange?: (offsets: Readonly<Record<"width" | "depth" | "height", number>>) => void;
  printSurfaceAssignments?: readonly PrintSurfaceAssignment[];
  selectedPrintSurfaceId?: string | null;
  onSelectPrintSurface?: (surfaceId: string | null) => void;
};

type ModelDimensionsMm = {
  width: number;
  depth: number;
  height: number;
};

const EMPTY_CAMERA_VIEWS: readonly CameraViewDefinition[] = [];
const EMPTY_SAVED_VIEWS: readonly SavedCameraView[] = [];
const EMPTY_PRINT_SURFACES: readonly PrintSurface[] = [];
const EMPTY_MEASUREMENTS: readonly Measurement3D[] = [];
const EMPTY_PRINT_SURFACE_ASSIGNMENTS: readonly PrintSurfaceAssignment[] = [];
const DEFAULT_DIMENSION_OFFSETS = { width: 0, depth: 0, height: 0 } as const;

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

function lineBetween(a: THREE.Vector3, b: THREE.Vector3, color = 0x34383a) {
  return new THREE.Line(
    new THREE.BufferGeometry().setFromPoints([a, b]),
    new THREE.LineBasicMaterial({ color, depthTest: false }),
  );
}

function labelSprite(text: string, color = "#25292b") {
  const canvas = document.createElement("canvas");
  canvas.width = 512; canvas.height = 96;
  const context = canvas.getContext("2d")!;
  context.fillStyle = "rgba(255,255,255,.9)"; context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = color; context.font = "700 30px Arial"; context.textAlign = "center"; context.textBaseline = "middle"; context.fillText(text, 256, 48);
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false }));
  sprite.scale.set(1.5, .28, 1);
  return sprite;
}

function cadTupleToViewer(point: readonly [number, number, number]) {
  return new THREE.Vector3(mmToSceneUnits(point[0]), mmToSceneUnits(point[2]), -mmToSceneUnits(point[1]));
}

export function BoothCadViewer({
  asset,
  footprintWidthMm,
  footprintDepthMm,
  components,
  defaultViews = EMPTY_CAMERA_VIEWS,
  savedViews = EMPTY_SAVED_VIEWS,
  onSaveView,
  onDeleteView,
  onCapture,
  carpetFinish,
  constructionFinish,
  partDefinitions,
  nominalDimensions,
  printSurfaces = EMPTY_PRINT_SURFACES,
  showPrintPlaceholder = false,
  measurements = EMPTY_MEASUREMENTS,
  onMeasurementsChange,
  dimensionOffsets = DEFAULT_DIMENSION_OFFSETS,
  onDimensionOffsetsChange,
  printSurfaceAssignments = EMPTY_PRINT_SURFACE_ASSIGNMENTS,
  selectedPrintSurfaceId,
  onSelectPrintSurface,
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
  const [viewerTool, setViewerTool] = useState<"select" | "measure" | "print">("select");
  const [measurementStart, setMeasurementStart] = useState<readonly [number, number, number] | null>(null);
  const onMeasurementsChangeRef = useRef(onMeasurementsChange);
  const onSelectPrintSurfaceRef = useRef(onSelectPrintSurface);

  useEffect(() => {
    onMeasurementsChangeRef.current = onMeasurementsChange;
  }, [onMeasurementsChange]);

  useEffect(() => {
    onSelectPrintSurfaceRef.current = onSelectPrintSurface;
  }, [onSelectPrintSurface]);

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
    const editorOverlays = new THREE.Group();
    editorOverlays.name = "Editor overlays";
    scene.add(editorOverlays);

    if (showDimensions && nominalDimensions) {
      (["width", "depth", "height"] as const).forEach((axis) => {
        const dimension = nominalDimensionAnchors(nominalDimensions, axis);
        const offsetMm = dimensionOffsets[axis] ?? 0;
        const offset = axis === "width" ? new THREE.Vector3(0, 0, mmToSceneUnits(offsetMm)) : axis === "depth" ? new THREE.Vector3(mmToSceneUnits(offsetMm), 0, 0) : new THREE.Vector3(mmToSceneUnits(offsetMm), 0, 0);
        const a = cadTupleToViewer(dimension.pointA).add(offset);
        const b = cadTupleToViewer(dimension.pointB).add(offset);
        editorOverlays.add(lineBetween(a, b));
        const label = labelSprite(`${axis === "width" ? "Šířka" : axis === "depth" ? "Hloubka" : "Výška"} ${dimension.measuredValueMm} mm`);
        label.position.copy(a).lerp(b, .5).add(new THREE.Vector3(0, .08, 0));
        editorOverlays.add(label);
      });
    }
    measurements.forEach((measurement) => {
      const a = cadTupleToViewer(measurement.pointA);
      const b = cadTupleToViewer(measurement.pointB);
      editorOverlays.add(lineBetween(a, b, 0x806d4f));
      const label = labelSprite(measurement.displayLabel?.trim() || `${measurement.measuredValueMm} mm`, "#6f5e44");
      const offset = measurement.displayOffset ? cadTupleToViewer(measurement.displayOffset) : new THREE.Vector3(0, .06, 0);
      label.position.copy(a).lerp(b, .5).add(offset);
      editorOverlays.add(label);
    });

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
        if (viewerTool === "print") {
          for (const surface of printSurfaces.filter((item) => item.active && item.nodeName)) {
            const object = gltf.scene.getObjectByName(surface.nodeName!);
            if (!object) continue;
            object.userData.printSurfaceId = surface.id;
            object.traverse((child) => {
              const mesh = child as THREE.Mesh;
              if (!mesh.material) return;
              const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
              mesh.material = materials.map((material) => {
                const clone = material.clone() as THREE.MeshStandardMaterial;
                if ("emissive" in clone) clone.emissive = new THREE.Color(surface.id === selectedPrintSurfaceId ? 0x9a8059 : 0x5f574c);
                clone.transparent = true; clone.opacity = .72;
                return clone;
              });
            });
            if (showPrintPlaceholder) {
              const bounds = new THREE.Box3().setFromObject(object);
              const placeholder = labelSprite("Doplnit grafiku", "#6f5e44");
              placeholder.position.copy(bounds.getCenter(new THREE.Vector3()));
              gltf.scene.add(placeholder);
            }
          }
        }
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

    const handleCanvasClick = (event: MouseEvent) => {
      if (viewerTool === "select") return;
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      const raycaster = new THREE.Raycaster(); raycaster.setFromCamera(pointer, camera);
      const hit = raycaster.intersectObject(content, true)[0];
      if (!hit) return;
      if (viewerTool === "print") {
        let object: THREE.Object3D | null = hit.object;
        while (object && !object.userData.printSurfaceId) object = object.parent;
        onSelectPrintSurfaceRef.current?.(object?.userData.printSurfaceId ?? null);
        return;
      }
      const point: readonly [number, number, number] = [hit.point.x / SCENE_UNITS_PER_MILLIMETER, -hit.point.z / SCENE_UNITS_PER_MILLIMETER, hit.point.y / SCENE_UNITS_PER_MILLIMETER];
      if (!measurementStart) setMeasurementStart(point);
      else {
        onMeasurementsChangeRef.current?.([...measurements, createMeasurement3D(`measurement-3d-${Date.now()}`, measurementStart, point)]);
        setMeasurementStart(null);
      }
    };
    renderer.domElement.addEventListener("click", handleCanvasClick);

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
      renderer.domElement.removeEventListener("click", handleCanvasClick);
      fitViewRef.current = () => undefined;
      applyViewRef.current = () => undefined;
      captureRef.current = () => null;
      if (carpet) disposeObject(carpet);
      loadedModels.forEach(disposeObject);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [asset, carpetFinish, components, constructionFinish, dimensionOffsets, footprintDepthMm, footprintWidthMm, measurementStart, measurements, nominalDimensions, partDefinitions, printSurfaces, selectedPrintSurfaceId, showDimensions, showPrintPlaceholder, viewerTool]);

  return (
    <div className="cadViewer">
      <div ref={mountRef} className="cadViewerMount" />

      <div className="cadViewerToolbars">
        <div className="cadViewerToolbar cadViewToolbar"><strong>POHLED</strong><div className="cadViewButtons">
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
        </div><span>Levý tah: orbit · Pravý tah: pan · Kolečko: zoom</span></div>
        <div className="cadViewerToolbar cadWorkToolbar"><strong>PRACOVNÍ NÁSTROJE</strong><div className="cadViewButtons">
          <button type="button" className={viewerTool === "select" ? "active" : ""} onClick={() => { setViewerTool("select"); setMeasurementStart(null); }}>Výběr</button>
          {nominalDimensions && <button type="button" className={showDimensions ? "active" : ""} onClick={() => setShowDimensions((visible) => !visible)}>Kóty</button>}
          <button type="button" className={viewerTool === "measure" ? "active" : ""} onClick={() => { setViewerTool("measure"); setMeasurementStart(null); }}>Měření</button>
          {printSurfaces.length > 0 && <button type="button" className={viewerTool === "print" ? "active" : ""} onClick={() => { setViewerTool("print"); setMeasurementStart(null); }}>Tiskové plochy</button>}
        </div>{measurementStart && <span>Vyberte bod B</span>}</div>
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
      {showDimensions && nominalDimensions && onDimensionOffsetsChange && <div className="cadDimensionOffsets"><span>Přesun kót</span>{(["width", "depth", "height"] as const).map((axis) => <button type="button" key={axis} onClick={() => onDimensionOffsetsChange({ ...dimensionOffsets, [axis]: (dimensionOffsets[axis] ?? 0) >= 0 ? -250 : 250 })}>{axis === "width" ? "Šířka" : axis === "depth" ? "Hloubka" : "Výška"} ↔</button>)}</div>}
      {viewerTool === "print" && <div className="cadPrintSurfaceList">{printSurfaces.filter((surface) => surface.active).map((surface) => { const assignment = printSurfaceAssignments.find((item) => item.printSurfaceId === surface.id); return <button type="button" className={selectedPrintSurfaceId === surface.id ? "active" : ""} key={surface.id} onClick={() => onSelectPrintSurface?.(surface.id)}>{surface.name}<small>{surface.widthMm} × {surface.heightMm} mm · {surface.pricingUnit ?? "—"}{assignment?.includedInPackage ? " · v ceně" : ""}</small></button>; })}</div>}
    </div>
  );
}
