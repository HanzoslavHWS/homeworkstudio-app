/**
 * Visualization v3.3/v3.3a/v3.3b — the real OpenAI Image API provider (images.edit). Implements the SAME
 * VisualizationAiProvider interface as lib/ai/deterministicFakeAiProvider.ts — no second AI
 * system, no parallel request/response shape. `.server.ts` because it carries a real API key.
 *
 * PROTECTION MODEL (report "DŮLEŽITÉ"): the mask sent to OpenAI below is a best-effort HINT only,
 * never this app's safety guarantee. Whatever OpenAI returns is treated as a completely untrusted
 * "environment" image — the actual protection is domain/visualizationCompositing.ts's strict-lock
 * composite, which ALWAYS runs client-side after this provider returns (see
 * components/workflow/AiVisualizationPanel.tsx) and pastes the authoritative Beauty pixels back
 * over the booth/furniture/artwork/floor regardless of what OpenAI did or didn't respect. This
 * provider's only job is to produce a plausible environment image and hand it back untouched.
 *
 * v3.3a DIMENSIONS CONTRACT (report section 1): the returned environmentImageDataUrl's
 * widthPx/heightPx ALWAYS exactly equal the real, decoded Beauty PNG's own dimensions — never an
 * OpenAI `size` enum value, never a stretched/cropped approximation. This is what makes the
 * client's later strict-lock composite geometrically pixel-alignable without any silent
 * non-uniform stretch (compositeStrictLockInBrowser's own resize-on-load would otherwise distort
 * a different-aspect-ratio image). See requestEnvironmentImage/normalizeToBeautyDimensions below.
 */
import { createHash } from "node:crypto";
import { decodePngToRgba, dataUrlToPngBytes, readPngDimensions, PngDecodeError } from "./pngDecoder.ts";
import { encodeRgbaToPng, pngBytesToDataUrl } from "./pngEncoder.ts";
import { fitImageWithLetterbox } from "./imageFit.ts";
import { buildEnvironmentPrompt } from "../../domain/visualizationAiPrompt.ts";
import type {
  VisualizationAiCapabilities,
  VisualizationAiGenerateInput,
  VisualizationAiGenerateResult,
  VisualizationAiProvider,
} from "./visualizationAiProvider.server.ts";

/**
 * v3.3d — dev-only diagnostics for the "ghosting only on the FIRST request" audit (report
 * v3.3d). Logs exactly the fields the report asked for that only this provider knows: the
 * ACTUAL prompt hash (post buildEnvironmentPrompt+flattenPrompt — the authoritative text sent to
 * OpenAI, more precise than any client-side reconstruction), the OpenAI `size` actually
 * requested (both attempts, if the exact-size one was rejected), and provider/model. Never logs
 * the API key, the prompt text itself, or any image bytes. Gated on NODE_ENV.
 */
function logProviderDiagnostics(event: string, details: Record<string, unknown>): void {
  if (process.env.NODE_ENV === "production") return;
  // eslint-disable-next-line no-console
  console.info(`[ai-generation-diagnostics] openai provider: ${event}`, { timestamp: new Date().toISOString(), ...details });
}

export const DEFAULT_OPENAI_IMAGE_MODEL = "gpt-image-2";
/** Report v3.3a section 2 — cheap smoke-testing quality while verifying transport/mask/composite; switch to "medium" only once that's confirmed working (OPENAI_IMAGE_QUALITY env var). */
export const DEFAULT_OPENAI_IMAGE_QUALITY = "low";
const OPENAI_IMAGES_EDIT_URL = "https://api.openai.com/v1/images/edits";
/** Protected Mask's own contract (domain/visualizationCompositing.ts): R=G=B duplicated, 255=protected/covered, 0=editable/uncovered. Same >=128 threshold used everywhere else this mask is read. */
const PROTECTED_MASK_THRESHOLD = 128;

