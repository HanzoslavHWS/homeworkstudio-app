"use client";

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";
import { MeshoptDecoder } from "three/addons/libs/meshopt_decoder.module.js";
import { adaptSavedViewDistanceFactor, clippingFor, easeInOutCubic, fitView, presetView, type SeeViewPreset } from "../../domain/seeCameraFit";
import { formatFileSize, resolveBackgroundColor, type SeeCameraView, type SeeSceneSettings, type SeeVec3 } from "../../domain/seeProject";
import { seePrefetchOrder, seeRenderProfile, type SeeRenderProfile } from "../../domain/seeViewerProfile";
import { enterFullscreen, exitFullscreen, isFullscreen, nativeFullscreenElement } from "../../lib/see/fullscreen";
import { SeeExternalLink, SeeImage } from "./SeeMedia";

/**
 * HWS SEE WebGL viewer (plain three.js — the renderer this repo already uses for the ABF CAD view).
 * One viewer shows ONE of several alternative scenes at a time; switching swaps the loaded GLB,
 * keeps each scene's own camera/background/light and its own annotations.
 *
 * Coordinates: the GLB root is never transformed, so world space == the model's own space and an
 * annotation stores the raycast hit point in the scene's local coordinates.
 *
 * Formats: GLB with embedded PNG/JPEG/WebP/AVIF textures, KTX2/Basis Universal textures
 * (KHR_texture_basisu, transcoded on the GPU's native format), Draco and Meshopt geometry.
 *
 * Performance: renders only when something changed (camera motion, resize, new model, settings),
 * lowers the resolution while a phone is being dragged, prefetches the other models of the project
 * in the background and caches up to three parsed scenes. Material quality is never reduced.
 */

export type SeeViewerAnnotation = Readonly<{ id: string; title: string; body: string; position: SeeVec3; imageFileId?: string; linkUrl?: string; linkLabel?: string }>;

export type SeeViewerScene = Readonly<{
  id: string;
  modelFileId: string;
  settings: SeeSceneSettings;
  annotations: readonly SeeViewerAnnotation[];
}>;

export type SeeViewerHandle = Readonly<{
  getCamera: () => SeeCameraView | undefined;
  resetCamera: () => void;
  fitModel: () => void;
  /** Smoothly moves the camera to a quick view of the current model. */
  setView: (preset: SeeViewPreset) => void;
  toggleFullscreen: () => void;
}>;

type Props = Readonly<{
  scene?: SeeViewerScene;
  resolveModelUrl: (fileId: string) => Promise<string>;
  /** Short-lived URL of a picture used in an annotation card (same authorization as models). */
  resolveImageUrl?: (fileId: string) => Promise<string>;
  /** Models of the other scenes — loaded in the background so switching is instant. */
  prefetchModelFileIds?: readonly string[];
  showAnnotations: boolean;
  selectedAnnotationId?: string;
  onSelectAnnotation?: (id: string | undefined) => void;
  pickMode?: boolean;
  onPick?: (point: SeeVec3, normal?: SeeVec3) => void;
  className?: string;
  emptyMessage?: string;
  /**
   * Element that goes fullscreen (default: the viewer itself). Pass the whole presentation so the
   * toolbars stay visible in fullscreen.
   */
  fullscreenRoot?: React.RefObject<HTMLElement | null>;
  onFullscreenChange?: (active: boolean) => void;
}>;

type LoadPhase = "resolve" | "download" | "process";

type LoadState =
  | Readonly<{ state: "idle" | "ready" }>
  | Readonly<{ state: "loading"; phase: LoadPhase; loaded?: number; total?: number }>
  | Readonly<{ state: "error"; message: string; retryable: boolean }>;

type LoadProgress = (phase: LoadPhase, loaded?: number, total?: number) => void;

/** Download failures worth one silent retry with a FRESH short-lived URL (expired / re-keyed URL, dropped connection). */
function isRetryableDownloadError(error: unknown): boolean {
  if (error instanceof TypeError) return true; // fetch: network failure
  const status = (error as { response?: { status?: number } } | null)?.response?.status;
  return typeof status === "number" && (status === 403 || status === 404 || status === 410 || status === 408 || status >= 500);
}

