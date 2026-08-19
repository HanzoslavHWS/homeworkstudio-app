"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import {
  CAD_TO_VIEWER_ROTATION_X_RAD,
  SCENE_UNITS_PER_MILLIMETER,
  mmToSceneUnits,
} from "../../domain/cad3d";
import type { CadModelAsset } from "../../domain/models";

export type CadPlanBounds = {
  minX: number;
  minY: number;
  width: number;
  depth: number;
};

export type CadPlanSnapshot = Readonly<{
  imageDataUrl: string;
  bounds: CadPlanBounds;
}>;

type BoothCadPlanViewProps = {
  asset?: CadModelAsset;
  footprintWidthMm: number;
  footprintDepthMm: number;
  visible: boolean;
  selected: boolean;
  onSnapshot?: (snapshot: CadPlanSnapshot) => void;
};

function disposePlanModel(root: THREE.Object3D) {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose();
    const material = (object as THREE.LineSegments).material ?? mesh.material;
    const materials = Array.isArray(material) ? material : material ? [material] : [];
    materials.forEach((item) => item.dispose());
  });
}

export function BoothCadPlanView({
  asset,
  footprintWidthMm,
  footprintDepthMm,
  visible,
  selected,
  onSnapshot,
}: BoothCadPlanViewProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [bounds, setBounds] = useState<CadPlanBounds | null>(null);
  const [failed, setFailed] = useState(false);
  const onSnapshotRef = useRef(onSnapshot);

  useEffect(() => {
    onSnapshotRef.current = onSnapshot;
  }, [onSnapshot]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !asset) {
      setFailed(true);
      return;
    }

    let active = true;
    let loadedModel: THREE.Object3D | null = null;
    const scene = new THREE.Scene();
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
    let renderer: THREE.WebGLRenderer;

    try {
      renderer = new THREE.WebGLRenderer({
        alpha: true,
        antialias: true,
        preserveDrawingBuffer: true,
      });
    } catch {
      setFailed(true);
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x000000, 0);
    renderer.domElement.className = "cadPlanCanvas";
    mount.appendChild(renderer.domElement);

    const render = () => {
      const width = Math.max(1, mount.clientWidth);
      const height = Math.max(1, mount.clientHeight);
      renderer.setSize(width, height, false);
      renderer.render(scene, camera);
    };
    const resizeObserver = new ResizeObserver(render);
    resizeObserver.observe(mount);

    new GLTFLoader().load(
      asset.url,
      (gltf) => {
        if (!active) {
          disposePlanModel(gltf.scene);
          return;
        }

        const rawBounds = new THREE.Box3().setFromObject(gltf.scene);
        const rawSize = rawBounds.getSize(new THREE.Vector3());
        const rawCenter = rawBounds.getCenter(new THREE.Vector3());
        const planBounds = {
          minX: rawBounds.min.x,
          minY: rawBounds.min.y,
          width: rawSize.x,
          depth: rawSize.y,
        };
        setBounds(planBounds);

        gltf.scene.scale.setScalar(SCENE_UNITS_PER_MILLIMETER);
        gltf.scene.rotation.x = CAD_TO_VIEWER_ROTATION_X_RAD;

        gltf.scene.traverse((object) => {
          const mesh = object as THREE.Mesh;
          if (!mesh.isMesh) {
            return;
          }
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

        loadedModel = gltf.scene;
        scene.add(gltf.scene);

        const halfWidth = mmToSceneUnits(rawSize.x) / 2;
        const halfDepth = mmToSceneUnits(rawSize.y) / 2;
        camera.left = -halfWidth;
        camera.right = halfWidth;
        camera.top = halfDepth;
        camera.bottom = -halfDepth;
        camera.position.set(
          mmToSceneUnits(rawCenter.x),
          mmToSceneUnits(rawBounds.max.z) + 2,
          -mmToSceneUnits(rawCenter.y),
        );
        // Root-cause fix (2026-08-19): up=(0,0,1) here made this top-down camera's own
        // screen-right equal world -X (a real mirror — verified via THREE.Matrix4.lookAt's
        // right = up × (eye-target) construction) while every OTHER view in the app
        // (cadPointToViewer's viewer frame, the front-facing default 3D camera) keeps
        // screen-right = world +X. up=(0,0,-1) is the correct up vector for THIS camera
        // orientation (looking straight down -Y): it makes screen-right = +X (matching
        // everywhere else) AND screen-up = the back-wall direction (matching the 2D plan's
        // "back wall at top" convention) — both at once, with no CSS/canvas rotate needed
        // downstream (see the DOM style below and lib/planExport.ts's drawImage call).
        camera.up.set(0, 0, -1);
        camera.lookAt(
          mmToSceneUnits(rawCenter.x),
          0,
          -mmToSceneUnits(rawCenter.y),
        );
        camera.updateProjectionMatrix();
        setFailed(false);
        render();
        onSnapshotRef.current?.({
          imageDataUrl: renderer.domElement.toDataURL("image/png"),
          bounds: planBounds,
        });
      },
      undefined,
      () => {
        if (active) {
          setFailed(true);
        }
      },
    );

    return () => {
      active = false;
      resizeObserver.disconnect();
      if (loadedModel) {
        disposePlanModel(loadedModel);
      }
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [asset]);

  // Same X-preserving/Y-flipping convention as domain/planView.ts's worldToPlanView — the
  // raw snapshot is now rendered in the correct orientation by the camera setup above, so this
  // is a direct footprint-relative placement, never a CSS rotate/mirror compensation. Exact
  // regardless of whether the model's bounding box is centered on the footprint (the old
  // "flip-then-180-rotate" compensation this replaced was only exact for a centered model —
  // this formula has no such dependency).
  const style = bounds
    ? {
        left: `${(bounds.minX / footprintWidthMm) * 100}%`,
        top: `${((footprintDepthMm - bounds.minY - bounds.depth) / footprintDepthMm) * 100}%`,
        width: `${(bounds.width / footprintWidthMm) * 100}%`,
        height: `${(bounds.depth / footprintDepthMm) * 100}%`,
      }
    : { inset: 0 };

  return (
    <div
      className={[
        "cadPlanLayer",
        selected ? "selected" : "",
        !visible ? "hidden" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={style}
      aria-hidden="true"
    >
      <div ref={mountRef} className="cadPlanMount" />
      {failed && <span className="cadPlanError">CAD půdorys není dostupný</span>}
    </div>
  );
}
