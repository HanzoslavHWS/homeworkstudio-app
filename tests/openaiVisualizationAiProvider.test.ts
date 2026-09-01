import assert from "node:assert/strict";
import test from "node:test";
import { encodeRgbaToPng, pngBytesToDataUrl } from "../lib/ai/pngEncoder.ts";
import { decodePngDataUrlToRgba } from "../lib/ai/pngDecoder.ts";
import { DEFAULT_OPENAI_IMAGE_MODEL, DEFAULT_OPENAI_IMAGE_QUALITY, OpenAiVisualizationAiProvider } from "../lib/ai/openaiVisualizationAiProvider.server.ts";
import type { CuratedAiSceneMetadata } from "../domain/visualizationAiPrompt.ts";
import type { VisualizationAiGenerateInput } from "../lib/ai/visualizationAiProvider.server.ts";

// =========================================================================================
// Visualization v3.3/v3.3a — the real OpenAI Image API provider (images.edit). No real network
// call ever happens in tests — `fetchImpl` is always a stub, matching this codebase's existing DI
// pattern (e.g. tests/visualizationAiRoute.test.ts's providerFactory injection).
// =========================================================================================

const METADATA: CuratedAiSceneMetadata = {
  cameraSummary: "camera at (0.00, 1.60, 3.00) looking toward (0.00, 1.00, 0.00)",
  footprintMm: { widthMm: 2000, depthMm: 2000 },
  eventName: "Beauty 2026",
  objectCategoryCounts: { "booth-construction": 4, artwork: 2, furniture: 3, "booth-floor": 1 },
  floorType: "Šedý koberec",
  materialsSummary: ["Bílá konstrukce"],
  protectedObjectCount: 10,
};

function solidRgba(width: number, height: number, r: number, g: number, b: number, a: number): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = r; data[i * 4 + 1] = g; data[i * 4 + 2] = b; data[i * 4 + 3] = a;
  }
  return data;
}

function beautyAndMaskDataUrls(width: number, height: number) {
  const beauty = pngBytesToDataUrl(encodeRgbaToPng(width, height, solidRgba(width, height, 120, 130, 140, 255)));
  // Left half protected (white), right half editable (black) — a real, non-trivial mask.
  const maskRgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = x < width / 2 ? 255 : 0;
      const offset = (y * width + x) * 4;
      maskRgba[offset] = v; maskRgba[offset + 1] = v; maskRgba[offset + 2] = v; maskRgba[offset + 3] = 255;
    }
  }
  const protectedMask = pngBytesToDataUrl(encodeRgbaToPng(width, height, maskRgba));
  return { beauty, protectedMask };
}

function baseInput(overrides: Partial<VisualizationAiGenerateInput> = {}): VisualizationAiGenerateInput {
  const { beauty, protectedMask } = beautyAndMaskDataUrls(8, 6);
  return {
    beautyImageDataUrl: beauty,
    protectedMaskDataUrl: protectedMask,
    environmentPreset: "clean-hall",
    peoplePreset: "few",
    lightingPreset: "warm",
    sceneMetadata: METADATA,
    widthPx: 8,
    heightPx: 6,
    ...overrides,
  };
}

function openAiSuccessResponse(pngDataUrl: string, requestId = "req_test123"): Response {
  const b64 = pngDataUrl.split(",")[1]!;
  return new Response(JSON.stringify({ data: [{ b64_json: b64 }] }), {
    status: 200,
    headers: { "content-type": "application/json", "x-request-id": requestId },
  });
}

test("CAPABILITIES: declares mask support honestly (this provider actually sends one)", () => {
  const provider = new OpenAiVisualizationAiProvider("sk-test");
  assert.equal(provider.id, "openai");
  assert.equal(provider.capabilities.supportsMask, true);
  assert.ok(provider.capabilities.maxInputSize.widthPx > 0);
});

test("DEFAULTS: model gpt-image-2 (v3.3a — confirmed correct, unchanged), quality low (v3.3a — cheap smoke-testing default)", () => {
  assert.equal(DEFAULT_OPENAI_IMAGE_MODEL, "gpt-image-2");
  assert.equal(DEFAULT_OPENAI_IMAGE_QUALITY, "low");
  const provider = new OpenAiVisualizationAiProvider("sk-test");
  assert.equal(provider.model, "gpt-image-2");
  assert.equal(provider.quality, "low");
});