type Runtime = {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  envTexture: THREE.Texture;
  lights: { hemisphere: THREE.HemisphereLight; key: THREE.DirectionalLight; fill: THREE.DirectionalLight };
  loader: GLTFLoader;
  draco: DRACOLoader;
  ktx2: KTX2Loader;
  profile: SeeRenderProfile;
  models: Map<string, THREE.Object3D>;
  pending: Map<string, Promise<THREE.Object3D>>;
  current?: THREE.Object3D;
  raycaster: THREE.Raycaster;
  frame: number;
  disposed: boolean;
  /** Request one new frame (render-on-demand). */
  invalidate: () => void;
  /** Running quick-view camera transition (cancelled as soon as the user grabs the view). */
  tween?: { fromPosition: THREE.Vector3; toPosition: THREE.Vector3; fromTarget: THREE.Vector3; toTarget: THREE.Vector3; start: number; duration: number };
};

const round = (value: number) => Math.round(value * 10_000) / 10_000;
const toVec3 = (vector: THREE.Vector3): SeeVec3 => [round(vector.x), round(vector.y), round(vector.z)];

function deviceHints(maxAnisotropy: number) {
  const navigatorInfo = (typeof navigator !== "undefined" ? navigator : {}) as Navigator & { deviceMemory?: number; connection?: { saveData?: boolean; effectiveType?: string } };
  return {
    coarsePointer: typeof window !== "undefined" && Boolean(window.matchMedia?.("(pointer: coarse)").matches),
    devicePixelRatio: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
    deviceMemoryGb: navigatorInfo.deviceMemory,
    saveData: navigatorInfo.connection?.saveData,
    effectiveType: navigatorInfo.connection?.effectiveType,
    maxAnisotropy,
  };
}

const TEXTURE_SLOTS = ["map", "normalMap", "roughnessMap", "metalnessMap", "aoMap", "emissiveMap", "clearcoatMap", "clearcoatNormalMap", "clearcoatRoughnessMap", "sheenColorMap", "sheenRoughnessMap", "specularColorMap", "specularIntensityMap", "transmissionMap", "thicknessMap", "iridescenceMap", "anisotropyMap", "alphaMap", "bumpMap"] as const;

function disposeObject(root: THREE.Object3D) {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        if (value && typeof value === "object" && (value as THREE.Texture).isTexture) (value as THREE.Texture).dispose();
      }
      material.dispose();
    }
  });
}

/**
 * One-time preparation of a freshly parsed GLB: sharper texture filtering (quality up, never
 * down), static matrices (no per-frame matrix recomputation for big scene graphs).
 */
function prepareModel(root: THREE.Object3D, anisotropy: number) {
  root.updateMatrixWorld(true);
  root.traverse((node) => {
    node.matrixAutoUpdate = false;
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      const slots = material as unknown as Record<string, THREE.Texture | null | undefined>;
      for (const slot of TEXTURE_SLOTS) {
        const texture = slots[slot];
        if (texture?.isTexture && texture.anisotropy < anisotropy) {
          texture.anisotropy = anisotropy;
          texture.needsUpdate = true;
        }
      }
    }
  });
}

function applyLighting(runtime: Runtime, settings: SeeSceneSettings) {
  const { scene, renderer, lights } = runtime;
  renderer.toneMappingExposure = settings.exposure;
  scene.background = new THREE.Color(resolveBackgroundColor(settings));
  scene.environment = runtime.envTexture;
  switch (settings.lighting) {
    case "soft":
      scene.environmentIntensity = 0.9;
      lights.hemisphere.intensity = 1.1;
      lights.key.intensity = 0.5;
      lights.fill.intensity = 0.4;
      break;
    case "contrast":
      scene.environmentIntensity = 0.35;
      lights.hemisphere.intensity = 0.15;
      lights.key.intensity = 3.2;
      lights.fill.intensity = 0.2;
      break;
    default:
      scene.environmentIntensity = 1;
      lights.hemisphere.intensity = 0.35;
      lights.key.intensity = 1.6;
      lights.fill.intensity = 0.5;
  }
  runtime.invalidate();
}

