/**
 * HWS SEE viewer rendering profile per device. Pure (testable in Node). The goal is a fluid viewer
 * on phones WITHOUT touching material quality: PBR materials, texture color spaces and mipmaps are
 * never altered; only the render resolution, MSAA, background prefetching and texture filtering
 * adapt to the device.
 */

export type SeeDeviceHints = Readonly<{
  /** (pointer: coarse) — phones / tablets */
  coarsePointer: boolean;
  devicePixelRatio: number;
  /** navigator.deviceMemory in GB when the browser exposes it */
  deviceMemoryGb?: number;
  /** navigator.connection.saveData / effectiveType */
  saveData?: boolean;
  effectiveType?: string;
  /** renderer.capabilities.getMaxAnisotropy() */
  maxAnisotropy?: number;
}>;

export type SeeRenderProfile = Readonly<{
  /** pixel ratio while the view is still (full quality) */
  pixelRatio: number;
  /** pixel ratio while the user drags / pinches (restored to pixelRatio when the gesture ends) */
  interactionPixelRatio: number;
  antialias: boolean;
  powerPreference: "high-performance" | "default";
  /** load the other models of the project in the background after the first one is shown */
  prefetchOtherModels: boolean;
  /** anisotropic filtering applied to every material texture (sharper textures at grazing angles) */
  anisotropy: number;
  /** loaded GLB scenes kept in GPU memory (switching between them is then instant) */
  maxCachedModels: number;
}>;

export function seeRenderProfile(hints: SeeDeviceHints): SeeRenderProfile {
  const dpr = Number.isFinite(hints.devicePixelRatio) && hints.devicePixelRatio > 0 ? hints.devicePixelRatio : 1;
  const lowMemory = hints.deviceMemoryGb !== undefined && hints.deviceMemoryGb <= 2;
  const slowNetwork = hints.saveData === true || hints.effectiveType === "slow-2g" || hints.effectiveType === "2g";
  const pixelRatio = Math.min(dpr, hints.coarsePointer ? (lowMemory ? 1.25 : 1.75) : 2);
  return {
    pixelRatio,
    interactionPixelRatio: hints.coarsePointer ? Math.min(pixelRatio, 1) : pixelRatio,
    // A ≥2× phone screen hides aliasing; skipping MSAA there saves a lot of fill rate.
    antialias: !(hints.coarsePointer && dpr >= 2),
    powerPreference: hints.coarsePointer ? "default" : "high-performance",
    prefetchOtherModels: !slowNetwork && !lowMemory,
    anisotropy: Math.max(1, Math.min(hints.coarsePointer ? 4 : 8, hints.maxAnisotropy ?? 1)),
    maxCachedModels: lowMemory ? 1 : 3,
  };
}
