import * as THREE from "three";
import type { PrintSurface } from "../domain/models.ts";
import type {
  GraphicFileReference,
  PrintSurfaceAssignment,
} from "../domain/project.ts";
import { resolvePrintSurfaceBinding } from "../domain/printSurfaces.ts";
import {
  calculateArtworkUvTransform,
  type ArtworkUvTransform,
} from "../domain/artworkPlacement.ts";

export const PRINT_ARTWORK_OVERLAY_MARKER = "hwsPrintArtworkOverlay";
const PRINT_ARTWORK_APPLY_TOKEN = "hwsPrintArtworkApplyToken";
const FACE_OFFSET_MM = 0.1;

export type PrintArtworkOverlayMetadata = Readonly<{
  printSurfaceId: string;
  artworkFileId: string;
  nodeName: string;
  face: "front" | "back";
  localNormalAxis: "-y" | "+y";
  artworkRightAxis: "+x" | "-x";
  artworkUpAxis: "+z";
  canonicalWidthMm: number;
  canonicalHeightMm: number;
  sourceWidthPx: number;
  sourceHeightPx: number;
  uvTransform: ArtworkUvTransform;
}>;

export type PrintArtworkDecorationResult = Readonly<{
  appliedSurfaceIds: readonly string[];
  sourceOnlySurfaceIds: readonly string[];
  unresolvedSurfaceIds: readonly string[];
}>;

export type PrintArtworkTextureLoader = (
  url: string,
  file: GraphicFileReference,
) => Promise<THREE.Texture>;

export function isRasterArtworkFile(
  file: Pick<GraphicFileReference, "mimeType" | "name">,
): boolean {
  const mimeType = file.mimeType.toLowerCase();
  if (["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(mimeType)) {
    return true;
  }
  return /\.(png|jpe?g|webp)$/iu.test(file.name);
}

export function artworkPreviewLabel(
  file: Pick<GraphicFileReference, "mimeType" | "name">,
): string {
  if (isRasterArtworkFile(file)) return "3D náhled aktivní";
  if (file.mimeType.toLowerCase() === "application/pdf" || /\.pdf$/iu.test(file.name)) {
    return "Produkční PDF · pro 3D náhled nahrajte PNG, JPG nebo WebP";
  }
  return "Produkční zdroj · bez 3D náhledu";
}

function modelUnitsPerMillimeter(modelUnit: "mm" | "m"): number {
  return modelUnit === "m" ? 0.001 : 1;
}

/** Bounds of an authored node expressed back in that node's own local coordinates. */
export function objectLocalBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateWorldMatrix(true, true);
  const worldToRoot = root.matrixWorld.clone().invert();
  const bounds = new THREE.Box3();
  root.traverse((object) => {
    if (object.userData[PRINT_ARTWORK_OVERLAY_MARKER]) return;
    const geometry = (object as THREE.Mesh).geometry;
    if (!geometry) return;
    if (!geometry.boundingBox) geometry.computeBoundingBox();
    if (!geometry.boundingBox) return;
    const objectToRoot = worldToRoot.clone().multiply(object.matrixWorld);
    bounds.union(geometry.boundingBox.clone().applyMatrix4(objectToRoot));
  });
  return bounds;
}

export function createPrintArtworkOverlayGeometry(input: Readonly<{
  surface: Pick<PrintSurface, "widthMm" | "heightMm">;
  face: "front" | "back";
  nodeBounds: THREE.Box3;
  modelUnit: "mm" | "m";
}>): THREE.BufferGeometry {
  const unit = modelUnitsPerMillimeter(input.modelUnit);
  const halfWidth = input.surface.widthMm * unit / 2;
  const halfHeight = input.surface.heightMm * unit / 2;
  const center = input.nodeBounds.getCenter(new THREE.Vector3());
  const y = input.face === "front"
    ? input.nodeBounds.min.y - FACE_OFFSET_MM * unit
    : input.nodeBounds.max.y + FACE_OFFSET_MM * unit;
  const leftX = input.face === "front" ? center.x - halfWidth : center.x + halfWidth;
  const rightX = input.face === "front" ? center.x + halfWidth : center.x - halfWidth;
  const bottomZ = center.z - halfHeight;
  const topZ = center.z + halfHeight;
  const positions = new Float32Array([
    leftX, y, bottomZ,
    rightX, y, bottomZ,
    rightX, y, topZ,
    leftX, y, topZ,
  ]);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([
    0, 0,
    1, 0,
    1, 1,
    0, 1,
  ]), 2));
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  geometry.computeVertexNormals();
  geometry.computeBoundingBox();
  return geometry;
}