function modelBounds(object: THREE.Object3D) {
  const box = new THREE.Box3().setFromObject(object);
  if (box.isEmpty()) box.set(new THREE.Vector3(-0.5, -0.5, -0.5), new THREE.Vector3(0.5, 0.5, 0.5));
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  return { box, sphere, radius: Math.max(sphere.radius, 1e-3) };
}

function fitCamera(runtime: Runtime) {
  const { camera, controls } = runtime;
  if (!runtime.current) return;
  const { sphere, radius } = modelBounds(runtime.current);
  // Fit the bounding sphere into the NARROWER of the two view angles (portrait phones).
  const view = fitView({ center: [sphere.center.x, sphere.center.y, sphere.center.z], radius, fov: camera.fov, aspect: camera.aspect });
  camera.position.set(...view.position);
  controls.target.set(...view.target);
  camera.updateProjectionMatrix();
  controls.update();
  runtime.invalidate();
}

function applyCamera(runtime: Runtime, view: SeeCameraView | undefined) {
  if (!view) {
    fitCamera(runtime);
    return;
  }
  runtime.camera.fov = view.fov;
  runtime.controls.target.set(...view.target);
  runtime.camera.position.set(...view.position);
  const factor = adaptSavedViewDistanceFactor(runtime.camera.aspect);
  if (factor !== 1) {
    const offset = runtime.camera.position.clone().sub(runtime.controls.target);
    runtime.camera.position.copy(runtime.controls.target).addScaledVector(offset, factor);
  }
  runtime.camera.updateProjectionMatrix();
  runtime.controls.update();
  runtime.invalidate();
}

function adaptClipping(runtime: Runtime) {
  if (!runtime.current) return;
  const { radius, sphere } = modelBounds(runtime.current);
  const { camera, controls, lights } = runtime;
  const clipping = clippingFor(radius);
  camera.near = clipping.near;
  camera.far = clipping.far;
  camera.updateProjectionMatrix();
  controls.minDistance = clipping.minDistance;
  controls.maxDistance = clipping.maxDistance;
  lights.key.position.copy(sphere.center).add(new THREE.Vector3(radius * 2, radius * 3, radius * 2));
  lights.fill.position.copy(sphere.center).add(new THREE.Vector3(-radius * 2.5, radius, -radius * 1.5));
  lights.key.target.position.copy(sphere.center);
  lights.fill.target.position.copy(sphere.center);
  for (const node of [lights.key, lights.fill, lights.key.target, lights.fill.target]) node.updateMatrixWorld();
}

function loadError(error: unknown): Readonly<{ message: string; retryable: boolean }> {
  const text = error instanceof Error ? error.message : "";
  if (/ktx|basis|transcod/iu.test(text)) return { message: "Textury KTX2 se na tomto zařízení nepodařilo dekódovat.", retryable: false };
  if (/draco|meshopt/iu.test(text)) return { message: "Model používá nepodporovanou kompresi geometrie.", retryable: false };
  if (isRetryableDownloadError(error)) return { message: "Model se nepodařilo stáhnout — spojení se přerušilo nebo vypršel přístup.", retryable: true };
  if (error instanceof SyntaxError || /JSON|glTF|Unsupported asset|buffer/iu.test(text)) return { message: "Soubor modelu je poškozený nebo v nepodporovaném formátu.", retryable: false };
  return { message: "3D model se nepodařilo načíst.", retryable: true };
}