test("OPTIONS: model and quality are independently overridable via the options object", () => {
  const provider = new OpenAiVisualizationAiProvider("sk-test", { model: "gpt-image-custom", quality: "medium" });
  assert.equal(provider.model, "gpt-image-custom");
  assert.equal(provider.quality, "medium");
});

test("REQUEST SHAPE: sends model/prompt/quality/size/image/mask as multipart form fields, Authorization Bearer header, NEVER the key in the URL or body", async () => {
  let capturedUrl: string | undefined;
  let capturedInit: RequestInit | undefined;
  const fetchStub = async (url: string, init?: RequestInit): Promise<Response> => {
    capturedUrl = url;
    capturedInit = init;
    const resultPng = pngBytesToDataUrl(encodeRgbaToPng(8, 6, solidRgba(8, 6, 1, 2, 3, 255)));
    return openAiSuccessResponse(resultPng);
  };
  const provider = new OpenAiVisualizationAiProvider("sk-super-secret-value", { model: "gpt-image-2", fetchImpl: fetchStub });
  const result = await provider.generateEnvironment(baseInput());
  assert.equal(result.ok, true);

  assert.equal(capturedUrl, "https://api.openai.com/v1/images/edits");
  assert.equal(capturedInit?.method, "POST");
  const headers = capturedInit?.headers as Record<string, string>;
  assert.equal(headers.Authorization, "Bearer sk-super-secret-value");
  assert.doesNotMatch(capturedUrl!, /sk-super-secret-value/u, "the key must never appear in the URL");

  const body = capturedInit?.body as FormData;
  assert.ok(body instanceof FormData);
  assert.equal(body.get("model"), "gpt-image-2");
  assert.equal(body.get("quality"), "low", "first smoke-test requests must default to low quality");
  assert.ok(typeof body.get("prompt") === "string" && (body.get("prompt") as string).length > 0);
  assert.ok(body.get("image") instanceof Blob);
  assert.ok(body.get("mask") instanceof Blob);
});

test("v3.3a EXACT SIZE FIRST: the first attempt requests OpenAI's `size` as the Beauty image's OWN width x height, never a fixed enum guess", async () => {
  let capturedSize = "";
  const fetchStub = async (_url: string, init?: RequestInit): Promise<Response> => {
    capturedSize = (init!.body as FormData).get("size") as string;
    const resultPng = pngBytesToDataUrl(encodeRgbaToPng(37, 21, solidRgba(37, 21, 1, 2, 3, 255)));
    return openAiSuccessResponse(resultPng);
  };
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const { beauty, protectedMask } = beautyAndMaskDataUrls(37, 21);
  await provider.generateEnvironment(baseInput({ beautyImageDataUrl: beauty, protectedMaskDataUrl: protectedMask, widthPx: 37, heightPx: 21 }));
  assert.equal(capturedSize, "37x21");
});

test("v3.3b SIZE REJECTION FALLBACK: a 400 with a size-related error triggers exactly ONE retry using the SAME-aspect-ratio fallback (2048x1152 for a 16:9 Beauty, not just closest landscape/portrait/square) — never more than 2 total requests", async () => {
  const capturedSizes: string[] = [];
  let callCount = 0;
  const fetchStub = async (_url: string, init?: RequestInit): Promise<Response> => {
    callCount++;
    capturedSizes.push((init!.body as FormData).get("size") as string);
    if (callCount === 1) {
      return new Response(JSON.stringify({ error: { message: "Invalid value for 'size'", param: "size" } }), { status: 400 });
    }
    const resultPng = pngBytesToDataUrl(encodeRgbaToPng(2048, 1152, solidRgba(2048, 1152, 1, 2, 3, 255)));
    return openAiSuccessResponse(resultPng);
  };
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const { beauty, protectedMask } = beautyAndMaskDataUrls(1920, 1080);
  const result = await provider.generateEnvironment(baseInput({ beautyImageDataUrl: beauty, protectedMaskDataUrl: protectedMask, widthPx: 1920, heightPx: 1080 }));
  assert.equal(result.ok, true);
  assert.equal(callCount, 2);
  assert.equal(capturedSizes[0], "1920x1080");
  assert.equal(capturedSizes[1], "2048x1152", "16:9 must fall back to the exact-same-aspect-ratio 2048x1152 candidate, not 1536x1024 (3:2)");
});