function disposeOverlay(overlay: THREE.Object3D): void {
  const mesh = overlay as THREE.Mesh;
  mesh.geometry?.dispose();
  const materials = Array.isArray(mesh.material)
    ? mesh.material
    : mesh.material
      ? [mesh.material]
      : [];
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) value.dispose();
    }
    material.dispose();
  }
}

function removeAndDisposeOverlay(overlay: THREE.Object3D): void {
  overlay.removeFromParent();
  disposeOverlay(overlay);
}

export function clearPrintArtworkOverlays(scene: THREE.Object3D): number {
  scene.userData[PRINT_ARTWORK_APPLY_TOKEN] = `cleared-${Date.now()}-${Math.random()}`;
  const overlays: THREE.Object3D[] = [];
  scene.traverse((object) => {
    if (object.userData[PRINT_ARTWORK_OVERLAY_MARKER]) overlays.push(object);
  });
  for (const overlay of overlays) {
    removeAndDisposeOverlay(overlay);
  }
  return overlays.length;
}

export function findPrintArtworkOverlays(scene: THREE.Object3D): readonly THREE.Mesh[] {
  const overlays: THREE.Mesh[] = [];
  scene.traverse((object) => {
    if (object.userData[PRINT_ARTWORK_OVERLAY_MARKER]) overlays.push(object as THREE.Mesh);
  });
  return overlays;
}

async function defaultTextureLoader(url: string): Promise<THREE.Texture> {
  return new THREE.TextureLoader().loadAsync(url);
}

function textureSourceDimensions(
  file: GraphicFileReference,
  texture: THREE.Texture,
  surface: Pick<PrintSurface, "widthMm" | "heightMm">,
): Readonly<{ widthPx: number; heightPx: number }> {
  const image = texture.image as {
    naturalWidth?: number;
    naturalHeight?: number;
    videoWidth?: number;
    videoHeight?: number;
    width?: number;
    height?: number;
  } | undefined;
  const widthPx = file.widthPx ?? image?.naturalWidth ?? image?.videoWidth ?? image?.width;
  const heightPx = file.heightPx ?? image?.naturalHeight ?? image?.videoHeight ?? image?.height;
  return widthPx && heightPx && widthPx > 0 && heightPx > 0
    ? { widthPx, heightPx }
    : { widthPx: surface.widthMm, heightPx: surface.heightMm };
}

function configureArtworkTexture(
  texture: THREE.Texture,
  transform: ArtworkUvTransform,
  initialize: boolean,
): void {
  texture.flipY = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.repeat.set(transform.repeatU, transform.repeatV);
  texture.offset.set(transform.offsetU, transform.offsetV);
  texture.center.set(0, 0);
  texture.rotation = 0;
  texture.matrixAutoUpdate = true;
  texture.updateMatrix();
  if (initialize) texture.needsUpdate = true;
}

function createArtworkMaterial(texture: THREE.Texture): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    side: THREE.FrontSide,
    transparent: true,
    depthTest: true,
    depthWrite: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
    toneMapped: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#ifdef USE_MAP
        vec2 hwsArtworkUv = vMapUv;
        if (hwsArtworkUv.x < 0.0 || hwsArtworkUv.x > 1.0 || hwsArtworkUv.y < 0.0 || hwsArtworkUv.y > 1.0) discard;
        vec4 sampledDiffuseColor = texture2D(map, hwsArtworkUv);
        diffuseColor *= sampledDiffuseColor;
      #endif`,
    );
  };
  material.customProgramCacheKey = () => "hws-artwork-surface-clip-v1";
  return material;
}

/**
 * Below-this-alpha texels are not "printed" — matches the artwork material's own transparent
 * contract (near-zero alpha reads as fully see-through), not an arbitrary cutoff.
 */
const ARTWORK_MASK_ALPHA_THRESHOLD = 0.02;

