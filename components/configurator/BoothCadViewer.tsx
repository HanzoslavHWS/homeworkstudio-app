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
  createArtworkMaskMaterial,
  findPrintArtworkOverlays,
} from "../../lib/printArtworkOverlays";
import {
  SEMANTIC_CATEGORY_COLORS,
  SEMANTIC_CATEGORY_USERDATA_KEY,
  type ProtectedCategory,
} from "../../domain/visualizationSemantics";
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
import { unpackLinearDepthRGB } from "../../domain/visualizationDepth";

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
  renderControlPassCapture: (options: ControlPassCaptureOptions) => ControlPassCaptureResult;
  /** v3.2d report section 7 — isolated known-distance GPU sanity check for the Depth data material. Never touches the live scene/canvas; builds and disposes its own tiny scene/render target. */
  runDepthSanityCheck: () => DepthSanityCheckResult;
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

/**
 * Visualization v3 — control-pass capture, feeding the strict-lock AI compositing pipeline.
 * Same non-camera-field structural guarantee as CustomerCaptureOptions. `backgroundMode` must
 * match the source Customer Render's own backgroundMode so the beauty pass here is genuinely
 * pixel-identical to that render (both call the same performCustomerCaptureRender body).
 */
export type ControlPassCaptureOptions = Readonly<{
  widthPx: number;
  heightPx: number;
  backgroundMode: CustomerCaptureOptions["backgroundMode"];
}>;

/**
 * v3.2d report section 2 — a snapshot of the ACTUAL runtime material instance used for the Depth
 * pass, captured right after the render call (so onBeforeCompile has definitely fired). Lets a
 * human confirm from real browser output what's really running, rather than trusting a source
 * read — this is what would have caught the v3.2d MeshDepthMaterial degeneration immediately.
 */
export type DepthMaterialRuntimeDiagnostics = Readonly<{
  type: string;
  transparent: boolean;
  blending: THREE.Blending;
  colorWrite: boolean;
  depthWrite: boolean;
  depthTest: boolean;
  precision: string | null;
  /** The actual compiled fragment shader source for this material/mesh combination — report section 3's "verify compiled shader" ask, satisfied directly rather than via a separate reverse-engineering step. */
  compiledFragmentShader: string | null;
}>;

/** v3.2d report section 7 — one sampled pixel from the isolated known-distance sanity scene. */
export type DepthSanityCheckSample = Readonly<{
  label: "near" | "mid" | "far";
  r: number;
  g: number;
  b: number;
  a: number;
  linearDepth: number;
}>;

export type DepthSanityCheckResult =
  | Readonly<{ ok: true; samples: readonly DepthSanityCheckSample[]; monotonic: boolean }>
  | Readonly<{ ok: false; reason: "capture-failed" }>;

/**
 * The 6 control passes (report section 3), all captured from the SAME camera/size/visibility in
 * one atomic synchronous sequence. None of these are ever persisted — ephemeral, in-memory only,
 * used for one generation request and discarded (see domain/visualizationCompositing.ts and the
 * AI generation flow, which are the only consumers).
 */
export type ControlPassBundle = Readonly<{
  beautyDataUrl: string;
  /** Flat-white silhouette of every scene object (booth/furniture/artwork/floor) over black — the raw, unfeathered protected mask. Feathering happens only later, at compositing. */
  protectedMaskDataUrl: string;
  /** Flat-white silhouette of ONLY the print-artwork overlay meshes over black — independent of the protected-mask technique, so it survives any future change to booth-mask strategy. */
  artworkMaskDataUrl: string;
  depthDataUrl: string;
  normalDataUrl: string;
  objectIdDataUrl: string;
  /** camera.near/far read LIVE at capture time (fitView() overwrites them) — never assume a fixed range when linearizing depthDataUrl. */
  depthNear: number;
  depthFar: number;
  normalSpace: "view";
  widthPx: number;
  heightPx: number;
  /** v3.2d — runtime audit of the actual Depth pass material (report section 2/3). */
  depthMaterialDiagnostics: DepthMaterialRuntimeDiagnostics;
}>;

export type ControlPassCaptureResult =
  | Readonly<{ ok: true; passes: ControlPassBundle }>
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