export const SeeViewer = forwardRef<SeeViewerHandle, Props>(function SeeViewer(props, ref) {
  const { scene, resolveModelUrl, prefetchModelFileIds, showAnnotations, selectedAnnotationId, onSelectAnnotation, pickMode, onPick, className, emptyMessage, fullscreenRoot, onFullscreenChange } = props;
  const hostRef = useRef<HTMLDivElement>(null);
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const markerLayerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<Runtime | undefined>(undefined);
  const sceneRef = useRef(scene);
  const pickRef = useRef({ pickMode, onPick });
  const resolveRef = useRef(resolveModelUrl);
  const [load, setLoad] = useState<LoadState>({ state: "idle" });
  const [webglError, setWebglError] = useState<string | undefined>();
  const [reloadNonce, setReloadNonce] = useState(0);
  const fullscreenRef = useRef({ fullscreenRoot, onFullscreenChange });
  fullscreenRef.current = { fullscreenRoot, onFullscreenChange };

  sceneRef.current = scene;
  pickRef.current = { pickMode, onPick };
  resolveRef.current = resolveModelUrl;

  // ── one-time renderer setup ─────────────────────────────────────────
  useEffect(() => {
    const host = canvasHostRef.current;
    if (!host) return undefined;
    const initialProfile = seeRenderProfile(deviceHints(1));
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: initialProfile.antialias, alpha: false, powerPreference: initialProfile.powerPreference });
    } catch {
      setWebglError("Tento prohlížeč nebo zařízení nepodporuje WebGL, 3D model nelze zobrazit.");
      return undefined;
    }
    const profile = seeRenderProfile(deviceHints(renderer.capabilities.getMaxAnisotropy()));
    renderer.setPixelRatio(profile.pixelRatio);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    // Khronos PBR Neutral: reproduces base colours of product materials faithfully (no ACES hue shift).
    renderer.toneMapping = THREE.NeutralToneMapping;
    host.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";

    const threeScene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    camera.position.set(3, 2, 4);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;

    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const envTexture = pmrem.fromScene(room, 0.04).texture;
    room.traverse((node) => (node as THREE.Mesh).geometry?.dispose());
    pmrem.dispose();

    const hemisphere = new THREE.HemisphereLight(0xffffff, 0x8d8d8d, 0.35);
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5);
    threeScene.add(hemisphere, key, key.target, fill, fill.target);

    const draco = new DRACOLoader();
    draco.setDecoderPath("/see/draco/");
    const ktx2 = new KTX2Loader().setTranscoderPath("/see/basis/").detectSupport(renderer);
    const loader = new GLTFLoader();
    loader.setDRACOLoader(draco);
    loader.setKTX2Loader(ktx2);
    loader.setMeshoptDecoder(MeshoptDecoder);

    let needsRender = true;
    const runtime: Runtime = {
      renderer, scene: threeScene, camera, controls, envTexture,
      lights: { hemisphere, key, fill }, loader, draco, ktx2, profile,
      models: new Map(), pending: new Map(),
      raycaster: new THREE.Raycaster(), frame: 0, disposed: false,
      invalidate: () => { needsRender = true; },
    };
    runtimeRef.current = runtime;

    const resize = () => {
      const width = host.clientWidth || 1;
      const height = host.clientHeight || 1;
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = "100%";
      renderer.domElement.style.height = "100%";
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      runtime.invalidate();
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(host);

    // Lower resolution only while a phone is being dragged; full quality as soon as it rests.
    const onStart = () => {
      runtime.tween = undefined;
      if (profile.interactionPixelRatio < profile.pixelRatio) renderer.setPixelRatio(profile.interactionPixelRatio);
    };
    const onEnd = () => {
      if (renderer.getPixelRatio() !== profile.pixelRatio) {
        renderer.setPixelRatio(profile.pixelRatio);
        runtime.invalidate();
      }
    };
    controls.addEventListener("start", onStart);
    controls.addEventListener("end", onEnd);
    controls.addEventListener("change", runtime.invalidate);

    const projected = new THREE.Vector3();
    const toPoint = new THREE.Vector3();
    const direction = new THREE.Vector3();
    let lastRenderAt = 0;
    let occlusionPending = false;
    const updateMarkers = (checkOcclusion: boolean) => {
      const layer = markerLayerRef.current;
      if (!layer) return;
      const width = host.clientWidth;
      const height = host.clientHeight;
      for (const element of Array.from(layer.children) as HTMLElement[]) {
        const position = element.dataset.position?.split(",").map(Number);
        if (!position || position.length !== 3) continue;
        projected.set(position[0], position[1], position[2]).project(camera);
        const visible = projected.z > -1 && projected.z < 1;
        element.style.display = visible ? "" : "none";
        const x = (projected.x * 0.5 + 0.5) * width;
        const y = (-projected.y * 0.5 + 0.5) * height;
        element.style.transform = `translate(${x}px, ${y}px)`;
        // The card opens towards the free side, so a picture or link never ends up off-screen.
        element.dataset.side = y > height * 0.5 ? "above" : "below";
        element.dataset.align = x < 160 ? "start" : x > width - 160 ? "end" : "center";
        if (checkOcclusion && visible && runtime.current) {
          toPoint.set(position[0], position[1], position[2]);
          const distance = camera.position.distanceTo(toPoint);
          runtime.raycaster.set(camera.position, direction.copy(toPoint).sub(camera.position).normalize());
          runtime.raycaster.far = distance;
          const hit = runtime.raycaster.intersectObject(runtime.current, true)[0];
          element.dataset.occluded = hit && hit.distance < distance * 0.985 ? "true" : "false";
        }
      }
    };
    const animate = (time: number) => {
      if (runtime.disposed) return;
      runtime.frame = requestAnimationFrame(animate);
      const tween = runtime.tween;
      if (tween) {
        const progress = tween.duration > 0 ? Math.min(1, (performance.now() - tween.start) / tween.duration) : 1;
        const eased = easeInOutCubic(progress);
        camera.position.lerpVectors(tween.fromPosition, tween.toPosition, eased);
        controls.target.lerpVectors(tween.fromTarget, tween.toTarget, eased);
        if (progress >= 1) runtime.tween = undefined;
        needsRender = true;
      }
      const moving = controls.update();
      if (moving || needsRender) {
        needsRender = false;
        renderer.render(threeScene, camera);
        updateMarkers(false);
        lastRenderAt = time;
        occlusionPending = true;
      } else if (occlusionPending && time - lastRenderAt > 180) {
        // Raycasting against a large model is expensive: test marker occlusion once the view rests.
        occlusionPending = false;
        updateMarkers(true);
      }
    };
    runtime.frame = requestAnimationFrame(animate);

    const onContextLost = (event: Event) => {
      event.preventDefault();
      setWebglError("Grafický kontext byl ztracen (nedostatek paměti GPU). Obnovte stránku.");
    };
    renderer.domElement.addEventListener("webglcontextlost", onContextLost);

    let down: { x: number; y: number } | undefined;
    const onPointerDown = (event: PointerEvent) => { down = { x: event.clientX, y: event.clientY }; };
    const onPointerUp = (event: PointerEvent) => {
      const start = down;
      down = undefined;
      if (!start || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 6) return;
      const { pickMode: picking, onPick: pick } = pickRef.current;
      if (!picking || !pick || !runtime.current) return;
      const rect = renderer.domElement.getBoundingClientRect();
      const pointer = new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      runtime.raycaster.far = Infinity;
      runtime.raycaster.setFromCamera(pointer, camera);
      const hit = runtime.raycaster.intersectObject(runtime.current, true)[0];
      if (!hit) return;
      const normal = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : undefined;
      pick(toVec3(hit.point), normal ? toVec3(normal) : undefined);
    };
    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    // Long-press on touch screens must rotate the model, not open the browser's image menu.
    const onContextMenu = (event: Event) => event.preventDefault();
    renderer.domElement.addEventListener("contextmenu", onContextMenu);

    const fullscreenTarget = () => fullscreenRef.current.fullscreenRoot?.current ?? hostRef.current;
    const onFullscreen = () => {
      const target = fullscreenTarget();
      // Leaving native fullscreen (Esc / system gesture) must also drop the CSS fallback state.
      fullscreenRef.current.onFullscreenChange?.(isFullscreen(target));
      runtime.invalidate();
    };
    const onKey = (event: KeyboardEvent) => {
      const target = fullscreenTarget();
      if (event.key === "Escape" && target && !nativeFullscreenElement() && isFullscreen(target)) {
        void exitFullscreen(target).then(onFullscreen);
      }
    };
    document.addEventListener("fullscreenchange", onFullscreen);
    document.addEventListener("webkitfullscreenchange", onFullscreen);
    document.addEventListener("keydown", onKey);

    return () => {
      runtime.disposed = true;
      cancelAnimationFrame(runtime.frame);
      observer.disconnect();
      document.removeEventListener("fullscreenchange", onFullscreen);
      document.removeEventListener("webkitfullscreenchange", onFullscreen);
      document.removeEventListener("keydown", onKey);
      renderer.domElement.removeEventListener("contextmenu", onContextMenu);
      renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      controls.removeEventListener("start", onStart);
      controls.removeEventListener("end", onEnd);
      controls.removeEventListener("change", runtime.invalidate);
      controls.dispose();
      runtime.models.forEach(disposeObject);
      runtime.models.clear();
      envTexture.dispose();
      draco.dispose();
      ktx2.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      runtimeRef.current = undefined;
    };
  }, []);

  /** Load + parse one GLB once; concurrent requests (switch while prefetching) share the promise. */
  const loadModel = useCallback((runtime: Runtime, fileId: string, onProgress?: LoadProgress): Promise<THREE.Object3D> => {
    const cached = runtime.models.get(fileId);
    if (cached) return Promise.resolve(cached);
    const running = runtime.pending.get(fileId);
    if (running) return running;
    const download = async () => {
      onProgress?.("resolve");
      const url = await resolveRef.current(fileId);
      return runtime.loader.loadAsync(url, (event) => {
        const total = event.lengthComputable ? event.total : undefined;
        onProgress?.(total !== undefined && event.loaded >= total ? "process" : "download", event.loaded, total);
      });
    };
    const promise = download()
      // One silent retry with a fresh short-lived URL (URL expired / object re-keyed / dropped
      // connection). Access that was really revoked fails again in resolveModelUrl.
      .catch((error: unknown) => {
        if (runtime.disposed || !isRetryableDownloadError(error)) throw error;
        return new Promise((resolve) => setTimeout(resolve, 700)).then(download);
      })
      .then((gltf) => {
        if (runtime.disposed) {
          disposeObject(gltf.scene);
          throw new Error("viewer disposed");
        }
        prepareModel(gltf.scene, runtime.profile.anisotropy);
        // Keep at most maxCachedModels parsed scenes; never evict the one on screen.
        while (runtime.models.size >= runtime.profile.maxCachedModels) {
          const evictable = [...runtime.models.entries()].find(([, object]) => object !== runtime.current);
          if (!evictable) break;
          disposeObject(evictable[1]);
          runtime.models.delete(evictable[0]);
        }
        runtime.models.set(fileId, gltf.scene);
        return gltf.scene;
      })
      .finally(() => runtime.pending.delete(fileId));
    runtime.pending.set(fileId, promise);
    return promise;
  }, []);

  // ── scene (model) switching ─────────────────────────────────────────
  const sceneId = scene?.id;
  const modelFileId = scene?.modelFileId;
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime) return undefined;
    if (runtime.current) runtime.scene.remove(runtime.current);
    runtime.current = undefined;
    runtime.invalidate();
    if (!modelFileId) {
      setLoad({ state: "idle" });
      return undefined;
    }
    let cancelled = false;
    const show = (object: THREE.Object3D) => {
      if (cancelled || runtime.disposed) return;
      runtime.current = object;
      runtime.scene.add(object);
      adaptClipping(runtime);
      const current = sceneRef.current;
      if (current) applyLighting(runtime, current.settings);
      applyCamera(runtime, current?.settings.camera);
      setLoad({ state: "ready" });
    };
    const cached = runtime.models.get(modelFileId);
    if (cached) {
      show(cached);
    } else {
      // Joining a background prefetch: no byte progress for this listener, show an indeterminate bar.
      setLoad({ state: "loading", phase: runtime.pending.has(modelFileId) ? "download" : "resolve" });
      loadModel(runtime, modelFileId, (phase, loaded, total) => !cancelled && setLoad({ state: "loading", phase, loaded, total }))
        .then(show)
        .catch((error: unknown) => {
          if (cancelled || runtime.disposed) return;
          setLoad({ state: "error", ...loadError(error) });
        });
    }
    return () => { cancelled = true; };
  }, [sceneId, modelFileId, loadModel, reloadNonce]);

  // ── background prefetch of the other scenes (after the visible one is ready) ──
  const prefetchKey = seePrefetchOrder(prefetchModelFileIds ?? [], modelFileId).join(",");
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (!runtime || load.state !== "ready" || !prefetchKey || !runtime.profile.prefetchOtherModels) return undefined;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      for (const fileId of prefetchKey.split(",")) {
        if (cancelled || runtime.disposed || runtime.models.size >= runtime.profile.maxCachedModels) return;
        try {
          const object = await loadModel(runtime, fileId);
          // Compile shaders off-screen so the first switch does not stutter — only where the GPU
          // compiles in parallel; elsewhere a synchronous compile would block the visible model.
          if (!cancelled && !runtime.disposed && object !== runtime.current && runtime.renderer.extensions.has("KHR_parallel_shader_compile")) {
            await runtime.renderer.compileAsync(object, runtime.camera, runtime.scene).catch(() => undefined);
          }
        } catch {
          // Prefetch is best effort; a real switch shows the error state.
        }
      }
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [load.state, prefetchKey, loadModel]);

  // ── look (background / light / exposure) ────────────────────────────
  const settingsKey = scene ? JSON.stringify([scene.settings.background, scene.settings.backgroundColor, scene.settings.lighting, scene.settings.exposure]) : "";
  useEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime && sceneRef.current) applyLighting(runtime, sceneRef.current.settings);
  }, [settingsKey]);

  useImperativeHandle(ref, () => ({
    getCamera: () => {
      const runtime = runtimeRef.current;
      if (!runtime) return undefined;
      return { position: toVec3(runtime.camera.position), target: toVec3(runtime.controls.target), fov: round(runtime.camera.fov) };
    },
    resetCamera: () => {
      const runtime = runtimeRef.current;
      if (runtime) applyCamera(runtime, sceneRef.current?.settings.camera);
    },
    fitModel: () => {
      const runtime = runtimeRef.current;
      if (runtime) fitCamera(runtime);
    },
    setView: (preset: SeeViewPreset) => {
      const runtime = runtimeRef.current;
      if (!runtime?.current) return;
      const { camera, controls } = runtime;
      const saved = sceneRef.current?.settings.camera;
      let toPosition: THREE.Vector3;
      let toTarget: THREE.Vector3;
      if (preset === "default" && saved) {
        // "Výchozí / 3D" = the view the editor saved for this model (or the automatic framing).
        toTarget = new THREE.Vector3(...saved.target);
        toPosition = new THREE.Vector3(...saved.position).sub(toTarget).multiplyScalar(adaptSavedViewDistanceFactor(camera.aspect)).add(toTarget);
        camera.fov = saved.fov;
        camera.updateProjectionMatrix();
      } else {
        const { sphere, radius } = modelBounds(runtime.current);
        const view = presetView(preset, { center: [sphere.center.x, sphere.center.y, sphere.center.z], radius, fov: camera.fov, aspect: camera.aspect });
        toPosition = new THREE.Vector3(...view.position);
        toTarget = new THREE.Vector3(...view.target);
      }
      const reducedMotion = typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
      runtime.tween = { fromPosition: camera.position.clone(), toPosition, fromTarget: controls.target.clone(), toTarget, start: performance.now(), duration: reducedMotion ? 0 : 650 };
      runtime.invalidate();
    },
    toggleFullscreen: () => {
      const target = fullscreenRef.current.fullscreenRoot?.current ?? hostRef.current;
      if (!target) return;
      const done = () => {
        fullscreenRef.current.onFullscreenChange?.(isFullscreen(target));
        runtimeRef.current?.invalidate();
      };
      if (isFullscreen(target)) void exitFullscreen(target).then(done);
      else void enterFullscreen(target).then(done);
    },
  }), []);

  const select = useCallback((id: string) => onSelectAnnotation?.(selectedAnnotationId === id ? undefined : id), [onSelectAnnotation, selectedAnnotationId]);
  const annotations = showAnnotations && load.state === "ready" ? scene?.annotations ?? [] : [];

  // New / moved markers need one frame to get their screen position.
  const markersKey = annotations.map((annotation) => `${annotation.id}:${annotation.position.join(",")}`).join("|") + `|${selectedAnnotationId ?? ""}`;
  useEffect(() => {
    runtimeRef.current?.invalidate();
  }, [markersKey]);

  return (
    <div ref={hostRef} className={`seeViewer ${pickMode ? "seeViewerPicking" : ""} ${className ?? ""}`}>
      <div ref={canvasHostRef} className="seeViewerCanvas" />
      <div ref={markerLayerRef} className="seeMarkerLayer" aria-hidden={annotations.length === 0}>
        {annotations.map((annotation, index) => (
          <div key={annotation.id} className="seeMarker" data-position={annotation.position.join(",")} data-selected={annotation.id === selectedAnnotationId}>
            <button type="button" className="seeMarkerDot" onClick={() => select(annotation.id)} aria-label={annotation.title}>
              {index + 1}
            </button>
            {annotation.id === selectedAnnotationId && (
              <div className="seeMarkerCard" role="dialog" aria-label={annotation.title}>
                <strong>{annotation.title}</strong>
                {annotation.imageFileId && props.resolveImageUrl && <SeeImage fileId={annotation.imageFileId} resolve={props.resolveImageUrl} alt={annotation.title} className="seeMarkerImage" />}
                {annotation.body && <p>{annotation.body}</p>}
                {annotation.linkUrl && <SeeExternalLink link={{ url: annotation.linkUrl, label: annotation.linkLabel ?? "" }} className="seeMarkerLink" />}
              </div>
            )}
          </div>
        ))}
      </div>
      {webglError && (
        <div className="seeViewerState seeViewerError">
          <span>{webglError}</span>
          <button type="button" className="seeRetryButton" onClick={() => window.location.reload()}>Obnovit stránku</button>
        </div>
      )}
      {!webglError && !scene && <div className="seeViewerState">{emptyMessage ?? "Model zatím není nahraný."}</div>}
      {!webglError && scene && !scene.modelFileId && <div className="seeViewerState">{emptyMessage ?? "K tomuto modelu zatím není nahraný GLB soubor."}</div>}
      {!webglError && load.state === "loading" && <LoadingIndicator phase={load.phase} loaded={load.loaded} total={load.total} />}
      {!webglError && load.state === "error" && (
        <div className="seeViewerState seeViewerError" role="alert">
          <span>{load.message}</span>
          {load.retryable && <button type="button" className="seeRetryButton" onClick={() => setReloadNonce((value) => value + 1)}>Zkusit znovu</button>}
        </div>
      )}
    </div>
  );
});

