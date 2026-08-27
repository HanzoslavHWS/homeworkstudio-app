import assert from "node:assert/strict";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { handleVisualizationAiGenerate } from "../app/api/visualizations/ai-generate/route.ts";
import { DeterministicFakeAiProvider } from "../lib/ai/deterministicFakeAiProvider.ts";
import { createSessionToken } from "../lib/auth/session.ts";
import type { VisualizationAiProvider } from "../lib/ai/visualizationAiProvider.server.ts";

const SECRET = "ai-route-session-secret-with-at-least-32-characters";

function authenticatedRequest(token: string, body: unknown) {
  return new NextRequest("http://localhost/api/visualizations/ai-generate", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json", Cookie: `homeworkstudio_session=${token}` },
  });
}

function validBody(overrides: Record<string, unknown> = {}) {
  return {
    viewId: "view-1",
    sourceRenderId: "render-1",
    beautyImageDataUrl: "data:image/png;base64,AA==",
    protectedMaskDataUrl: "data:image/png;base64,AA==",
    environmentPreset: "clean-hall",
    peoplePreset: "few",
    lightingPreset: "neutral",
    sceneMetadata: { cameraSummary: "x" },
    widthPx: 40,
    heightPx: 30,
    ...overrides,
  };
}

// =========================================================================================
// Visualization v3 — AI generation server route (report sections 25/34): auth-first,
// validated, provider call scoped, never a partial/broken result on failure.
// =========================================================================================

test("AUTH: rejects an unauthenticated request before ever resolving a provider", async () => {
  let providerResolved = false;
  const response = await handleVisualizationAiGenerate(
    new NextRequest("http://localhost/api/visualizations/ai-generate", { method: "POST", body: "{}", headers: { "Content-Type": "application/json" } }),
    () => { providerResolved = true; return new DeterministicFakeAiProvider(); },
  );
  assert.equal(response.status, 401);
  assert.equal(providerResolved, false);
});

test("MALFORMED JSON: returns 400 without resolving a provider", async () => {
  process.env.APP_SESSION_SECRET = SECRET;
  const token = await createSessionToken(SECRET);
  let providerResolved = false;
  const request = new NextRequest("http://localhost/api/visualizations/ai-generate", {
    method: "POST", body: "not-json", headers: { "Content-Type": "application/json", Cookie: `homeworkstudio_session=${token}` },
  });
  const response = await handleVisualizationAiGenerate(request, () => { providerResolved = true; return new DeterministicFakeAiProvider(); });
  assert.equal(response.status, 400);
  assert.equal(providerResolved, false);
});

test("VALIDATION: rejects an invalid preset without resolving a provider", async () => {
  process.env.APP_SESSION_SECRET = SECRET;
  const token = await createSessionToken(SECRET);
  let providerResolved = false;
  const response = await handleVisualizationAiGenerate(
    authenticatedRequest(token, validBody({ environmentPreset: "not-a-real-preset" })),
    () => { providerResolved = true; return new DeterministicFakeAiProvider(); },
  );
  assert.equal(response.status, 400);
  assert.equal(providerResolved, false);
});

test("VALIDATION: rejects a missing dataURL", async () => {
  process.env.APP_SESSION_SECRET = SECRET;
  const token = await createSessionToken(SECRET);
  const response = await handleVisualizationAiGenerate(authenticatedRequest(token, validBody({ beautyImageDataUrl: "" })), () => new DeterministicFakeAiProvider());
  assert.equal(response.status, 400);
});

test("PROVIDER UNAVAILABLE: returns 503 when no provider is configured, never a broken 200", async () => {
  process.env.APP_SESSION_SECRET = SECRET;
  const token = await createSessionToken(SECRET);
  const response = await handleVisualizationAiGenerate(authenticatedRequest(token, validBody()), () => undefined);
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, "provider-unavailable");
});

test("PROVIDER FAILURE: a provider-error result becomes a 502, never a partial success", async () => {
  process.env.APP_SESSION_SECRET = SECRET;
  const token = await createSessionToken(SECRET);
  const failingProvider: VisualizationAiProvider = {
    id: "failing",
    capabilities: { supportsMask: false, supportsMultipleReferenceImages: false, supportsTransparentInput: false, supportedAspectRatios: [], maxInputSize: { widthPx: 1024, heightPx: 1024 } },
    async generateEnvironment() { return { ok: false, reason: "provider-error" }; },
  };
  const response = await handleVisualizationAiGenerate(authenticatedRequest(token, validBody()), () => failingProvider);
  assert.equal(response.status, 502);
});

test("SUCCESS: authenticated + valid request against the fake provider returns 200 with the environment image", async () => {
  process.env.APP_SESSION_SECRET = SECRET;
  const token = await createSessionToken(SECRET);
  const response = await handleVisualizationAiGenerate(authenticatedRequest(token, validBody()), () => new DeterministicFakeAiProvider());
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.match(json.environmentImageDataUrl, /^data:image\/png;base64,/u);
  assert.equal(json.widthPx, 40);
  assert.equal(json.heightPx, 30);
  assert.equal(json.provider, "deterministic-fake");
  assert.equal(json.resolutionDownscaled, false);
});

test("RESIZE: a request exceeding the provider's maxInputSize is fit down before the provider call, surfaced via resolutionDownscaled", async () => {
  process.env.APP_SESSION_SECRET = SECRET;
  const token = await createSessionToken(SECRET);
  const response = await handleVisualizationAiGenerate(authenticatedRequest(token, validBody({ widthPx: 2400, heightPx: 1800 })), () => new DeterministicFakeAiProvider());
  assert.equal(response.status, 200);
  const json = await response.json();
  assert.ok(json.widthPx <= 1024 && json.heightPx <= 1024);
  assert.equal(json.resolutionDownscaled, true);
});