/**
 * The Artwork Mask control pass's per-overlay material (v3.2 fix — report section 3/5): reuses
 * the SAME texture object the beauty material already has bound (no re-upload, no second shader
 * pipeline), and the exact same "clip outside this overlay's own UV rect" technique as
 * createArtworkMaterial above, but outputs flat opaque WHITE only where the artwork's own alpha
 * channel is above {@link ARTWORK_MASK_ALPHA_THRESHOLD} — discards (leaves the pass's black
 * background) everywhere else, including the transparent parts of the source PNG/WebP. This is
 * what makes the mask track the actually-printed pixels rather than the full rectangular overlay
 * quad. depthTest/depthWrite stay on so a BACK-face overlay occluded by its own panel in Beauty
 * stays occluded here too (report section 4) — never a special-cased visibility toggle.
 */
export function createArtworkMaskMaterial(texture: THREE.Texture): THREE.MeshBasicMaterial {
  const material = new THREE.MeshBasicMaterial({
    map: texture,
    color: 0xffffff,
    side: THREE.FrontSide,
    transparent: false,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
  });
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      "#include <map_fragment>",
      `#ifdef USE_MAP
        vec2 hwsArtworkUv = vMapUv;
        if (hwsArtworkUv.x < 0.0 || hwsArtworkUv.x > 1.0 || hwsArtworkUv.y < 0.0 || hwsArtworkUv.y > 1.0) discard;
        vec4 hwsArtworkSample = texture2D(map, hwsArtworkUv);
        if (hwsArtworkSample.a < ${ARTWORK_MASK_ALPHA_THRESHOLD.toFixed(3)}) discard;
        diffuseColor = vec4(1.0, 1.0, 1.0, 1.0);
      #endif`,
    );
  };
  material.customProgramCacheKey = () => "hws-artwork-mask-alpha-v1";
  return material;
}

/**
 * Re-applies project artwork to one freshly loaded or already-live booth scene. Explicit
 * printSurface.sceneBinding is the only mapping source. Each overlay owns its geometry,
 * material and texture so FRONT/BACK can be changed and disposed independently.
 */