/**
 * Visualization v3.2b — turns a raw RGBA byte buffer (read straight off the GPU via
 * WebGLRenderer.readRenderTargetPixels, never off the live color-managed canvas) into a PNG data
 * URL via a plain 2D <canvas>. 2D canvas ImageData is always straight (non-premultiplied) alpha
 * by spec and toDataURL() on a 2D context never divides by alpha — unlike the WebGL default
 * framebuffer's PNG export path, this can never corrupt packed non-color data (see the Depth
 * pass's own comment below for why that corruption happened). `flipY` undoes readRenderTargetPixels'
 * bottom-up (OpenGL/WebGL) row order so the result lines up with every other top-down pass PNG.
 */
function rgbaBufferToDataUrl(pixels: Uint8Array, width: number, height: number, options: Readonly<{ flipY: boolean }>): string {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.createImageData(width, height);
  if (options.flipY) {
    const rowBytes = width * 4;
    for (let y = 0; y < height; y++) {
      const sourceRow = height - 1 - y;
      imageData.data.set(pixels.subarray(sourceRow * rowBytes, sourceRow * rowBytes + rowBytes), y * rowBytes);
    }
  } else {
    imageData.data.set(pixels);
  }
  ctx.putImageData(imageData, 0, 0);
  return canvas.toDataURL("image/png");
}

/**
 * Visualization v3.2d — dedicated depth-data material for the Depth control pass. Live browser
 * diagnostics (v3.2d report) proved MeshDepthMaterial(RGBADepthPacking) was producing a
 * DEGENERATE capture in this app's actual runtime — raw RGB always (0,0,0), alpha binary 0/255
 * correlating almost exactly with the Protected Mask silhouette (i.e. a coverage mask, not depth
 * data) — despite every checkable piece of its public API (the depthPacking constant, constructor
 * option application, the compiled #define) being verifiably correct by reading three.js's own
 * source. Rather than keep chasing an unreproducible framework issue, this is a small, fully
 * self-written, easily-audited replacement:
 *  - computes LINEAR view-space depth directly from modelViewMatrix (never THREE's own
 *    packDepthToRGBA/gl_FragCoord.z/vHighPrecisionZW machinery),
 *  - packs it deterministically into RGB only (domain/visualizationDepth.ts's
 *    packLinearDepthRGB/unpackLinearDepthRGB are the JS-side mirror of this exact math — a
 *    source-scan test pins the shared 16777215.0 constant),
 *  - ALWAYS writes alpha = 1.0 — numeric depth can never again be mistaken for real opacity by any
 *    canvas/PNG pipeline (the actual root motivation for the whole v3.2b/c/d chain, report
 *    section 8).
 * `precision: "highp"` is set explicitly (defensive — the pack needs float32 exact-integer range
 * up to 2^24, comfortably inside highp but not guaranteed in mediump).
 */
