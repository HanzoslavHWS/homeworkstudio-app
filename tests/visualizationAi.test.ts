import assert from "node:assert/strict";
import test from "node:test";
import {
  createAiVisualizationRender,
  ENVIRONMENT_PRESETS,
  fitWithinMaxInputSize,
  LIGHTING_PRESETS,
  PEOPLE_PRESETS,
  serializeAiGenerationSettings,
  type AiGenerationSettings,
} from "../domain/visualizationAi.ts";
import { evaluateRenderStaleness, latestAiRenderForView, latestPresentableRendersByView } from "../domain/visualizationRender.ts";
import type { VisualizationRenderFingerprint } from "../domain/visualizationRender.ts";

const SETTINGS: AiGenerationSettings = { mode: "strict-lock", environmentPreset: "clean-hall", peoplePreset: "few", lightingPreset: "neutral" };

const FINGERPRINT: VisualizationRenderFingerprint = {
  boothId: "booth-1", variantId: "variant-1", carpetFinishId: "carpet-grey", constructionFinishId: "construction-white",
  constructionVisibility: {}, sceneObjects: [], printSurfaceAssignments: [], referencedGraphicsFiles: [],
};

// =========================================================================================
// Visualization v3 — AI render domain model (report sections 19/20/34).
// =========================================================================================

test("PRESETS: v1 holds to exactly 3 options per preset dimension", () => {
  assert.equal(ENVIRONMENT_PRESETS.length, 3);
  assert.equal(PEOPLE_PRESETS.length, 3);
  assert.equal(LIGHTING_PRESETS.length, 3);
});

test("SETTINGS SERIALIZATION: identical settings always serialize to identical JSON, deterministically", () => {
  const a = serializeAiGenerationSettings(SETTINGS);
  const b = serializeAiGenerationSettings({ ...SETTINGS });
  assert.equal(a, b);
  assert.equal(a, JSON.stringify({ mode: "strict-lock", environmentPreset: "clean-hall", peoplePreset: "few", lightingPreset: "neutral" }));
});

test("SETTINGS SERIALIZATION: different settings never collide", () => {
  const a = serializeAiGenerationSettings(SETTINGS);
  const b = serializeAiGenerationSettings({ ...SETTINGS, lightingPreset: "warm" });
  assert.notEqual(a, b);
});

test("FACTORY: createAiVisualizationRender preserves sourceRenderId and viewId (sourceViewId) exactly as given", () => {
  const item = createAiVisualizationRender({
    name: "Hlavní – realistický vizuál", viewId: "view-1", sourceRenderId: "render-source-1",
    imageDataUrl: "data:image/jpeg;base64,AA==", widthPx: 1920, heightPx: 1080, format: "jpeg",
    settings: SETTINGS, contentFingerprint: FINGERPRINT,
  }, "2026-08-26T10:00:00.000Z");
  assert.equal(item.sourceRenderId, "render-source-1");
  assert.equal(item.viewId, "view-1");
  assert.equal(item.sourceViewId, "view-1");
  assert.equal(item.type, "ai");
  assert.equal(item.mode, "strict-lock");
});

test("FACTORY: never contains a secret — provider/model are plain string identifiers only, and are omitted (not fabricated) when not provided", () => {
  const withProvider = createAiVisualizationRender({
    name: "X", viewId: "v1", sourceRenderId: "r1", imageDataUrl: "data:image/png;base64,AA==",
    widthPx: 100, heightPx: 100, format: "png", settings: SETTINGS, contentFingerprint: FINGERPRINT,
    provider: "deterministic-fake", model: "fake-v1",
  });
  assert.equal(withProvider.provider, "deterministic-fake");
  assert.equal(withProvider.model, "fake-v1");
  const withoutProvider = createAiVisualizationRender({
    name: "X", viewId: "v1", sourceRenderId: "r1", imageDataUrl: "data:image/png;base64,AA==",
    widthPx: 100, heightPx: 100, format: "png", settings: SETTINGS, contentFingerprint: FINGERPRINT,
  });
  assert.equal(withoutProvider.provider, undefined);
  assert.equal(withoutProvider.model, undefined);
});

