import assert from "node:assert/strict";
import test from "node:test";
import { DeterministicFakeAiProvider } from "../lib/ai/deterministicFakeAiProvider.ts";
import { resolveVisualizationAiProvider } from "../lib/ai/visualizationAiProvider.server.ts";
import { pngBytesToDataUrl, encodeRgbaToPng } from "../lib/ai/pngEncoder.ts";
import type { CuratedAiSceneMetadata } from "../domain/visualizationAiPrompt.ts";

const METADATA: CuratedAiSceneMetadata = {
  cameraSummary: "camera at (0.00, 1.60, 3.00) looking toward (0.00, 1.00, 0.00)",
  footprintMm: { widthMm: 2000, depthMm: 2000 },
  eventName: "Beauty 2026",
  objectCategoryCounts: { "booth-construction": 4, artwork: 2, furniture: 3, "booth-floor": 1 },
  floorType: "Šedý koberec",
  materialsSummary: ["Bílá konstrukce"],
  protectedObjectCount: 10,
};

// =========================================================================================
// Visualization v3 — provider resolution + the deterministic fake provider (report sections
// 13/14/34).
// =========================================================================================

test("PNG ENCODER: produces a real, valid, decodable PNG (magic-byte signature check, matching this codebase's manual-PDF-QA style)", () => {
  const rgba = new Uint8Array(4 * 2 * 2);
  rgba.fill(255);
  const png = encodeRgbaToPng(2, 2, rgba);
  assert.deepEqual(Array.from(png.subarray(0, 8)), [137, 80, 78, 71, 13, 10, 26, 10]);
  const dataUrl = pngBytesToDataUrl(png);
  assert.match(dataUrl, /^data:image\/png;base64,/u);
});

test("RESOLUTION: resolveVisualizationAiProvider returns undefined by default — never throws, never fabricates a key", () => {
  const provider = resolveVisualizationAiProvider({});
  assert.equal(provider, undefined);
});

test("RESOLUTION: resolveVisualizationAiProvider enables the fake provider only via the explicit non-secret dev opt-in flag", () => {
  const provider = resolveVisualizationAiProvider({ AI_VISUALIZATION_USE_FAKE_PROVIDER: "1" });
  assert.ok(provider);
  assert.equal(provider?.id, "deterministic-fake");
});

test("CAPABILITIES: the fake provider declares its capabilities honestly — no native mask/depth/normal support claimed", () => {
  const provider = new DeterministicFakeAiProvider();
  assert.equal(provider.capabilities.supportsMask, false);
  assert.equal(provider.capabilities.supportsMultipleReferenceImages, false);
  assert.equal(provider.capabilities.supportsTransparentInput, false);
  assert.ok(provider.capabilities.maxInputSize.widthPx > 0);
});

test("DETERMINISM: identical input produces byte-identical output across repeated calls", async () => {
  const provider = new DeterministicFakeAiProvider();
  const input = {
    beautyImageDataUrl: "data:image/png;base64,AA==",
    protectedMaskDataUrl: "data:image/png;base64,AA==",
    environmentPreset: "clean-hall" as const,
    peoplePreset: "few" as const,
    lightingPreset: "warm" as const,
    sceneMetadata: METADATA,
    widthPx: 40,
    heightPx: 30,
  };
  const a = await provider.generateEnvironment(input);
  const b = await provider.generateEnvironment(input);
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.deepEqual(a, b);
});

test("DETERMINISM: different settings never produce the same output", async () => {
  const provider = new DeterministicFakeAiProvider();
  const base = {
    beautyImageDataUrl: "data:image/png;base64,AA==",
    protectedMaskDataUrl: "data:image/png;base64,AA==",
    sceneMetadata: METADATA,
    widthPx: 20,
    heightPx: 20,
  };
  const a = await provider.generateEnvironment({ ...base, environmentPreset: "clean-hall", peoplePreset: "none", lightingPreset: "neutral" });
  const b = await provider.generateEnvironment({ ...base, environmentPreset: "modern-hall", peoplePreset: "none", lightingPreset: "neutral" });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual((a as { environmentImageDataUrl: string }).environmentImageDataUrl, (b as { environmentImageDataUrl: string }).environmentImageDataUrl);
});

test("VALIDATION: rejects non-positive dimensions rather than producing a broken image", async () => {
  const provider = new DeterministicFakeAiProvider();
  const result = await provider.generateEnvironment({
    beautyImageDataUrl: "x", protectedMaskDataUrl: "x", environmentPreset: "clean-hall",
    peoplePreset: "none", lightingPreset: "neutral", sceneMetadata: METADATA, widthPx: 0, heightPx: 10,
  });
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "invalid-response");
});

test("OUTPUT: reports the requested widthPx/heightPx back exactly, and a plausible model identifier", async () => {
  const provider = new DeterministicFakeAiProvider();
  const result = await provider.generateEnvironment({
    beautyImageDataUrl: "x", protectedMaskDataUrl: "x", environmentPreset: "light-studio",
    peoplePreset: "typical", lightingPreset: "cool", sceneMetadata: METADATA, widthPx: 64, heightPx: 48,
  });
  assert.equal(result.ok, true);
  const ok = result as { widthPx: number; heightPx: number; model: string };
  assert.equal(ok.widthPx, 64);
  assert.equal(ok.heightPx, 48);
  assert.equal(ok.model, "deterministic-fake-v1");
});