export async function applyPrintArtworkOverlays(input: Readonly<{
  scene: THREE.Object3D;
  printSurfaces: readonly PrintSurface[];
  printSurfaceAssignments: readonly PrintSurfaceAssignment[];
  graphicsFiles: readonly GraphicFileReference[];
  modelUnit: "mm" | "m";
  resolveArtworkUrl: (file: GraphicFileReference) => Promise<string | undefined>;
  loadTexture?: PrintArtworkTextureLoader;
}>): Promise<PrintArtworkDecorationResult> {
  const token = `${Date.now()}-${Math.random()}`;
  input.scene.userData[PRINT_ARTWORK_APPLY_TOKEN] = token;

  const appliedSurfaceIds: string[] = [];
  const sourceOnlySurfaceIds: string[] = [];
  const unresolvedSurfaceIds: string[] = [];
  const loadTexture = input.loadTexture ?? defaultTextureLoader;

  const existingBySurface = new Map<string, THREE.Mesh>();
  for (const overlay of findPrintArtworkOverlays(input.scene)) {
    const metadata = overlay.userData[PRINT_ARTWORK_OVERLAY_MARKER] as PrintArtworkOverlayMetadata | undefined;
    if (!metadata || existingBySurface.has(metadata.printSurfaceId)) {
      removeAndDisposeOverlay(overlay);
      continue;
    }
    existingBySurface.set(metadata.printSurfaceId, overlay);
  }

  const desiredSurfaceIds = new Set(input.printSurfaceAssignments.flatMap((assignment) => {
    if (!assignment.artworkFileId) return [];
    const binding = resolvePrintSurfaceBinding(input.printSurfaces, assignment.printSurfaceId);
    const file = input.graphicsFiles.find((candidate) => candidate.id === assignment.artworkFileId);
    const target = binding ? input.scene.getObjectByName(binding.nodeName) : undefined;
    return binding && file && target && isRasterArtworkFile(file)
      ? [assignment.printSurfaceId]
      : [];
  }));
  for (const [surfaceId, overlay] of existingBySurface) {
    const assignment = input.printSurfaceAssignments.find((item) => item.printSurfaceId === surfaceId);
    const binding = resolvePrintSurfaceBinding(input.printSurfaces, surfaceId);
    const metadata = overlay.userData[PRINT_ARTWORK_OVERLAY_MARKER] as PrintArtworkOverlayMetadata;
    if (!desiredSurfaceIds.has(surfaceId) || !assignment?.artworkFileId ||
      metadata.artworkFileId !== assignment.artworkFileId ||
      !binding || overlay.parent !== input.scene.getObjectByName(binding.nodeName)) {
      removeAndDisposeOverlay(overlay);
      existingBySurface.delete(surfaceId);
    }
  }

  await Promise.all(input.printSurfaceAssignments.map(async (assignment) => {
    try {
      if (!assignment.artworkFileId) return;
      const binding = resolvePrintSurfaceBinding(input.printSurfaces, assignment.printSurfaceId);
      const file = input.graphicsFiles.find((candidate) => candidate.id === assignment.artworkFileId);
      if (!binding || !file) {
        unresolvedSurfaceIds.push(assignment.printSurfaceId);
        return;
      }
      if (!isRasterArtworkFile(file)) {
        sourceOnlySurfaceIds.push(assignment.printSurfaceId);
        return;
      }
      const target = input.scene.getObjectByName(binding.nodeName);
      if (!target) {
        unresolvedSurfaceIds.push(assignment.printSurfaceId);
        return;
      }
      let overlay = existingBySurface.get(binding.printSurfaceId);
      let texture = overlay
        ? (overlay.material as THREE.MeshBasicMaterial).map
        : undefined;
      const initializeTexture = !texture;
      if (!texture) {
        const url = await input.resolveArtworkUrl(file);
        if (!url) {
          unresolvedSurfaceIds.push(assignment.printSurfaceId);
          return;
        }
        texture = await loadTexture(url, file);
        if (input.scene.userData[PRINT_ARTWORK_APPLY_TOKEN] !== token) {
          texture.dispose();
          return;
        }
      }
      const source = textureSourceDimensions(file, texture, binding.surface);
      const uvTransform = calculateArtworkUvTransform({
        surfaceWidthMm: binding.surface.widthMm,
        surfaceHeightMm: binding.surface.heightMm,
        sourceWidthPx: source.widthPx,
        sourceHeightPx: source.heightPx,
        placement: assignment.artworkPlacement,
      });
      configureArtworkTexture(texture, uvTransform, initializeTexture);
      if (!overlay) {
        const nodeBounds = objectLocalBounds(target);
        if (nodeBounds.isEmpty()) {
          texture.dispose();
          unresolvedSurfaceIds.push(assignment.printSurfaceId);
          return;
        }
        const geometry = createPrintArtworkOverlayGeometry({
          surface: binding.surface,
          face: binding.face,
          nodeBounds,
          modelUnit: input.modelUnit,
        });
        overlay = new THREE.Mesh(geometry, createArtworkMaterial(texture));
      }
      const metadata: PrintArtworkOverlayMetadata = {
        printSurfaceId: binding.printSurfaceId,
        artworkFileId: file.id,
        nodeName: binding.nodeName,
        face: binding.face,
        localNormalAxis: binding.localNormalAxis,
        artworkRightAxis: binding.face === "front" ? "+x" : "-x",
        artworkUpAxis: "+z",
        canonicalWidthMm: binding.surface.widthMm,
        canonicalHeightMm: binding.surface.heightMm,
        sourceWidthPx: source.widthPx,
        sourceHeightPx: source.heightPx,
        uvTransform,
      };
      overlay.name = `HWS_ARTWORK__${binding.printSurfaceId}`;
      overlay.renderOrder = 10;
      overlay.userData[PRINT_ARTWORK_OVERLAY_MARKER] = metadata;
      if (!overlay.parent) target.add(overlay);
      appliedSurfaceIds.push(binding.printSurfaceId);
    } catch {
      if (!unresolvedSurfaceIds.includes(assignment.printSurfaceId)) {
        unresolvedSurfaceIds.push(assignment.printSurfaceId);
      }
    }
  }));

  return { appliedSurfaceIds, sourceOnlySurfaceIds, unresolvedSurfaceIds };
}
