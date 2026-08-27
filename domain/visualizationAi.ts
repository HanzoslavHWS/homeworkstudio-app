/**
 * Visualization v3 — AI render domain model: settings enums, the customer-facing v1 preset
 * options, the createAiVisualizationRender factory (sibling to createCustomerVisualizationRender
 * in domain/workflow.ts — kept in this dedicated module instead since the AI input shape is
 * meaningfully larger and AI-specific types shouldn't bloat workflow.ts), and the pure
 * aspect-ratio-preserving resize helper for provider working-resolution constraints.
 *
 * Pure domain, no THREE/DOM/network — everything here is plain data in, plain data out.
 */
import type { VisualizationItem } from "./project.ts";
import type { VisualizationRenderFingerprint } from "./visualizationRender.ts";

/**
 * Only "strict-lock" is ever produced by any code path in this batch — booth materials/geometry
 * can never be touched by AI. "enhanced" is a reserved future value with zero implementation;
 * its mere existence in the type must never be mistaken for it being supported.
 */
export type VisualizationAiMode = "strict-lock" | "enhanced";

/** v1 deliberately holds to 3 presets each (report sections 14/15/16) — not twenty styles. */
export type EnvironmentPreset = "clean-hall" | "modern-hall" | "light-studio";
export type PeoplePreset = "none" | "few" | "typical";
export type LightingPreset = "neutral" | "warm" | "cool";

export const ENVIRONMENT_PRESETS: readonly EnvironmentPreset[] = ["clean-hall", "modern-hall", "light-studio"];
export const PEOPLE_PRESETS: readonly PeoplePreset[] = ["none", "few", "typical"];
export const LIGHTING_PRESETS: readonly LightingPreset[] = ["neutral", "warm", "cool"];

export const ENVIRONMENT_PRESET_LABELS: Readonly<Record<EnvironmentPreset, string>> = {
  "clean-hall": "Čistá veletržní hala",
  "modern-hall": "Moderní veletržní hala",
  "light-studio": "Světlé studio",
};
export const PEOPLE_PRESET_LABELS: Readonly<Record<PeoplePreset, string>> = {
  none: "Bez lidí",
  few: "Málo",
  typical: "Běžný provoz",
};
export const LIGHTING_PRESET_LABELS: Readonly<Record<LightingPreset, string>> = {
  neutral: "Neutrální",
  warm: "Teplé",
  cool: "Chladnější",
};

export type AiGenerationSettings = Readonly<{
  mode: VisualizationAiMode;
  environmentPreset: EnvironmentPreset;
  peoplePreset: PeoplePreset;
  lightingPreset: LightingPreset;
}>;

/** Deterministic JSON serialization (fixed key order) — used both for request payloads and for tests asserting identical settings always serialize identically. */
export function serializeAiGenerationSettings(settings: AiGenerationSettings): string {
  return JSON.stringify({
    mode: settings.mode,
    environmentPreset: settings.environmentPreset,
    peoplePreset: settings.peoplePreset,
    lightingPreset: settings.lightingPreset,
  });
}

/**
 * Report sections 26/27: aspect-ratio-preserving fit into a provider's maxInputSize — never
 * distorts (uniform scale factor applied to both axes), never upscales (only ever shrinks when
 * the source exceeds the max), and reports whether it actually had to shrink. This is NOT the
 * excluded "AI upscaler" feature — the browser-side compositor separately resizes the returned
 * environment image back up to the original beauty resolution purely to align pixel buffers for
 * compositing, a mechanical necessity, never a quality-enhancement step.
 */
export function fitWithinMaxInputSize(
  widthPx: number,
  heightPx: number,
  maxInputSize: Readonly<{ widthPx: number; heightPx: number }>,
): Readonly<{ widthPx: number; heightPx: number; downscaled: boolean }> {
  if (widthPx <= maxInputSize.widthPx && heightPx <= maxInputSize.heightPx) {
    return { widthPx, heightPx, downscaled: false };
  }
  const scale = Math.min(maxInputSize.widthPx / widthPx, maxInputSize.heightPx / heightPx);
  return {
    widthPx: Math.max(1, Math.round(widthPx * scale)),
    heightPx: Math.max(1, Math.round(heightPx * scale)),
    downscaled: true,
  };
}

export class VisualizationAiRequestError extends Error {
  readonly code = "invalid-request" as const;
  constructor(message: string) {
    super(message);
    this.name = "VisualizationAiRequestError";
  }
}

