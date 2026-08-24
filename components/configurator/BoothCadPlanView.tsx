"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { createTopDownBoothPlanFrame } from "../../domain/cad3d";
import type { BoothPlanGlbLoadState } from "../../domain/boothPlan";
import type { BoothAssetDefinition, CadModelAsset } from "../../domain/models";
import {
  createBoothPlanCamera,
  disposeBoothPlanModel,
  loadBoothPlanModel,
} from "../../lib/boothPlanGlbRenderer";

export type BoothCadPlanLoadState = BoothPlanGlbLoadState;

type BoothCadPlanViewProps = Readonly<{
  asset?: CadModelAsset;
  boothAsset?: BoothAssetDefinition;
  constructionVisibility?: Readonly<Record<string, boolean>>;
  footprintWidthMm: number;
  footprintDepthMm: number;
  visible: boolean;
  selected: boolean;
  onLoadStateChange?: (state: BoothCadPlanLoadState) => void;
}>;

const EMPTY_CONSTRUCTION_VISIBILITY: Readonly<Record<string, boolean>> = {};

export function BoothCadPlanView({
  asset,
  boothAsset,
  constructionVisibility = EMPTY_CONSTRUCTION_VISIBILITY,
  footprintWidthMm,
  footprintDepthMm,
  visible,
  selected,
  onLoadStateChange,
}: BoothCadPlanViewProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const onLoadStateChangeRef = useRef(onLoadStateChange);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    onLoadStateChangeRef.current = onLoadStateChange;
  }, [onLoadStateChange]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount || !asset || footprintWidthMm <= 0 || footprintDepthMm <= 0) {
      setFailed(true);
      onLoadStateChangeRef.current?.("failed");
      return;
    }

    let active = true;
    let loadedModel: THREE.Object3D | null = null;
    const scene = new THREE.Scene();
    const camera = createBoothPlanCamera(
      footprintWidthMm,
      footprintDepthMm,
      boothAsset?.originConvention,
    );
    let renderer: THREE.WebGLRenderer;

    setFailed(false);
    onLoadStateChangeRef.current?.("loading");

    try {
      renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    } catch {
      setFailed(true);
      onLoadStateChangeRef.current?.("failed");
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

    void loadBoothPlanModel({
      asset,
      boothAsset,
      constructionVisibility,
      footprintWidthMm,
      footprintDepthMm,
      visible,
    }).then(
      (model) => {
        if (!active) {
          disposeBoothPlanModel(model);
          return;
        }
        loadedModel = model;
        scene.add(model);
        setFailed(false);
        onLoadStateChangeRef.current?.("ready");
        render();
      },
      () => {
        if (active) {
          setFailed(true);
          onLoadStateChangeRef.current?.("failed");
        }
      },
    );

    return () => {
      active = false;
      resizeObserver.disconnect();
      if (loadedModel) disposeBoothPlanModel(loadedModel);
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [
    asset,
    boothAsset,
    constructionVisibility,
    footprintDepthMm,
    footprintWidthMm,
    visible,
  ]);

  const frame = createTopDownBoothPlanFrame(
    footprintWidthMm,
    footprintDepthMm,
    boothAsset?.originConvention,
  );

  return (
    <div
      className={[
        "cadPlanLayer",
        selected ? "selected" : "",
        !visible ? "hidden" : "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{
        left: `${frame.layerLeftPercent}%`,
        top: `${frame.layerTopPercent}%`,
        width: `${frame.layerWidthPercent}%`,
        height: `${frame.layerHeightPercent}%`,
      }}
      data-plan-source="glb-top-view"
      aria-hidden="true"
    >
      <div ref={mountRef} className="cadPlanMount" />
      {failed && (
        <span className="cadPlanError">GLB top-view není dostupný</span>
      )}
    </div>
  );
}