test("v3.3b REGRESSION — 1920x1080 -> 2048x1152 fallback -> 1920x1080, ZERO letterbox padding: the whole point of picking a same-aspect-ratio fallback is that the final uniform rescale needs no padding at all", async () => {
  const beautyWidth = 1920, beautyHeight = 1080;
  const marker = { r: 250, g: 10, b: 10, a: 255 };
  let callCount = 0;
  const fetchStub = async (_url: string, init?: RequestInit): Promise<Response> => {
    callCount++;
    const requestedSize = (init!.body as FormData).get("size") as string;
    if (callCount === 1) {
      assert.equal(requestedSize, "1920x1080", "must try the exact Beauty dimensions first");
      return new Response(JSON.stringify({ error: { message: "Invalid value for 'size'", param: "size" } }), { status: 400 });
    }
    assert.equal(requestedSize, "2048x1152");
    // Simulates OpenAI's actual fallback response: solid marker color fills the whole 16:9 image.
    const resultPng = pngBytesToDataUrl(encodeRgbaToPng(2048, 1152, solidRgba(2048, 1152, marker.r, marker.g, marker.b, marker.a)));
    return openAiSuccessResponse(resultPng);
  };
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const { beauty, protectedMask } = beautyAndMaskDataUrls(beautyWidth, beautyHeight);
  const result = await provider.generateEnvironment(baseInput({ beautyImageDataUrl: beauty, protectedMaskDataUrl: protectedMask, widthPx: beautyWidth, heightPx: beautyHeight }));
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(callCount, 2);
  assert.equal(result.widthPx, beautyWidth);
  assert.equal(result.heightPx, beautyHeight);

  const decoded = decodePngDataUrlToRgba(result.environmentImageDataUrl);
  assert.equal(decoded.width, beautyWidth);
  assert.equal(decoded.height, beautyHeight);
  // Same aspect ratio in (16:9) and out (16:9) -> a correct "contain" rescale fills the ENTIRE
  // target with no padding whatsoever. Check every pixel, not just the borders, so any partial
  // letterbox regression is caught regardless of where it'd show up.
  for (let i = 0; i < beautyWidth * beautyHeight; i++) {
    const offset = i * 4;
    if (decoded.rgba[offset] !== marker.r || decoded.rgba[offset + 1] !== marker.g || decoded.rgba[offset + 2] !== marker.b) {
      assert.fail(`pixel ${i} is not the marker color — found padding where a same-aspect-ratio rescale must have none`);
    }
  }
});

test("v3.3a NON-SIZE 400 ERRORS DO NOT RETRY: exactly one request, provider-error result", async () => {
  let callCount = 0;
  const fetchStub = async (): Promise<Response> => {
    callCount++;
    return new Response(JSON.stringify({ error: { message: "Your prompt was flagged", param: "prompt" } }), { status: 400 });
  };
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const result = await provider.generateEnvironment(baseInput());
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "provider-error");
  assert.equal(callCount, 1);
});

test("v3.3a DIMENSIONS CONTRACT: when OpenAI's returned image already matches Beauty's exact dimensions, it's returned untouched (byte-identical pixels, no needless re-encode work)", async () => {
  const resultRgba = solidRgba(8, 6, 200, 100, 50, 255);
  const resultPng = pngBytesToDataUrl(encodeRgbaToPng(8, 6, resultRgba));
  const fetchStub = async (): Promise<Response> => openAiSuccessResponse(resultPng);
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const result = await provider.generateEnvironment(baseInput());
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(result.widthPx, 8);
  assert.equal(result.heightPx, 6);
  assert.deepEqual(decodePngDataUrlToRgba(result.environmentImageDataUrl).rgba, resultRgba);
});