/** Phase-aware progress for large models: access check → download (MB of MB) → processing. */
function LoadingIndicator({ phase, loaded, total }: Readonly<{ phase: LoadPhase; loaded?: number; total?: number }>) {
  const percent = total ? Math.min(100, Math.round(((loaded ?? 0) / total) * 100)) : undefined;
  const label = phase === "resolve"
    ? "Připravuji přístup k modelu…"
    : phase === "process"
      ? "Zpracovávám model (geometrie a textury)…"
      : total
        ? `Stahuji model ${formatFileSize(loaded ?? 0)} / ${formatFileSize(total)}`
        : `Stahuji model${loaded ? ` · ${formatFileSize(loaded)}` : "…"}`;
  return (
    <div className="seeViewerState seeLoading" role="status" aria-live="polite">
      <div className="seeSpinner" />
      <span>{label}</span>
      {phase !== "resolve" && (
        <div className="seeLoadingBar" aria-hidden="true">
          <span style={{ width: `${phase === "process" ? 100 : percent ?? 8}%` }} className={percent === undefined && phase === "download" ? "seeLoadingIndeterminate" : ""} />
        </div>
      )}
      {phase === "download" && total !== undefined && total > 30_000_000 && <small>Velký model — na mobilním připojení může stahování chvíli trvat.</small>}
    </div>
  );
}
