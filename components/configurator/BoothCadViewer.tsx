"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  applyBoothModelTransform,
  applyComponentModelMaterialPolicy,
  cameraPositionAtDistance,
  cameraStateFromView,
  cameraZoomPercent,
  CAD_TO_VIEWER_ROTATION_X_RAD,
  distanceBetween3DPoints,
  fitPerspectiveCameraState,
  mmToSceneUnits,
  modelUnitScaleToScene,
  modelUnitsToMillimeters,
  placedComponentToViewerTransform,
  resolveComponentModelReference,
  viewerPointToCad,
} from "../../domain/cad3d";
import { getAssetDownloadUrl } from "../../lib/storage/assetClient";
import {
  applyPrintArtworkOverlays,
  clearPrintArtworkOverlays,
} from "../../lib/printArtworkOverlays";
import type {
  CadModelAsset,
  BoothAssetDefinition,
  FinishVariant,
  NominalDimensions,
  PrintSurface,
  PartDefinition,
  PlacedComponent,
} from "../../domain/models";
import { constructionMaterialOverrides } from "../../domain/materialOverrides";
import type { CameraViewDefinition } from "../../domain/models";
import type {
  GraphicFileReference,
  Measurement3D,
  PrintSurfaceAssignment,
  VisualizationView,
} from "../../domain/project";
import { createMeasurement3D, nominalDimensionAnchors } from "../../domain/spatialAnnotations";