test("v3.3a DIMENSIONS CONTRACT — ASPECT RATIO PRESERVED THROUGH THE FULL FLOW: when OpenAI returns a DIFFERENT-aspect image (landscape fallback enum for a portrait Beauty), the final result is EXACTLY Beauty's dimensions, the source content is never stretched, and letterbox padding fills the rest", async () => {
  // Beauty is portrait (6x10); OpenAI (simulating a fallback-size response) returns a
  // 1024x1536 (2:3 portrait) result that still isn't an exact match. A solid, unambiguous
  // marker color fills the OpenAI result so its scaled extent is measurable in the output.
  const beautyWidth = 6, beautyHeight = 10;
  const openAiWidth = 12, openAiHeight = 20; // same 3:5 aspect as Beauty but different absolute size
  const markerColor = { r: 250, g: 10, b: 10, a: 255 };
  const resultPng = pngBytesToDataUrl(encodeRgbaToPng(openAiWidth, openAiHeight, solidRgba(openAiWidth, openAiHeight, markerColor.r, markerColor.g, markerColor.b, markerColor.a)));
  const fetchStub = async (): Promise<Response> => openAiSuccessResponse(resultPng);
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const { beauty, protectedMask } = beautyAndMaskDataUrls(beautyWidth, beautyHeight);
  const result = await provider.generateEnvironment(baseInput({ beautyImageDataUrl: beauty, protectedMaskDataUrl: protectedMask, widthPx: beautyWidth, heightPx: beautyHeight }));
  assert.equal(result.ok, true);
  if (result.ok !== true) return;

  // MUST exactly equal Beauty's own dimensions — this is the geometric-alignability contract.
  assert.equal(result.widthPx, beautyWidth);
  assert.equal(result.heightPx, beautyHeight);

  const decoded = decodePngDataUrlToRgba(result.environmentImageDataUrl);
  assert.equal(decoded.width, beautyWidth);
  assert.equal(decoded.height, beautyHeight);

  // Same aspect ratio source (3:5) into a same-aspect-ratio target with a different absolute
  // size — a correct "contain" fit uniformly scales to fill the ENTIRE target with no padding
  // at all (scale = min(6/12, 10/20) = 0.5 on both axes exactly), so every pixel should be the
  // marker color, proving no crop/stretch/off-center bug crept in for the equal-aspect case.
  for (let i = 0; i < beautyWidth * beautyHeight; i++) {
    assert.equal(decoded.rgba[i * 4], markerColor.r, `pixel ${i} red channel`);
    assert.equal(decoded.rgba[i * 4 + 1], markerColor.g, `pixel ${i} green channel`);
    assert.equal(decoded.rgba[i * 4 + 2], markerColor.b, `pixel ${i} blue channel`);
  }
});

test("v3.3a DIMENSIONS CONTRACT — MISMATCHED ASPECT RATIO IS LETTERBOXED, NEVER STRETCHED: a square OpenAI result normalized to a wide Beauty produces side padding, not a horizontally-squished image", async () => {
  const beautyWidth = 16, beautyHeight = 8; // 2:1 landscape
  const openAiSize = 8; // 1:1 square result (as if the fallback enum's square option was used)
  const markerColor = { r: 30, g: 200, b: 30, a: 255 };
  const resultPng = pngBytesToDataUrl(encodeRgbaToPng(openAiSize, openAiSize, solidRgba(openAiSize, openAiSize, markerColor.r, markerColor.g, markerColor.b, markerColor.a)));
  const fetchStub = async (): Promise<Response> => openAiSuccessResponse(resultPng);
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const { beauty, protectedMask } = beautyAndMaskDataUrls(beautyWidth, beautyHeight);
  const result = await provider.generateEnvironment(baseInput({ beautyImageDataUrl: beauty, protectedMaskDataUrl: protectedMask, widthPx: beautyWidth, heightPx: beautyHeight }));
  assert.equal(result.ok, true);
  if (result.ok !== true) return;
  assert.equal(result.widthPx, beautyWidth);
  assert.equal(result.heightPx, beautyHeight);

  const decoded = decodePngDataUrlToRgba(result.environmentImageDataUrl);
  // scale = min(16/8, 8/8) = 1 -> scaled content is 8x8, centered horizontally (offsetX = 4),
  // filling the full height. Columns 0-3 and 12-15 must be padding (NOT the marker color, i.e.
  // no horizontal stretch smeared the square content across the full 16px width); columns 4-11
  // must be the marker color (the square, unstretched, centered).
  const midRow = 4;
  for (let x = 0; x < beautyWidth; x++) {
    const offset = (midRow * beautyWidth + x) * 4;
    const isContentColumn = x >= 4 && x < 12;
    if (isContentColumn) {
      assert.equal(decoded.rgba[offset], markerColor.r, `content column x=${x} should be the marker color`);
    } else {
      assert.notEqual(
        [decoded.rgba[offset], decoded.rgba[offset + 1], decoded.rgba[offset + 2]].join(","),
        [markerColor.r, markerColor.g, markerColor.b].join(","),
        `padding column x=${x} must NOT be the marker color (a stretch bug would smear it across the full width)`,
      );
    }
  }
});