test("FINGERPRINT INHERITANCE: an AI render's contentFingerprint is exactly the source render's fingerprint, copied verbatim (never recomputed)", () => {
  const item = createAiVisualizationRender({
    name: "X", viewId: "v1", sourceRenderId: "r1", imageDataUrl: "data:image/png;base64,AA==",
    widthPx: 100, heightPx: 100, format: "png", settings: SETTINGS, contentFingerprint: FINGERPRINT,
  });
  assert.deepEqual(item.contentFingerprint, FINGERPRINT);
  assert.equal(evaluateRenderStaleness(item, FINGERPRINT), "current");
  assert.equal(evaluateRenderStaleness(item, { ...FINGERPRINT, boothId: "booth-2" }), "possibly-outdated");
});

test("STALENESS: an AI render with no contentFingerprint (legacy/edge case) is unknown, never falsely flagged stale", () => {
  assert.equal(evaluateRenderStaleness({ type: "ai", contentFingerprint: undefined }, FINGERPRINT), "unknown");
});

test("SELECTORS: latestAiRenderForView only ever returns type:'ai' items, never technical/customer", () => {
  const renders = [
    { id: "c1", name: "C", sourceViewId: "v1", viewId: "v1", imageDataUrl: "x", type: "customer" as const, purpose: "working" as const, createdAt: "2026-08-26T09:00:00.000Z", reviewStatus: "unreviewed" as const },
    { id: "a1", name: "A", sourceViewId: "v1", viewId: "v1", imageDataUrl: "x", type: "ai" as const, purpose: "working" as const, createdAt: "2026-08-26T10:00:00.000Z", reviewStatus: "unreviewed" as const },
  ];
  assert.equal(latestAiRenderForView(renders, "v1")?.id, "a1");
});

test("SELECTORS: latestPresentableRendersByView admits both customer and ai, picking whichever is most recent per view", () => {
  const renders = [
    { id: "c1", name: "C", sourceViewId: "v1", viewId: "v1", imageDataUrl: "x", type: "customer" as const, purpose: "working" as const, createdAt: "2026-08-26T09:00:00.000Z", reviewStatus: "unreviewed" as const },
    { id: "a1", name: "A", sourceViewId: "v1", viewId: "v1", imageDataUrl: "x", type: "ai" as const, purpose: "working" as const, createdAt: "2026-08-26T11:00:00.000Z", reviewStatus: "unreviewed" as const },
  ];
  const map = latestPresentableRendersByView(renders);
  assert.equal(map.get("v1")?.id, "a1", "the AI render is more recent, so it wins");
});

test("RESOLUTION FIT: within maxInputSize is a no-op, reports downscaled:false", () => {
  const result = fitWithinMaxInputSize(1920, 1080, { widthPx: 2048, heightPx: 2048 });
  assert.deepEqual(result, { widthPx: 1920, heightPx: 1080, downscaled: false });
});

test("RESOLUTION FIT: exceeding maxInputSize scales down preserving aspect ratio exactly, reports downscaled:true", () => {
  const result = fitWithinMaxInputSize(2400, 1800, { widthPx: 1024, heightPx: 1024 });
  assert.equal(result.downscaled, true);
  assert.ok(result.widthPx <= 1024 && result.heightPx <= 1024);
  // Aspect ratio preserved to within rounding (2400/1800 = 4/3):
  assert.ok(Math.abs(result.widthPx / result.heightPx - 2400 / 1800) < 0.01);
});

test("RESOLUTION FIT: never upscales — a source smaller than maxInputSize is returned unchanged", () => {
  const result = fitWithinMaxInputSize(800, 600, { widthPx: 2048, heightPx: 2048 });
  assert.deepEqual(result, { widthPx: 800, heightPx: 600, downscaled: false });
});
