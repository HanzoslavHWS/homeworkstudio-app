"use client";

import { useEffect, useState } from "react";
import { resolveBoothAssetDefinition } from "../../domain/boothAssets";
import {
  resolveBoothPlanPresentation,
  resolveBoothPlanVisualMode,
  shouldRenderCanonicalBoothConstruction,
} from "../../domain/boothPlan";
import type { BoothType, CadModelAsset } from "../../domain/models";
import {
  BoothCadPlanView,
  type BoothCadPlanLoadState,
} from "./BoothCadPlanView";

type BoothConstructionPlanViewProps = Readonly<{
  booth: BoothType;
  asset?: CadModelAsset;
  constructionVisibility?: Readonly<Record<string, boolean>>;
  visible: boolean;
  selected: boolean;
  onVisualReadyChange?: (ready: boolean) => void;
}>;

export function BoothConstructionPlanView({
  booth,
  asset,
  constructionVisibility = {},
  visible,
  selected,
  onVisualReadyChange,
}: BoothConstructionPlanViewProps) {
  const visualMode = resolveBoothPlanVisualMode(booth, asset);
  const [glbLoadState, setGlbLoadState] =
    useState<BoothCadPlanLoadState>("loading");
  useEffect(() => {
    setGlbLoadState(visualMode === "glb-top-view" ? "loading" : "failed");
  }, [asset?.id, asset?.url, visualMode]);

  const plan = resolveBoothPlanPresentation(booth, {
    ...constructionVisibility,
    assembly: visible,
  });
  const showCanonicalConstruction = shouldRenderCanonicalBoothConstruction(
    visualMode,
    glbLoadState,
  );
  const visualReady =
    visualMode === "canonical-fallback" || glbLoadState !== "loading";
  useEffect(() => {
    onVisualReadyChange?.(visualReady);
  }, [onVisualReadyChange, visualReady]);
  return (
    <>
      {visualMode === "glb-top-view" && booth.widthMm && booth.depthMm && (
        <BoothCadPlanView
          asset={asset}
          boothAsset={resolveBoothAssetDefinition(booth)}
          constructionVisibility={constructionVisibility}
          footprintWidthMm={booth.widthMm}
          footprintDepthMm={booth.depthMm}
          visible={visible}
          selected={selected}
          onLoadStateChange={setGlbLoadState}
        />
      )}
      <div
        className={[
          "canonicalBoothPlanLayer",
          selected ? "selected" : "",
          !visible ? "hidden" : "",
        ]
          .filter(Boolean)
          .join(" ")}
        data-visual-mode={
          showCanonicalConstruction ? "canonical-fallback" : "glb-top-view"
        }
        aria-hidden="true"
      >
        <svg
          viewBox={`0 0 ${booth.widthMm} ${booth.depthMm}`}
          preserveAspectRatio="none"
        >
          {showCanonicalConstruction && (
            <>
              <g className="canonicalBoothConstructionAreas">
                {plan.constructionAreas.map(({ id, rect }) => (
                  <rect
                    key={id}
                    className="canonicalBoothConstructionArea"
                    x={rect.x}
                    y={rect.y}
                    width={rect.width}
                    height={rect.height}
                  />
                ))}
              </g>
              <g className="canonicalBoothConstructionProfiles">
                {plan.constructionProfiles.map(({ id, rect }) => (
                  <rect
                    key={id}
                    className="canonicalBoothConstructionProfile"
                    x={rect.x}
                    y={rect.y}
                    width={rect.width}
                    height={rect.height}
                    rx="8"
                  />
                ))}
              </g>
            </>
          )}
        </svg>
      </div>
    </>
  );
}