function createDepthDataMaterial(near: number, far: number): Readonly<{
  material: THREE.ShaderMaterial;
  readDiagnostics: () => DepthMaterialRuntimeDiagnostics;
}> {
  let compiledFragmentShader: string | null = null;
  const material = new THREE.ShaderMaterial({
    uniforms: { uNear: { value: near }, uFar: { value: far } },
    vertexShader: /* glsl */ `
      varying float vViewDistance;
      void main() {
        vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
        vViewDistance = -mvPosition.z;
        gl_Position = projectionMatrix * mvPosition;
      }
    `,
    // 16777215.0 = 2^24 - 1 — MUST match domain/visualizationDepth.ts's LINEAR_DEPTH_PACK_MAX.
    fragmentShader: /* glsl */ `
      precision highp float;
      uniform float uNear;
      uniform float uFar;
      varying float vViewDistance;
      void main() {
        float normalized = clamp((vViewDistance - uNear) / (uFar - uNear), 0.0, 1.0);
        float scaled = floor(normalized * 16777215.0 + 0.5);
        float r = floor(scaled / 65536.0);
        float g = floor(mod(scaled, 65536.0) / 256.0);
        float b = mod(scaled, 256.0);
        gl_FragColor = vec4(r, g, b, 255.0) / 255.0;
      }
    `,
    precision: "highp",
    transparent: false,
    depthTest: true,
    depthWrite: true,
  });
  material.onBeforeCompile = (shader) => { compiledFragmentShader = shader.fragmentShader; };
  return {
    material,
    readDiagnostics: () => ({
      type: material.type,
      transparent: material.transparent,
      blending: material.blending,
      colorWrite: material.colorWrite,
      depthWrite: material.depthWrite,
      depthTest: material.depthTest,
      precision: material.precision,
      compiledFragmentShader,
    }),
  };
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
      carpet.userData[SEMANTIC_CATEGORY_USERDATA_KEY] = "booth-floor";
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
    /**
     * The exact render body renderCustomerCapture always used, extracted unchanged so
     * renderControlPassCapture's beauty pass can share it verbatim (report section 2) — this is
     * a pure extraction, renderCustomerCapture's own behavior is byte-for-byte unchanged.
     */
    const performCustomerCaptureRender = (
      options: Pick<CustomerCaptureOptions, "widthPx" | "heightPx" | "format" | "jpegQuality" | "backgroundMode">,
    ): string => {
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
      return options.format === "png"
        ? renderer.domElement.toDataURL("image/png")
        : renderer.domElement.toDataURL("image/jpeg", options.jpegQuality ?? 0.92);
    };

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
        const dataUrl = performCustomerCaptureRender(options);
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

    /**
     * Resolves the semantic category of a mesh by walking up its ancestor chain — never a
     * P86/koje-specific id, only identifiers that exist for any booth (see
     * domain/visualizationSemantics.ts's SEMANTIC_TAGGING_CONTRACT, which this follows exactly).
     * Falls back to "booth-construction" since `content` only ever holds the carpet, the booth
     * GLTF, and furniture — there is no fourth kind of object to misclassify.
     */
    const classifyObjectCategory = (object: THREE.Object3D, artworkMeshes: ReadonlySet<THREE.Object3D>): ProtectedCategory => {
      let current: THREE.Object3D | null = object;
      while (current) {
        if (artworkMeshes.has(current)) return "artwork";
        if (current === carpet) return "booth-floor";
        if (current.userData[SEMANTIC_CATEGORY_USERDATA_KEY] === "furniture") return "furniture";
        current = current.parent;
      }
      return "booth-construction";
    };

    /**
     * One combined synchronous function (never 6 separate calls) — an await between two
     * internally-atomic calls would reopen exactly the rAF-interleaving race renderCustomerCapture
     * was built to prevent. Saves state once, mutates size/aspect/pixelRatio once (identical
     * camera transform across all 6 passes), restores materials/visibility between each pass
     * (never compounding), and restores everything once at the end in `finally` — same tail as
     * renderCustomerCapture.
     */
    const renderControlPassCapture = (options: ControlPassCaptureOptions): ControlPassCaptureResult => {
      if (viewerTool !== "select") return { ok: false, reason: "print-tool-active" };

      const previousPixelRatio = renderer.getPixelRatio();
      const previousAspect = camera.aspect;
      const previousBackground = scene.background;
      const previousClearAlpha = renderer.getClearAlpha();
      const previousOverlaysVisible = editorOverlays.visible;

      const meshes: THREE.Mesh[] = [];
      content.traverse((object) => {
        if ((object as THREE.Mesh).isMesh) meshes.push(object as THREE.Mesh);
      });
      const originalMaterials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
      const originalVisibility = new Map<THREE.Mesh, boolean>();
      for (const mesh of meshes) {
        originalMaterials.set(mesh, mesh.material);
        originalVisibility.set(mesh, mesh.visible);
      }
      const restoreMaterials = () => { for (const mesh of meshes) mesh.material = originalMaterials.get(mesh)!; };
      const restoreVisibility = () => { for (const mesh of meshes) mesh.visible = originalVisibility.get(mesh)!; };

      const flatWhiteMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff });
      const maskBlackMaterial = new THREE.MeshBasicMaterial({ color: 0x000000 });
      const normalMaterial = new THREE.MeshNormalMaterial();
      const categoryMaterials: Record<ProtectedCategory, THREE.MeshBasicMaterial> = {
        "booth-construction": new THREE.MeshBasicMaterial({ color: new THREE.Color(SEMANTIC_CATEGORY_COLORS["booth-construction"].r / 255, SEMANTIC_CATEGORY_COLORS["booth-construction"].g / 255, SEMANTIC_CATEGORY_COLORS["booth-construction"].b / 255) }),
        artwork: new THREE.MeshBasicMaterial({ color: new THREE.Color(SEMANTIC_CATEGORY_COLORS.artwork.r / 255, SEMANTIC_CATEGORY_COLORS.artwork.g / 255, SEMANTIC_CATEGORY_COLORS.artwork.b / 255) }),
        furniture: new THREE.MeshBasicMaterial({ color: new THREE.Color(SEMANTIC_CATEGORY_COLORS.furniture.r / 255, SEMANTIC_CATEGORY_COLORS.furniture.g / 255, SEMANTIC_CATEGORY_COLORS.furniture.b / 255) }),
        "booth-floor": new THREE.MeshBasicMaterial({ color: new THREE.Color(SEMANTIC_CATEGORY_COLORS["booth-floor"].r / 255, SEMANTIC_CATEGORY_COLORS["booth-floor"].g / 255, SEMANTIC_CATEGORY_COLORS["booth-floor"].b / 255) }),
      };
      const disposablePassMaterials = [flatWhiteMaterial, maskBlackMaterial, normalMaterial, ...Object.values(categoryMaterials)];
      // v3.2b: the Depth pass renders to this offscreen target instead of the live canvas (see
      // the Depth step's own comment below for why). Declared here (not inside the try body) so
      // the `finally` safety net can always reach it, even if capture throws mid-read.
      let depthRenderTarget: THREE.WebGLRenderTarget | null = null;
      // v3.2d: the Depth pass's dedicated data material (createDepthDataMaterial) — built fresh
      // each capture (its uniforms need the LIVE depthNear/depthFar), never part of the static
      // disposablePassMaterials list above. Same finally-safety-net reasoning as depthRenderTarget.
      let depthDataMaterialRef: THREE.ShaderMaterial | null = null;

      try {
        renderer.setPixelRatio(1);
        renderer.setSize(options.widthPx, options.heightPx, false);
        camera.aspect = options.widthPx / options.heightPx;
        camera.updateProjectionMatrix();
        editorOverlays.visible = false;

        // 1. Beauty — literally the same render body as the official Customer Render.
        const beautyDataUrl = performCustomerCaptureRender({
          widthPx: options.widthPx, heightPx: options.heightPx, format: "png", backgroundMode: options.backgroundMode,
        });
        restoreMaterials();

        // 2. Protected mask — flat-white silhouette of every scene object over black.
        scene.background = new THREE.Color(0x000000);
        for (const mesh of meshes) mesh.material = flatWhiteMaterial;
        renderer.render(scene, camera);
        const protectedMaskDataUrl = renderer.domElement.toDataURL("image/png");
        restoreMaterials();

        // 3. Artwork mask — ONLY the print-artwork overlay meshes (reused verbatim via
        // findPrintArtworkOverlays), independent of the protected-mask technique above. Never
        // hides non-artwork meshes to "isolate" the overlays — an overlay is parented to its own
        // panel mesh (lib/printArtworkOverlays.ts target.add(overlay)), so hiding the panel would
        // also stop WebGLRenderer's traversal from ever reaching its overlay child (a
        // `visible = false` object's children are never visited) — that was the v3.1 root cause of
        // a fully black mask. Every mesh stays at its real Beauty visibility; only materials
        // differ: createArtworkMaskMaterial's alpha-aware discard for overlays (white on actually-
        // printed pixels only, report section 5), flat black for everything else. depthTest/
        // depthWrite stay on throughout, so BACK-face artwork occluded by its own panel in Beauty
        // stays occluded here too (report section 4).
        scene.background = new THREE.Color(0x000000);
        const artworkMeshes = new Set<THREE.Object3D>(findPrintArtworkOverlays(scene));
        const artworkMaskMaterials: THREE.Material[] = [];
        for (const mesh of meshes) {
          if (!artworkMeshes.has(mesh)) {
            mesh.material = maskBlackMaterial;
            continue;
          }
          const map = (mesh.material as THREE.MeshBasicMaterial).map;
          if (!map) {
            mesh.material = flatWhiteMaterial;
            continue;
          }
          const maskMaterial = createArtworkMaskMaterial(map);
          artworkMaskMaterials.push(maskMaterial);
          mesh.material = maskMaterial;
        }
        renderer.render(scene, camera);
        const artworkMaskDataUrl = renderer.domElement.toDataURL("image/png");
        for (const material of artworkMaskMaterials) material.dispose();
        restoreMaterials();

        // 4. Depth — camera-space depth. near/far read LIVE (fitView() overwrites them).
        //
        // v3.2b: MeshDepthMaterial's packed RGBA output is pure numeric data, not a real color —
        // reading it off the live `alpha:true`/premultipliedAlpha:true canvas via toDataURL() was
        // unsafe (browser un-premultiplies RGB by alpha on PNG export), so this pass renders into
        // an offscreen WebGLRenderTarget and reads it back with renderer.readRenderTargetPixels —
        // gl.readPixels on an FBO returns the literal stored bytes, no canvas
        // alpha-premultiplication/PNG-export math involved. Never touches the live canvas (no
        // flash), same camera/width/height as every other pass.
        //
        // v3.2d: LIVE BROWSER DIAGNOSTICS (not just the above reasoning) then proved
        // MeshDepthMaterial(RGBADepthPacking) was ALSO producing a degenerate capture through this
        // exact WebGLRenderTarget path — raw RGB always (0,0,0), alpha binary 0/255 correlating
        // almost exactly with the Protected Mask silhouette (a coverage mask, not depth data) —
        // despite the depthPacking constant/constructor option/compiled #define all checking out
        // correct by reading three.js's own source. Rather than keep chasing that, the Depth pass
        // now uses createDepthDataMaterial — a small, fully self-written ShaderMaterial (see its
        // own doc comment) — instead of MeshDepthMaterial. Disposed/restored in `finally` even if
        // capture throws mid-read (report section 3/20).
        const depthNear = camera.near;
        const depthFar = camera.far;
        scene.background = new THREE.Color(0x000000);
        const { material: depthDataMaterial, readDiagnostics: readDepthMaterialDiagnostics } = createDepthDataMaterial(depthNear, depthFar);
        depthDataMaterialRef = depthDataMaterial;
        for (const mesh of meshes) mesh.material = depthDataMaterial;
        depthRenderTarget = new THREE.WebGLRenderTarget(options.widthPx, options.heightPx, {
          type: THREE.UnsignedByteType,
          format: THREE.RGBAFormat,
        });
        depthRenderTarget.texture.colorSpace = THREE.NoColorSpace;
        renderer.setRenderTarget(depthRenderTarget);
        renderer.render(scene, camera);
        // Read AFTER render — onBeforeCompile (and so compiledFragmentShader) only fires once the
        // GPU program has actually been built for this draw call.
        const depthMaterialDiagnostics = readDepthMaterialDiagnostics();
        const rawDepthPixels = new Uint8Array(options.widthPx * options.heightPx * 4);
        renderer.readRenderTargetPixels(depthRenderTarget, 0, 0, options.widthPx, options.heightPx, rawDepthPixels);
        renderer.setRenderTarget(null);
        depthRenderTarget.dispose();
        depthRenderTarget = null;
        depthDataMaterial.dispose();
        depthDataMaterialRef = null;
        // readRenderTargetPixels rows are bottom-up (GL convention) — flip so this PNG is
        // top-down like every other pass's canvas-derived PNG.
        const depthDataUrl = rgbaBufferToDataUrl(rawDepthPixels, options.widthPx, options.heightPx, { flipY: true });
        restoreMaterials();

        // 5. Normal — view-space normals, Three.js's standard MeshNormalMaterial encoding.
        for (const mesh of meshes) mesh.material = normalMaterial;
        renderer.render(scene, camera);
        const normalDataUrl = renderer.domElement.toDataURL("image/png");
        restoreMaterials();

        // 6. Object/semantic-ID — flat per-category color, black = editable-environment.
        scene.background = new THREE.Color(0x000000);
        for (const mesh of meshes) mesh.material = categoryMaterials[classifyObjectCategory(mesh, artworkMeshes)];
        renderer.render(scene, camera);
        const objectIdDataUrl = renderer.domElement.toDataURL("image/png");
        restoreMaterials();

        return {
          ok: true,
          passes: {
            beautyDataUrl, protectedMaskDataUrl, artworkMaskDataUrl, depthDataUrl, normalDataUrl, objectIdDataUrl,
            depthNear, depthFar, normalSpace: "view",
            widthPx: options.widthPx, heightPx: options.heightPx,
            depthMaterialDiagnostics,
          },
        };
      } catch (reason) {
        console.error("Control pass capture failed", reason);
        return { ok: false, reason: "capture-failed" };
      } finally {
        restoreMaterials();
        restoreVisibility();
        for (const material of disposablePassMaterials) material.dispose();
        // Safety net only — the normal path already sets these back to null and disposes them
        // right after reading the pixels back; this only fires if something threw in between.
        if (depthRenderTarget) {
          renderer.setRenderTarget(null);
          depthRenderTarget.dispose();
          depthRenderTarget = null;
        }
        if (depthDataMaterialRef) {
          depthDataMaterialRef.dispose();
          depthDataMaterialRef = null;
        }
        editorOverlays.visible = previousOverlaysVisible;
        scene.background = previousBackground;
        renderer.setClearAlpha(previousClearAlpha);
        camera.aspect = previousAspect;
        camera.updateProjectionMatrix();
        renderer.setPixelRatio(previousPixelRatio);
        resize();
      }
    };

    /**
     * v3.2d report section 7 — isolated known-distance GPU sanity check: 3 boxes at known
     * view-space distances (1/8/18 units), captured with createDepthDataMaterial through the SAME
     * renderer as the real capture path, but a throwaway orthographic camera/scene/render target
     * built and disposed entirely within this call — never touches the live scene/canvas/camera,
     * never persisted. An orthographic camera (not perspective) is used deliberately: it makes
     * each box's SCREEN position independent of its distance, so 3 laterally-offset boxes at very
     * different depths never occlude each other and are trivial to locate by a fixed pixel column.
     */
    const runDepthSanityCheck = (): DepthSanityCheckResult => {
      const previousTarget = renderer.getRenderTarget();
      const isolatedScene = new THREE.Scene();
      isolatedScene.background = new THREE.Color(0x000000);
      const isolatedCamera = new THREE.OrthographicCamera(-4, 4, 1.5, -1.5, 0.1, 20);
      isolatedCamera.position.set(0, 0, 0);
      isolatedCamera.lookAt(0, 0, -1);
      isolatedCamera.updateProjectionMatrix();

      const { material, readDiagnostics } = createDepthDataMaterial(isolatedCamera.near, isolatedCamera.far);
      const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
      const configs: readonly Readonly<{ label: "near" | "mid" | "far"; x: number; z: number }>[] = [
        { label: "near", x: -2, z: -1 },
        { label: "mid", x: 0, z: -8 },
        { label: "far", x: 2, z: -18 },
      ];
      for (const config of configs) {
        const mesh = new THREE.Mesh(boxGeometry, material);
        mesh.position.set(config.x, 0, config.z);
        isolatedScene.add(mesh);
      }

      const width = 80, height = 30;
      const target = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat });
      target.texture.colorSpace = THREE.NoColorSpace;

      try {
        renderer.setRenderTarget(target);
        renderer.render(isolatedScene, isolatedCamera);
        void readDiagnostics(); // triggers/confirms compilation; not surfaced here, renderControlPassCapture's own diagnostics cover that
        const pixels = new Uint8Array(width * height * 4);
        renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);

        // World x=-4..4 maps linearly to screen columns 0..width (the ortho frustum's left/right)
        // — no row flip needed, any row inside each 1-unit-tall box's vertical extent works.
        const rowY = Math.floor(height / 2);
        const sampleAt = (label: "near" | "mid" | "far", worldX: number): DepthSanityCheckSample => {
          const x = Math.min(width - 1, Math.max(0, Math.round(((worldX - -4) / 8) * width)));
          const offset = (rowY * width + x) * 4;
          const r = pixels[offset]!, g = pixels[offset + 1]!, b = pixels[offset + 2]!, a = pixels[offset + 3]!;
          return { label, r, g, b, a, linearDepth: unpackLinearDepthRGB(r, g, b) };
        };
        const samples = configs.map((config) => sampleAt(config.label, config.x));
        const monotonic = samples[0]!.linearDepth < samples[1]!.linearDepth && samples[1]!.linearDepth < samples[2]!.linearDepth;
        return { ok: true, samples, monotonic };
      } catch (reason) {
        console.error("Depth sanity check failed", reason);
        return { ok: false, reason: "capture-failed" };
      } finally {
        renderer.setRenderTarget(previousTarget);
        target.dispose();
        material.dispose();
        boxGeometry.dispose();
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
      runDepthSanityCheck,
      renderControlPassCapture,
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
          instance.userData[SEMANTIC_CATEGORY_USERDATA_KEY] = "furniture";
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