/**
 * The server route's request body. `sceneMetadata` is deliberately kept opaque here
 * (`Readonly<Record<string, unknown>>`) rather than importing `CuratedAiSceneMetadata` from
 * domain/visualizationAiPrompt.ts — that module already imports preset types from this one, and
 * keeping this file self-contained avoids a circular value/type dependency for no real benefit,
 * since the route only ever forwards this field into a text prompt, never branches on its shape.
 */
export type VisualizationAiGenerateRequestBody = Readonly<{
  viewId: string;
  sourceRenderId: string;
  beautyImageDataUrl: string;
  protectedMaskDataUrl: string;
  environmentPreset: EnvironmentPreset;
  peoplePreset: PeoplePreset;
  lightingPreset: LightingPreset;
  sceneMetadata: Readonly<Record<string, unknown>>;
  widthPx: number;
  heightPx: number;
}>;

/** Domain-layer request validator (this codebase's `asserts` convention — see domain/assets.ts's validateUploadInput). Throws VisualizationAiRequestError on the first violation found. */
export function assertValidVisualizationAiGenerateRequestBody(body: unknown): asserts body is VisualizationAiGenerateRequestBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new VisualizationAiRequestError("Požadavek musí být JSON objekt.");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.viewId !== "string" || record.viewId.length === 0) throw new VisualizationAiRequestError("Chybí viewId.");
  if (typeof record.sourceRenderId !== "string" || record.sourceRenderId.length === 0) throw new VisualizationAiRequestError("Chybí sourceRenderId.");
  if (typeof record.beautyImageDataUrl !== "string" || !record.beautyImageDataUrl.startsWith("data:image")) throw new VisualizationAiRequestError("Neplatný beautyImageDataUrl.");
  if (typeof record.protectedMaskDataUrl !== "string" || !record.protectedMaskDataUrl.startsWith("data:image")) throw new VisualizationAiRequestError("Neplatný protectedMaskDataUrl.");
  if (!ENVIRONMENT_PRESETS.includes(record.environmentPreset as EnvironmentPreset)) throw new VisualizationAiRequestError("Neplatný environmentPreset.");
  if (!PEOPLE_PRESETS.includes(record.peoplePreset as PeoplePreset)) throw new VisualizationAiRequestError("Neplatný peoplePreset.");
  if (!LIGHTING_PRESETS.includes(record.lightingPreset as LightingPreset)) throw new VisualizationAiRequestError("Neplatný lightingPreset.");
  if (typeof record.sceneMetadata !== "object" || record.sceneMetadata === null || Array.isArray(record.sceneMetadata)) throw new VisualizationAiRequestError("Chybí sceneMetadata.");
  if (typeof record.widthPx !== "number" || !Number.isFinite(record.widthPx) || record.widthPx <= 0) throw new VisualizationAiRequestError("Neplatné widthPx.");
  if (typeof record.heightPx !== "number" || !Number.isFinite(record.heightPx) || record.heightPx <= 0) throw new VisualizationAiRequestError("Neplatné heightPx.");
}

let aiRenderSequence = 0;

/**
 * The AI-render creation path — a sibling to createCustomerVisualizationRender
 * (domain/workflow.ts), never modifying it. Always stamps type: "ai", copies
 * contentFingerprint verbatim from the caller-supplied source render's fingerprint (never
 * recomputed here) so the existing staleness machinery (domain/visualizationRender.ts's
 * evaluateRenderStaleness) works unmodified once it admits "ai" alongside "customer".
 */
export function createAiVisualizationRender(
  input: Readonly<{
    name: string;
    viewId: string;
    sourceRenderId: string;
    imageDataUrl: string;
    widthPx: number;
    heightPx: number;
    format: "png" | "jpeg";
    settings: AiGenerationSettings;
    contentFingerprint: VisualizationRenderFingerprint;
    provider?: string;
    model?: string;
    resolutionDownscaled?: boolean;
    purpose?: "working" | "presentation";
  }>,
  now = new Date().toISOString(),
): VisualizationItem {
  return {
    id: `visualization-ai-${Date.now()}-${aiRenderSequence++}`,
    name: input.name,
    sourceViewId: input.viewId,
    viewId: input.viewId,
    sourceRenderId: input.sourceRenderId,
    imageDataUrl: input.imageDataUrl,
    widthPx: input.widthPx,
    heightPx: input.heightPx,
    format: input.format,
    mode: input.settings.mode,
    environmentPreset: input.settings.environmentPreset,
    peoplePreset: input.settings.peoplePreset,
    lightingPreset: input.settings.lightingPreset,
    contentFingerprint: input.contentFingerprint,
    provider: input.provider,
    model: input.model,
    resolutionDownscaled: input.resolutionDownscaled,
    type: "ai",
    purpose: input.purpose ?? "working",
    createdAt: now,
    reviewStatus: "unreviewed",
  };
}