/**
 * v3.3b — the fallback candidate sizes, used only when the exact-Beauty-dimensions request
 * (tried first, see generateEnvironment) is rejected. Picks whichever candidate's aspect ratio is
 * CLOSEST to the target's — "supported fallback with same aspect ratio > closest aspect ratio >
 * letterbox only as last resort" (report v3.3b section 1). A candidate with an EXACTLY matching
 * aspect ratio (e.g. 2048x1152 for a 16:9 Beauty) makes the later normalizeToBeautyDimensions step
 * a pure uniform rescale with ZERO letterbox padding — letterboxing only ever kicks in when no
 * candidate's aspect ratio is an exact match.
 */
const OPENAI_FALLBACK_SIZES: readonly Readonly<{ label: string; width: number; height: number }>[] = [
  { label: "1024x1024", width: 1024, height: 1024 }, // 1:1
  { label: "1536x1024", width: 1536, height: 1024 }, // 3:2
  { label: "1024x1536", width: 1024, height: 1536 }, // 2:3
  { label: "2048x1152", width: 2048, height: 1152 }, // 16:9
  { label: "1152x2048", width: 1152, height: 2048 }, // 9:16
];

function pickFallbackOpenAiSize(widthPx: number, heightPx: number): string {
  const targetAspect = widthPx / heightPx;
  let best = OPENAI_FALLBACK_SIZES[0]!;
  let bestDiff = Infinity;
  for (const candidate of OPENAI_FALLBACK_SIZES) {
    const diff = Math.abs(candidate.width / candidate.height - targetAspect);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = candidate;
    }
  }
  return best.label;
}

/**
 * Inverts the Protected Mask into OpenAI's edit-mask convention: "fully transparent areas
 * indicate where the image should be edited," opaque areas are preserved. Protected (white, >=128)
 * -> alpha 255 (preserved); editable (black) -> alpha 0 (OpenAI may paint there). RGB channels are
 * irrelevant to OpenAI's mask semantics (only alpha is read), so they're left at 0.
 */
function buildOpenAiEditMaskPng(protectedMask: Readonly<{ width: number; height: number; rgba: Uint8Array }>): Uint8Array {
  const { width, height, rgba } = protectedMask;
  const out = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const offset = i * 4;
    const protectedValue = rgba[offset]!;
    out[offset + 3] = protectedValue >= PROTECTED_MASK_THRESHOLD ? 255 : 0;
  }
  return encodeRgbaToPng(width, height, out);
}

function flattenPrompt(structured: ReturnType<typeof buildEnvironmentPrompt>): string {
  return [
    `GOAL: ${structured.goal}`,
    `LOCKED CONTENT (do not modify): ${structured.lockedContent}`,
    `EDITABLE CONTENT: ${structured.editableContent}`,
    `STYLE: ${structured.style}`,
    `CAMERA: ${structured.camera}`,
  ].join("\n");
}

type OpenAiImagesEditResponse = Readonly<{
  data?: readonly Readonly<{ b64_json?: string }>[];
  error?: Readonly<{ message?: string; param?: string | null }>;
}>;

function isSizeRejection(status: number, json: OpenAiImagesEditResponse | null): boolean {
  if (status !== 400 || !json?.error) return false;
  if (json.error.param === "size") return true;
  return (json.error.message ?? "").toLowerCase().includes("size");
}

export type OpenAiVisualizationAiProviderOptions = Readonly<{
  model?: string;
  quality?: string;
  fetchImpl?: typeof fetch;
}>;

export class OpenAiVisualizationAiProvider implements VisualizationAiProvider {
  readonly id = "openai";
  readonly capabilities: VisualizationAiCapabilities = {
    supportsMask: true,
    supportsMultipleReferenceImages: false,
    supportsTransparentInput: true,
    supportedAspectRatios: ["1:1", "3:2", "2:3"],
    maxInputSize: { widthPx: 1536, heightPx: 1536 },
  };