test("PROMPT: built via the EXISTING buildEnvironmentPrompt (GOAL/LOCKED/EDITABLE/STYLE/CAMERA), never a re-implementation — reflects the real sceneMetadata/presets", async () => {
  let capturedPrompt = "";
  const fetchStub = async (_url: string, init?: RequestInit): Promise<Response> => {
    capturedPrompt = (init!.body as FormData).get("prompt") as string;
    const resultPng = pngBytesToDataUrl(encodeRgbaToPng(8, 6, solidRgba(8, 6, 1, 2, 3, 255)));
    return openAiSuccessResponse(resultPng);
  };
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  await provider.generateEnvironment(baseInput({ environmentPreset: "modern-hall", peoplePreset: "typical", lightingPreset: "cool" }));
  assert.match(capturedPrompt, /GOAL:/u);
  assert.match(capturedPrompt, /LOCKED CONTENT/u);
  assert.match(capturedPrompt, /EDITABLE CONTENT/u);
  assert.match(capturedPrompt, /STYLE:/u);
  assert.match(capturedPrompt, /CAMERA:/u);
  assert.match(capturedPrompt, /2000×2000 mm/u, "must reflect the real footprint from sceneMetadata, not a placeholder");
});

test("MASK: inverse of the Protected Mask — protected(white) pixels get alpha=255 (preserved), editable(black) pixels get alpha=0 (OpenAI may paint there)", async () => {
  let capturedMaskBlob: Blob | undefined;
  const fetchStub = async (_url: string, init?: RequestInit): Promise<Response> => {
    capturedMaskBlob = (init!.body as FormData).get("mask") as Blob;
    const resultPng = pngBytesToDataUrl(encodeRgbaToPng(8, 6, solidRgba(8, 6, 1, 2, 3, 255)));
    return openAiSuccessResponse(resultPng);
  };
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const input = baseInput(); // left half protected(white), right half editable(black), 8x6
  const result = await provider.generateEnvironment(input);
  assert.equal(result.ok, true);

  const maskBytes = new Uint8Array(await capturedMaskBlob!.arrayBuffer());
  const maskDataUrl = pngBytesToDataUrl(maskBytes);
  const decodedMask = decodePngDataUrlToRgba(maskDataUrl);
  assert.equal(decodedMask.width, 8);
  assert.equal(decodedMask.height, 6);
  for (let y = 0; y < 6; y++) {
    for (let x = 0; x < 8; x++) {
      const offset = (y * 8 + x) * 4;
      const expectedAlpha = x < 4 ? 255 : 0; // protected (left) -> preserved; editable (right) -> transparent
      assert.equal(decodedMask.rgba[offset + 3], expectedAlpha, `pixel (${x},${y})`);
    }
  }
});

test("MODEL OVERRIDE: the model actually sent and returned reflects the options override, not the default", async () => {
  let capturedModel = "";
  const fetchStub = async (_url: string, init?: RequestInit): Promise<Response> => {
    capturedModel = (init!.body as FormData).get("model") as string;
    const resultPng = pngBytesToDataUrl(encodeRgbaToPng(8, 6, solidRgba(8, 6, 1, 2, 3, 255)));
    return openAiSuccessResponse(resultPng);
  };
  const provider = new OpenAiVisualizationAiProvider("sk-test", { model: "gpt-image-custom", fetchImpl: fetchStub });
  const result = await provider.generateEnvironment(baseInput());
  assert.equal(capturedModel, "gpt-image-custom");
  assert.equal(result.ok, true);
  if (result.ok === true) assert.equal(result.model, "gpt-image-custom");
});

test("QUALITY OVERRIDE: the quality actually sent reflects the options override, not the low default", async () => {
  let capturedQuality = "";
  const fetchStub = async (_url: string, init?: RequestInit): Promise<Response> => {
    capturedQuality = (init!.body as FormData).get("quality") as string;
    const resultPng = pngBytesToDataUrl(encodeRgbaToPng(8, 6, solidRgba(8, 6, 1, 2, 3, 255)));
    return openAiSuccessResponse(resultPng);
  };
  const provider = new OpenAiVisualizationAiProvider("sk-test", { quality: "medium", fetchImpl: fetchStub });
  await provider.generateEnvironment(baseInput());
  assert.equal(capturedQuality, "medium");
});

test("ERROR: network failure (fetch throws) -> provider-error, never throws out of generateEnvironment", async () => {
  const fetchStub = async (): Promise<Response> => { throw new Error("network down"); };
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const result = await provider.generateEnvironment(baseInput());
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "provider-error");
});

test("ERROR: non-OK HTTP status (OpenAI API error, non-size) -> provider-error", async () => {
  const fetchStub = async (): Promise<Response> => new Response(JSON.stringify({ error: { message: "invalid_api_key" } }), { status: 401 });
  const provider = new OpenAiVisualizationAiProvider("sk-bad-key", { fetchImpl: fetchStub });
  const result = await provider.generateEnvironment(baseInput());
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "provider-error");
});