type BoothCadViewerProps = {
  asset?: CadModelAsset;
  boothAsset?: BoothAssetDefinition;
  constructionVisibility?: Readonly<Record<string, boolean>>;
  boothVisible?: boolean;
  footprintWidthMm: number;
  footprintDepthMm: number;
  components: readonly PlacedComponent[];
  defaultViews?: readonly CameraViewDefinition[];
  onSaveView?: (view: BoothCadCameraSnapshot) => void;
  onCapture?: (capture: {
    imageDataUrl: string;
    view: BoothCadCameraSnapshot;
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
  graphicsFiles?: readonly GraphicFileReference[];
  selectedPrintSurfaceId?: string | null;
  onSelectPrintSurface?: (surfaceId: string | null) => void;
  /**
   * Individual mode's real (possibly non-rectangular) plot polygon in world mm — when present,
   * the floor/carpet mesh is built from THIS shape (via THREE.Shape/ShapeGeometry) instead of a
   * footprintWidthMm×footprintDepthMm rectangle. Undefined for typovka — completely unchanged
   * rectangle behavior. Never affects component placement/collision (that stays 2D, domain/
   * plot.ts) — this only changes what the floor MESH looks like.
   */
  floorPolygon?: readonly { x: number; y: number }[];
  cameraControlsRef?: { current: BoothCadCameraControls | null };
  onCameraZoomPercentChange?: (percent: number) => void;
};

export type BoothCadCameraControls = Readonly<{
  zoomOut: () => void;
  zoomIn: () => void;
  fit: () => void;
  reset: () => void;
  applyView: (view: Pick<VisualizationView, "position" | "target" | "fov">) => void;
  currentView: () => BoothCadCameraSnapshot;
  renderCustomerCapture: (options: CustomerCaptureOptions) => CustomerCaptureResult;
}>;

export type BoothCadCameraSnapshot = Pick<
  VisualizationView,
  "name" | "position" | "target" | "fov" | "projectionMode"
>;

/**
 * Visualization v2 — a clean, high-resolution "customer render" capture, decoupled from the live
 * browser viewport's physical pixel size. No camera fields here at all (position/target/fov) —
 * that's a structural guarantee that a capture can never move the active camera, backing the
 * "export must not change viewport/controls state" requirement at the type level.
 */
export type CustomerCaptureOptions = Readonly<{
  widthPx: number;
  heightPx: number;
  format: "png" | "jpeg";
  /** Default 0.92 when omitted. */
  jpegQuality?: number;
  backgroundMode: "white" | "light-neutral" | "transparent";
}>;

export type CustomerCaptureResult =
  | Readonly<{ ok: true; dataUrl: string; widthPx: number; heightPx: number }>
  | Readonly<{ ok: false; reason: "print-tool-active" | "capture-failed" }>;

type ModelDimensionsMm = {
  width: number;
  depth: number;
  height: number;
};

const EMPTY_CAMERA_VIEWS: readonly CameraViewDefinition[] = [];
const EMPTY_PRINT_SURFACES: readonly PrintSurface[] = [];
const EMPTY_MEASUREMENTS: readonly Measurement3D[] = [];
const EMPTY_PRINT_SURFACE_ASSIGNMENTS: readonly PrintSurfaceAssignment[] = [];
const EMPTY_GRAPHICS_FILES: readonly GraphicFileReference[] = [];
const EMPTY_CONSTRUCTION_VISIBILITY: Readonly<Record<string, boolean>> = {};
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

function visibleObjectBounds(root: THREE.Object3D): THREE.Box3 {
  const bounds = new THREE.Box3();
  root.updateWorldMatrix(true, true);

  const visit = (object: THREE.Object3D, ancestorsVisible: boolean) => {
    const visible = ancestorsVisible && object.visible;
    if (!visible) return;
    const geometry = (object as THREE.Mesh).geometry;
    if (geometry) {
      if (!geometry.boundingBox) geometry.computeBoundingBox();
      if (geometry.boundingBox) {
        bounds.union(geometry.boundingBox.clone().applyMatrix4(object.matrixWorld));
      }
    }
    object.children.forEach((child) => visit(child, visible));
  };
  visit(root, true);
  return bounds;
}

function fitCameraToObject(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  object: THREE.Object3D,
) {
  const box = visibleObjectBounds(object);
  if (box.isEmpty()) {
    return;
  }

  const sphere = box.getBoundingSphere(new THREE.Sphere());
  const fit = fitPerspectiveCameraState(
    sphere.center,
    sphere.radius,
    camera.fov,
    camera.aspect,
  );
  // Z stays positive so the default camera sits outside the booth's canonical FRONT boundary
  // (Y=0mm → cadPointToViewer's three.z=0; the booth interior/back extend toward negative Z)
  // rather than outside the back. Do not flip this sign without also re-checking
  // tests/cad3d.test.ts's front/back boundary assertions.
  camera.position.set(fit.position.x, fit.position.y, fit.position.z);
  camera.near = fit.near;
  camera.far = fit.far;
  camera.updateProjectionMatrix();

  controls.target.set(fit.target.x, fit.target.y, fit.target.z);
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
  boothAsset,
  constructionVisibility = EMPTY_CONSTRUCTION_VISIBILITY,
  boothVisible = true,
  footprintWidthMm,
  footprintDepthMm,
  components,
  defaultViews = EMPTY_CAMERA_VIEWS,
  onSaveView,
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
  graphicsFiles = EMPTY_GRAPHICS_FILES,
  selectedPrintSurfaceId,
  onSelectPrintSurface,
  floorPolygon,
  cameraControlsRef,
  onCameraZoomPercentChange,
}: BoothCadViewerProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const fitViewRef = useRef<() => void>(() => undefined);
  const resetViewRef = useRef<() => void>(() => undefined);
  const applyViewRef = useRef<(view: CameraViewDefinition) => void>(
    () => undefined,
  );
  const currentViewRef = useRef<
    () => BoothCadCameraSnapshot
  >(() => ({
    name: "Pohled",
    position: [0, 0, 0],
    target: [0, 0, 0],
    projectionMode: "perspective",
  }));
  const captureRef = useRef<() => string | null>(() => null);
  const boothSceneRef = useRef<{ scene: THREE.Object3D; modelUnit: "mm" | "m" } | null>(null);
  const [boothSceneRevision, setBoothSceneRevision] = useState(0);
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
  const onCameraZoomPercentChangeRef = useRef(onCameraZoomPercentChange);

  useEffect(() => {
    onMeasurementsChangeRef.current = onMeasurementsChange;
  }, [onMeasurementsChange]);

  useEffect(() => {
    onSelectPrintSurfaceRef.current = onSelectPrintSurface;
  }, [onSelectPrintSurface]);

  useEffect(() => {
    onCameraZoomPercentChangeRef.current = onCameraZoomPercentChange;
  }, [onCameraZoomPercentChange]);

  useEffect(() => {
    const loaded = boothSceneRef.current;
    if (!loaded) return;
    void applyPrintArtworkOverlays({
      scene: loaded.scene,
      printSurfaces,
      printSurfaceAssignments,
      graphicsFiles,
      modelUnit: loaded.modelUnit,
      resolveArtworkUrl: async (file) => {
        const storageKey = file.storageKey ?? file.asset?.storageKey;
        if (storageKey) return getAssetDownloadUrl(storageKey);
        return file.storageUrl;
      },
    }).catch((reason) => {
      console.error("Artwork overlay loading failed", reason);
    });
  }, [boothSceneRevision, graphicsFiles, printSurfaceAssignments, printSurfaces]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) {
      return;
    }

    if (
      asset &&
      (asset.axisSystem !== "x-right-y-depth-z-up" ||
        !["mm", "m"].includes(asset.unit))
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
        // Visualization v2: enables a transparent-background customer render capture
        // (renderCustomerCapture below). scene.background stays an opaque Color in every
        // existing code path, so live on-screen rendering is completely unaffected by this.
        alpha: true,
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
    controls.enableZoom = true;
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

    // The P86 GLB origin is deliberately the completed physical booth center on the floor.
    // Keep the asset untouched and express legacy project coordinates (0..nominal width/depth)
    // in that centered frame by moving only project-owned furniture/floor/overlays.
    const usesCenteredBoothOrigin =
      boothAsset?.originConvention ===
      "completed-physical-footprint-center-floor";
    const projectFrameOffset = usesCenteredBoothOrigin
      ? new THREE.Vector3(
          -mmToSceneUnits(footprintWidthMm) / 2,
          0,
          mmToSceneUnits(footprintDepthMm) / 2,
        )
      : new THREE.Vector3();
    furniture.position.copy(projectFrameOffset);
    editorOverlays.position.copy(projectFrameOffset);

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
    const hasRealPlotPolygon = Boolean(floorPolygon && floorPolygon.length >= 3);
    // Individual mode has no master booth GLB (asset is undefined — there is no typovka-style
    // pre-built shell), so without SOME floor mesh the plot would be entirely invisible in 3D by
    // default (report section 34). Typovka is completely unaffected: hasRealPlotPolygon is only
    // ever true when floorPolygon was actually passed (Individual mode only), so this reduces to
    // the exact original `carpetFinish && carpetFinish.id !== "none"` condition for typovka.
    const shouldRenderFloor = hasRealPlotPolygon || Boolean(carpetFinish && carpetFinish.id !== "none");
    if (shouldRenderFloor) {
      // floorPolygon builds the mesh from THREE.Shape/ShapeGeometry instead of a rectangle —
      // reusing Three.js's own triangulation rather than a hand-rolled one. Shape points are
      // built directly in ABSOLUTE (0-based) scene units, matching domain/cad3d.ts's
      // cadPointToViewer convention exactly once rotated (local Y → viewer Z = -Y, local X →
      // viewer X) — verified against the pre-existing centered-PlaneGeometry-plus-offset math
      // below, which produces the identical final [0,width]×[-depth,0] viewer range for the
      // rectangle case.
      const geometry = hasRealPlotPolygon
        ? new THREE.ShapeGeometry(new THREE.Shape(floorPolygon!.map((point) => new THREE.Vector2(mmToSceneUnits(point.x), mmToSceneUnits(point.y)))))
        : new THREE.PlaneGeometry(mmToSceneUnits(footprintWidthMm), mmToSceneUnits(footprintDepthMm));
      const hasRealFinish = Boolean(carpetFinish && carpetFinish.id !== "none");
      carpet = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({
          // Neutral grey "no finish chosen yet" default — never fabricates a finish color.
          color: hasRealFinish ? carpetFinish!.swatchColor ?? "#c9c6bf" : "#e4e5e6",
          roughness: 0.92,
          metalness: 0,
          side: THREE.DoubleSide,
        }),
      );
      carpet.name = hasRealFinish ? `Carpet ${carpetFinish!.name}` : "Floor (no finish)";
      carpet.rotation.x = -Math.PI / 2;
      if (hasRealPlotPolygon || usesCenteredBoothOrigin) {
        carpet.position.set(0, -0.002, 0);
      } else {
        carpet.position.set(
          mmToSceneUnits(footprintWidthMm) / 2,
          -0.002,
          -mmToSceneUnits(footprintDepthMm) / 2,
        );
      }
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

    let referenceCameraDistance = 0;
    const currentCameraDistance = () =>
      distanceBetween3DPoints(camera.position, controls.target);
    const reportCameraZoom = () => {
      onCameraZoomPercentChangeRef.current?.(
        cameraZoomPercent(referenceCameraDistance, currentCameraDistance()),
      );
    };
    const establishReferenceDistance = () => {
      referenceCameraDistance = currentCameraDistance();
      reportCameraZoom();
    };
    const fitView = () => {
      fitCameraToObject(camera, controls, content);
      establishReferenceDistance();
    };
    fitViewRef.current = fitView;
    const applyCameraView = (
      view: Pick<CameraViewDefinition, "position" | "target" | "fov">,
    ) => {
      const state = cameraStateFromView(view, camera.fov);
      camera.position.set(state.position.x, state.position.y, state.position.z);
      controls.target.set(state.target.x, state.target.y, state.target.z);
      camera.fov = state.fov;
      camera.updateProjectionMatrix();
      controls.update();
      return state;
    };
    applyViewRef.current = (view) => { applyCameraView(view); };
    resetViewRef.current = () => {
      const defaultView = defaultViews[0];
      if (defaultView) {
        referenceCameraDistance = applyCameraView(defaultView).referenceDistance;
        reportCameraZoom();
      }
      else fitView();
    };
    const zoomBy = (factor: number) => {
      const next = cameraPositionAtDistance(
        camera.position,
        controls.target,
        currentCameraDistance() * factor,
        controls.minDistance,
        controls.maxDistance,
      );
      camera.position.set(next.x, next.y, next.z);
      controls.update();
      reportCameraZoom();
    };
    /**
     * Visualization v2 — the ONE customer-capture entry point, exposed via cameraControlsRef.
     * Runs entirely synchronously (no await/microtask yield) between the mutation and the
     * restore in the finally block, so the always-running requestAnimationFrame render loop
     * (see `render` below) can never interleave and paint a half-mutated frame — by the time the
     * next rAF callback fires, everything below has already been restored. Camera
     * position/target/fov and OrbitControls are never referenced anywhere in this function — a
     * structural guarantee (CustomerCaptureOptions carries no camera fields) that a capture can
     * never move the active camera.
     */
    const renderCustomerCapture = (options: CustomerCaptureOptions): CustomerCaptureResult => {
      // Print-surface selection applies a real scene-graph emissive tint (see the
      // viewerTool === "print" branch below) — refusing here (rather than forcing viewerTool
      // back to "select", which would re-trigger this whole effect via the dependency array and
      // tear down/rebuild the entire scene) is the only non-disruptive option. The UI disables
      // "Vyrenderovat" with an explanatory label while this tool is active.
      if (viewerTool !== "select") return { ok: false, reason: "print-tool-active" };

      const previousPixelRatio = renderer.getPixelRatio();
      const previousAspect = camera.aspect;
      const previousBackground = scene.background;
      const previousClearAlpha = renderer.getClearAlpha();
      const previousOverlaysVisible = editorOverlays.visible;
      try {
        renderer.setPixelRatio(1);
        renderer.setSize(options.widthPx, options.heightPx, false);
        camera.aspect = options.widthPx / options.heightPx;
        camera.updateProjectionMatrix();
        if (options.backgroundMode === "white") {
          scene.background = new THREE.Color(0xffffff);
        } else if (options.backgroundMode === "transparent") {
          scene.background = null;
          renderer.setClearAlpha(0);
        }
        // "light-neutral": no change — reuses the viewer's existing default scene.background.
        editorOverlays.visible = false;

        renderer.render(scene, camera);
        const dataUrl = options.format === "png"
          ? renderer.domElement.toDataURL("image/png")
          : renderer.domElement.toDataURL("image/jpeg", options.jpegQuality ?? 0.92);
        return { ok: true, dataUrl, widthPx: options.widthPx, heightPx: options.heightPx };
      } catch (reason) {
        console.error("Customer render capture failed", reason);
        return { ok: false, reason: "capture-failed" };
      } finally {
        editorOverlays.visible = previousOverlaysVisible;
        scene.background = previousBackground;
        renderer.setClearAlpha(previousClearAlpha);
        camera.aspect = previousAspect;
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(previousPixelRatio);
        // Re-derives the live DOM-mount-driven size/aspect fresh — guarantees the post-capture
        // state is bit-identical to "as if the capture never happened," never a hand-rolled
        // recompute that could drift from the viewer's normal resize logic.
        resize();
      }
    };

    const cameraController: BoothCadCameraControls = {
      zoomOut: () => zoomBy(1.2),
      zoomIn: () => zoomBy(1 / 1.2),
      fit: fitView,
      reset: () => resetViewRef.current(),
      applyView: (view) => {
        applyCameraView(view);
        establishReferenceDistance();
      },
      currentView: () => currentViewRef.current(),
      renderCustomerCapture,
    };
    if (cameraControlsRef) cameraControlsRef.current = cameraController;
    controls.addEventListener("change", reportCameraZoom);
    currentViewRef.current = () => ({
      name: "Vlastní pohled",
      position: camera.position.toArray() as [number, number, number],
      target: controls.target.toArray() as [number, number, number],
      fov: camera.fov,
      projectionMode: "perspective",
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
          width: modelUnitsToMillimeters(cadSize.x, asset.unit),
          depth: modelUnitsToMillimeters(cadSize.y, asset.unit),
          height: modelUnitsToMillimeters(cadSize.z, asset.unit),
        });

        // Central CAD boundary: declared model units -> scene meters and Z-up -> Three.js Y-up.
        // Never recenter the master GLB; its authored origin is part of the booth definition.
        applyBoothModelTransform(
          gltf.scene,
          asset,
          boothAsset,
          constructionVisibility,
          boothVisible,
        );
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
        boothSceneRef.current = { scene: gltf.scene, modelUnit: asset.unit };
        setBoothSceneRevision((revision) => revision + 1);
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

    // Report section 28/36: resolveComponentModelReference prefers a real R2 modelAsset, then a
    // bare modelUrl, and keeps legacy assets.models3d[] as the final fallback — the two active
    // fields are the sources a DB-catalog-sourced component (e.g. an
    // Admin-uploaded booth_component) actually carries. Only the "stored" case needs an async
    // signed-URL resolution before it has a loadable url at all.
    const componentModels = components.flatMap((component) => {
      const source = resolveComponentModelReference(component);
      return component.visible && component.showIn3D && source
        ? [{ component, source }]
        : [];
    });
    setPendingComponents(componentModels.length);

    function loadComponentModel(
      component: PlacedComponent,
      url: string,
      anchor: CadModelAsset["anchor"],
      unit: CadModelAsset["unit"] = "mm",
    ) {
      new GLTFLoader().load(
        url,
        (gltf) => {
          if (!active) {
            disposeObject(gltf.scene);
            return;
          }

          applyComponentModelMaterialPolicy(
            gltf.scene,
            component,
            THREE.DoubleSide,
          );
          gltf.scene.scale.setScalar(modelUnitScaleToScene(unit));
          gltf.scene.rotation.x = CAD_TO_VIEWER_ROTATION_X_RAD;
          gltf.scene.updateMatrixWorld(true);

          if (anchor === "footprint-center-floor") {
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
    }

    componentModels.forEach(({ component, source }) => {
      if (source.kind === "legacy") {
        loadComponentModel(
          component,
          source.asset.url,
          source.asset.anchor,
          source.asset.unit,
        );
        return;
      }
      if (source.kind === "url") {
        loadComponentModel(component, source.url, source.anchor, source.unit);
        return;
      }
      // "stored": a real R2 modelAsset — source of truth is storageKey, resolved to a signed
      // download URL the same way the master booth model already is (BoothGenerator.tsx's
      // useAssetUrl/resolvedStoredModelUrl). No hook available inside an imperative effect, so
      // this calls the same underlying plain function directly (never a public-URL workaround, no
      // new upload/duplicate asset — report section 36).
      getAssetDownloadUrl(source.asset.storageKey)
        .then((url) => {
          if (!active) return;
          loadComponentModel(component, url, source.anchor, source.unit);
        })
        .catch((reason) => {
          if (!active) return;
          console.error(`Component asset URL resolution failed: ${component.id}`, reason);
          setComponentLoadError(true);
          setPendingComponents((count) => Math.max(0, count - 1));
        });
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
      const cadPoint = viewerPointToCad(
        hit.point.clone().sub(projectFrameOffset),
      );
      const point: readonly [number, number, number] = [cadPoint.x, cadPoint.y, cadPoint.z];
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
      controls.removeEventListener("change", reportCameraZoom);
      controls.dispose();
      renderer.domElement.removeEventListener("click", handleCanvasClick);
      fitViewRef.current = () => undefined;
      resetViewRef.current = () => undefined;
      applyViewRef.current = () => undefined;
      captureRef.current = () => null;
      if (cameraControlsRef?.current === cameraController) {
        cameraControlsRef.current = null;
      }
      if (boothSceneRef.current && loadedModels.includes(boothSceneRef.current.scene)) {
        clearPrintArtworkOverlays(boothSceneRef.current.scene);
        boothSceneRef.current = null;
      }
      if (carpet) disposeObject(carpet);
      loadedModels.forEach(disposeObject);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [asset, boothAsset, boothVisible, cameraControlsRef, carpetFinish, components, constructionFinish, constructionVisibility, defaultViews, dimensionOffsets, footprintDepthMm, footprintWidthMm, measurementStart, measurements, nominalDimensions, partDefinitions, printSurfaces, selectedPrintSurfaceId, showDimensions, showPrintPlaceholder, viewerTool]);

  return (
    <div className="cadViewer">
      <div ref={mountRef} className="cadViewerMount" />

      <div className="cadViewerToolbars">
        <div className="cadViewerToolbar cadViewToolbar"><strong>POHLED</strong><div className="cadViewButtons">
          <button type="button" onClick={() => fitViewRef.current()}>
            Fit
          </button>
          <button type="button" onClick={() => resetViewRef.current()}>
            Reset kamery
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