  private readonly apiKey: string;
  /** Public (not a secret) so callers/tests can confirm what's actually configured without needing a network mock. */
  readonly model: string;
  readonly quality: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, options: OpenAiVisualizationAiProviderOptions = {}) {
    this.apiKey = apiKey;
    this.model = options.model ?? DEFAULT_OPENAI_IMAGE_MODEL;
    this.quality = options.quality ?? DEFAULT_OPENAI_IMAGE_QUALITY;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generateEnvironment(input: VisualizationAiGenerateInput): Promise<VisualizationAiGenerateResult> {
    if (input.widthPx <= 0 || input.heightPx <= 0) return { ok: false, reason: "invalid-response" };

    let beautyBytes: Uint8Array;
    let beautyDimensions: Readonly<{ width: number; height: number }>;
    let protectedMask: Readonly<{ width: number; height: number; rgba: Uint8Array }>;
    try {
      beautyBytes = dataUrlToPngBytes(input.beautyImageDataUrl);
      beautyDimensions = readPngDimensions(beautyBytes);
      protectedMask = decodePngToRgba(dataUrlToPngBytes(input.protectedMaskDataUrl));
    } catch (reason) {
      console.error("OpenAI provider: failed to decode beauty/protected-mask PNG", reason instanceof PngDecodeError ? reason.message : reason);
      return { ok: false, reason: "invalid-response" };
    }

    if (beautyDimensions.width !== protectedMask.width || beautyDimensions.height !== protectedMask.height) {
      console.error("OpenAI provider: beauty/mask size mismatch", beautyDimensions, { width: protectedMask.width, height: protectedMask.height });
      return { ok: false, reason: "invalid-response" };
    }

    const maskPngBytes = buildOpenAiEditMaskPng(protectedMask);
    const promptText = flattenPrompt(buildEnvironmentPrompt({
      metadata: input.sceneMetadata,
      environmentPreset: input.environmentPreset,
      peoplePreset: input.peoplePreset,
      lightingPreset: input.lightingPreset,
    }));
    logProviderDiagnostics("prompt built", {
      promptSha256: createHash("sha256").update(promptText, "utf8").digest("hex"),
      model: this.model,
      quality: this.quality,
      environmentPreset: input.environmentPreset,
      peoplePreset: input.peoplePreset,
      lightingPreset: input.lightingPreset,
    });

    const formData = new FormData();
    formData.append("model", this.model);
    formData.append("prompt", promptText);
    formData.append("quality", this.quality);
    formData.append("image", new Blob([new Uint8Array(beautyBytes)], { type: "image/png" }), "beauty.png");
    formData.append("mask", new Blob([new Uint8Array(maskPngBytes)], { type: "image/png" }), "mask.png");

    // v3.3a section 1: prefer requesting OpenAI's output at the EXACT Beauty dimensions first —
    // gpt-image-2 may support this even though it's not one of the older fixed enum values. Only
    // if that specific request is rejected for being a "size" problem do we retry once with the
    // closest-aspect fallback from the small fixed enum; either way the final image is normalized
    // to Beauty's exact dimensions below, so which path succeeded never leaks into the result.
    const exactSize = `${beautyDimensions.width}x${beautyDimensions.height}`;
    formData.set("size", exactSize);
    logProviderDiagnostics("requesting OpenAI (attempt 1, exact size)", { requestedSize: exactSize, provider: this.id, model: this.model });
    let attempt = await this.performEditRequest(formData);
    if (attempt.ok !== true && isSizeRejection(attempt.status, attempt.json)) {
      console.error("OpenAI provider: exact size rejected, retrying with fallback enum size", attempt.requestId, exactSize);
      const fallbackSize = pickFallbackOpenAiSize(beautyDimensions.width, beautyDimensions.height);
      formData.set("size", fallbackSize);
      logProviderDiagnostics("requesting OpenAI (attempt 2, fallback size)", { requestedSize: fallbackSize, provider: this.id, model: this.model });
      attempt = await this.performEditRequest(formData);
    }

    if (attempt.ok !== true) return attempt.result;

    const { b64, requestId } = attempt;
    let resultBytes: Uint8Array;
    let resultDimensions: Readonly<{ width: number; height: number }>;
    try {
      resultBytes = new Uint8Array(Buffer.from(b64, "base64"));
      resultDimensions = readPngDimensions(resultBytes);
    } catch (reason) {
      console.error("OpenAI provider: response image was not a valid PNG", requestId, reason instanceof PngDecodeError ? reason.message : reason);
      return { ok: false, reason: "invalid-response" };
    }

    let finalBytes = resultBytes;
    if (resultDimensions.width !== beautyDimensions.width || resultDimensions.height !== beautyDimensions.height) {
      // Deterministic, aspect-ratio-preserving normalization (report section 1): never a stretch,
      // never a crop — see lib/ai/imageFit.ts. Runs BEFORE returning, so the client-side
      // strict-lock composite always receives an image already at Beauty's exact resolution.
      let decoded;
      try {
        decoded = decodePngToRgba(resultBytes);
      } catch (reason) {
        console.error("OpenAI provider: response image failed full decode during resize", requestId, reason instanceof PngDecodeError ? reason.message : reason);
        return { ok: false, reason: "invalid-response" };
      }
      const fitted = fitImageWithLetterbox(decoded, beautyDimensions.width, beautyDimensions.height);
      finalBytes = encodeRgbaToPng(fitted.width, fitted.height, fitted.rgba as Uint8Array);
    }

    return {
      ok: true,
      environmentImageDataUrl: pngBytesToDataUrl(finalBytes),
      widthPx: beautyDimensions.width,
      heightPx: beautyDimensions.height,
      model: this.model,
    };
  }

  /**
   * One HTTP attempt against images.edit, given a FormData whose "size" field is already set.
   * Never throws — every failure mode (network, non-OK status, bad JSON, empty response) becomes
   * a typed result so the caller can decide whether to retry (size-rejection only) or give up.
   */
  private async performEditRequest(formData: FormData): Promise<
    | Readonly<{ ok: true; b64: string; requestId: string | null }>
    | Readonly<{ ok: false; status: number; json: OpenAiImagesEditResponse | null; requestId: string | null; result: VisualizationAiGenerateResult }>
  > {
    let response: Response;
    try {
      response = await this.fetchImpl(OPENAI_IMAGES_EDIT_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: formData,
      });
    } catch (reason) {
      console.error("OpenAI provider: network request failed", reason);
      return { ok: false, status: 0, json: null, requestId: null, result: { ok: false, reason: "provider-error" } };
    }

    // Logged only for support/debugging correlation with OpenAI's own dashboard — never
    // persisted (report "pokud je snadné" — this is the easy, low-risk version; threading it into
    // VisualizationItem would mean widening the persistence model, out of scope).
    const requestId = response.headers.get("x-request-id");

    let json: OpenAiImagesEditResponse | null = null;
    try {
      json = await response.json() as OpenAiImagesEditResponse;
    } catch (reason) {
      console.error("OpenAI provider: response was not valid JSON", requestId, reason);
      return { ok: false, status: response.status, json: null, requestId, result: { ok: false, reason: response.ok ? "invalid-response" : "provider-error" } };
    }

    if (!response.ok) {
      console.error("OpenAI provider: API returned an error", requestId, response.status, json.error?.message);
      return { ok: false, status: response.status, json, requestId, result: { ok: false, reason: "provider-error" } };
    }

    const b64 = json.data?.[0]?.b64_json;
    if (!b64) {
      console.error("OpenAI provider: response had no image data", requestId);
      return { ok: false, status: response.status, json, requestId, result: { ok: false, reason: "invalid-response" } };
    }

    return { ok: true, b64, requestId };
  }
}