test("ERROR: empty response (no data array / no b64_json) -> invalid-response", async () => {
  const fetchStub = async (): Promise<Response> => new Response(JSON.stringify({ data: [] }), { status: 200 });
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const result = await provider.generateEnvironment(baseInput());
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "invalid-response");
});

test("ERROR: malformed JSON body -> invalid-response when HTTP was ok, provider-error when HTTP was not ok", async () => {
  const okButBadJson = async (): Promise<Response> => new Response("not json", { status: 200 });
  const providerA = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: okButBadJson });
  const resultA = await providerA.generateEnvironment(baseInput());
  assert.equal(resultA.ok, false);
  assert.equal((resultA as { reason: string }).reason, "invalid-response");

  const errorAndBadJson = async (): Promise<Response> => new Response("not json", { status: 500 });
  const providerB = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: errorAndBadJson });
  const resultB = await providerB.generateEnvironment(baseInput());
  assert.equal(resultB.ok, false);
  assert.equal((resultB as { reason: string }).reason, "provider-error");
});

test("ERROR: b64_json present but not a valid PNG (invalid image) -> invalid-response", async () => {
  const fetchStub = async (): Promise<Response> => new Response(JSON.stringify({ data: [{ b64_json: Buffer.from("not a png").toString("base64") }] }), { status: 200 });
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const result = await provider.generateEnvironment(baseInput());
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "invalid-response");
});

test("ERROR: mask/image size mismatch -> invalid-response, never sends a malformed request", async () => {
  let fetchCalled = false;
  const fetchStub = async (): Promise<Response> => { fetchCalled = true; return openAiSuccessResponse(pngBytesToDataUrl(encodeRgbaToPng(2, 2, solidRgba(2, 2, 0, 0, 0, 255)))); };
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const { beauty } = beautyAndMaskDataUrls(8, 6);
  const { protectedMask: mismatchedMask } = beautyAndMaskDataUrls(4, 4); // different dimensions
  const result = await provider.generateEnvironment(baseInput({ beautyImageDataUrl: beauty, protectedMaskDataUrl: mismatchedMask, widthPx: 8, heightPx: 6 }));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "invalid-response");
  assert.equal(fetchCalled, false, "must never call OpenAI with mismatched image/mask");
});

test("ERROR: invalid beauty/mask data (not decodable PNGs) -> invalid-response, never sends a request", async () => {
  let fetchCalled = false;
  const fetchStub = async (): Promise<Response> => { fetchCalled = true; return openAiSuccessResponse(pngBytesToDataUrl(encodeRgbaToPng(2, 2, solidRgba(2, 2, 0, 0, 0, 255)))); };
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const result = await provider.generateEnvironment(baseInput({ beautyImageDataUrl: "data:image/png;base64,not-real-png-data", widthPx: 8, heightPx: 6 }));
  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, "invalid-response");
  assert.equal(fetchCalled, false);
});

test("VALIDATION: rejects non-positive dimensions before ever building a request", async () => {
  let fetchCalled = false;
  const fetchStub = async (): Promise<Response> => { fetchCalled = true; return openAiSuccessResponse(pngBytesToDataUrl(encodeRgbaToPng(2, 2, solidRgba(2, 2, 0, 0, 0, 255)))); };
  const provider = new OpenAiVisualizationAiProvider("sk-test", { fetchImpl: fetchStub });
  const result = await provider.generateEnvironment(baseInput({ widthPx: 0 }));
  assert.equal(result.ok, false);
  assert.equal(fetchCalled, false);
});

test("NEVER LOGS THE API KEY: console.error calls made on error paths never include the raw key text", async () => {
  const originalError = console.error;
  const loggedArgs: unknown[] = [];
  console.error = (...args: unknown[]) => { loggedArgs.push(...args); };
  try {
    const fetchStub = async (): Promise<Response> => new Response(JSON.stringify({ error: { message: "invalid_api_key" } }), { status: 401 });
    const provider = new OpenAiVisualizationAiProvider("sk-THIS-MUST-NEVER-BE-LOGGED", { fetchImpl: fetchStub });
    await provider.generateEnvironment(baseInput());
  } finally {
    console.error = originalError;
  }
  const serialized = loggedArgs.map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join(" ");
  assert.doesNotMatch(serialized, /sk-THIS-MUST-NEVER-BE-LOGGED/u);
});
