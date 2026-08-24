import * as THREE from "three";
import type { PrintSurface } from "../domain/models.ts";
import type {
  GraphicFileReference,
  PrintSurfaceAssignment,
} from "../domain/project.ts";
import { resolvePrintSurfaceBinding } from "../domain/printSurfaces.ts";

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

export function clearPrintArtworkOverlays(scene: THREE.Object3D): number {
  scene.userData[PRINT_ARTWORK_APPLY_TOKEN] = `cleared-${Date.now()}-${Math.random()}`;
  const overlays: THREE.Object3D[] = [];
  scene.traverse((object) => {
    if (object.userData[PRINT_ARTWORK_OVERLAY_MARKER]) overlays.push(object);
  });
  for (const overlay of overlays) {
    overlay.removeFromParent();
    disposeOverlay(overlay);
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
  clearPrintArtworkOverlays(input.scene);
  input.scene.userData[PRINT_ARTWORK_APPLY_TOKEN] = token;

  const appliedSurfaceIds: string[] = [];
  const sourceOnlySurfaceIds: string[] = [];
  const unresolvedSurfaceIds: string[] = [];
  const loadTexture = input.loadTexture ?? defaultTextureLoader;

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
      const url = await input.resolveArtworkUrl(file);
      if (!url) {
        unresolvedSurfaceIds.push(assignment.printSurfaceId);
        return;
      }
      const texture = await loadTexture(url, file);
      if (input.scene.userData[PRINT_ARTWORK_APPLY_TOKEN] !== token) {
        texture.dispose();
        return;
      }
      texture.flipY = true;
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.needsUpdate = true;
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
      const overlay = new THREE.Mesh(geometry, material);
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
      };
      overlay.name = `HWS_ARTWORK__${binding.printSurfaceId}`;
      overlay.renderOrder = 10;
      overlay.userData[PRINT_ARTWORK_OVERLAY_MARKER] = metadata;
      target.add(overlay);
      appliedSurfaceIds.push(binding.printSurfaceId);
    } catch {
      if (!unresolvedSurfaceIds.includes(assignment.printSurfaceId)) {
        unresolvedSurfaceIds.push(assignment.printSurfaceId);
      }
    }
  }));

  return { appliedSurfaceIds, sourceOnlySurfaceIds, unresolvedSurfaceIds };
}
