import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server.js";
import {
  assertValidVisualizationAiGenerateRequestBody,
  fitWithinMaxInputSize,
  VisualizationAiRequestError,
  type VisualizationAiGenerateRequestBody,
} from "../../../../domain/visualizationAi.ts";
import { isVisualizationAiRequestAuthorized } from "../../../../lib/ai/visualizationAiRouteAuth.server.ts";
import { resolveVisualizationAiProvider } from "../../../../lib/ai/visualizationAiProvider.server.ts";
import { dataUrlToPngBytes, PngDecodeError, readPngDimensions } from "../../../../lib/ai/pngDecoder.ts";
import type { CuratedAiSceneMetadata } from "../../../../domain/visualizationAiPrompt.ts";
import type { VisualizationAiProvider } from "../../../../lib/ai/visualizationAiProvider.server.ts";

/**
 * v3.3d — dev-only diagnostics for the "ghosting only on the FIRST request" audit (report
 * v3.3d). Logs exactly what this route actually received for a given request — never anything
 * sensitive (no API key ever touches this route at all), just dimensions/hashes/presets — so two
 * consecutive requests with the SAME view/settings can be compared byte-for-byte. Independent of
 * (and a cross-check against) the client-side log in AiVisualizationPanel.tsx: if the two
 * disagree, the request body was altered in transit; if they agree but the AI output still
 * differs, the capture itself (client-side state/timing) is the next place to look, not the
 * network layer. Gated on NODE_ENV, never runs in production, never affects the response.
 */
function logAiGenerationRequestDiagnostics(body: VisualizationAiGenerateRequestBody): void {
  if (process.env.NODE_ENV === "production") return;
  try {
    const beautyBytes = dataUrlToPngBytes(body.beautyImageDataUrl);
    const maskBytes = dataUrlToPngBytes(body.protectedMaskDataUrl);
    const beautyDimensions = readPngDimensions(beautyBytes);
    const maskDimensions = readPngDimensions(maskBytes);
    // eslint-disable-next-line no-console
    console.info("[ai-generation-diagnostics] route received request", {
      timestamp: new Date().toISOString(),
      viewId: body.viewId,
      sourceRenderId: body.sourceRenderId,
      beautyWidthPx: beautyDimensions.width,
      beautyHeightPx: beautyDimensions.height,
      protectedMaskWidthPx: maskDimensions.width,
      protectedMaskHeightPx: maskDimensions.height,
      beautySha256: createHash("sha256").update(beautyBytes).digest("hex"),
      protectedMaskSha256: createHash("sha256").update(maskBytes).digest("hex"),
      environmentPreset: body.environmentPreset,
      peoplePreset: body.peoplePreset,
      lightingPreset: body.lightingPreset,
    });
  } catch (reason) {
    console.warn("[ai-generation-diagnostics] failed to compute route diagnostics", reason instanceof PngDecodeError ? reason.message : reason);
  }
}

/**
 * Scoped to exactly one job: validate → resolve provider → call generateEnvironment → return the
 * raw environment image. Compositing never happens here — the browser already holds the
 * authoritative beauty/mask pixels from the live scene, so round-tripping them server-side would
 * add cost/latency for zero protection benefit (the guarantee lives in
 * domain/visualizationCompositing.ts, which always runs client-side regardless of what happens here).
 */
export async function handleVisualizationAiGenerate(
  request: NextRequest,
  providerFactory: () => VisualizationAiProvider | undefined = resolveVisualizationAiProvider,
): Promise<NextResponse> {
  if (!(await isVisualizationAiRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro generování AI vizualizace je vyžadováno přihlášení." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }

  try {
    assertValidVisualizationAiGenerateRequestBody(body);
  } catch (error) {
    if (error instanceof VisualizationAiRequestError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    throw error;
  }
  logAiGenerationRequestDiagnostics(body);

  const provider = providerFactory();
  if (provider === undefined) {
    return NextResponse.json({ error: "AI generování prostředí není momentálně nakonfigurováno.", code: "provider-unavailable" }, { status: 503 });
  }

  const fit = fitWithinMaxInputSize(body.widthPx, body.heightPx, provider.capabilities.maxInputSize);

  try {
    const result = await provider.generateEnvironment({
      beautyImageDataUrl: body.beautyImageDataUrl,
      protectedMaskDataUrl: body.protectedMaskDataUrl,
      environmentPreset: body.environmentPreset,
      peoplePreset: body.peoplePreset,
      lightingPreset: body.lightingPreset,
      sceneMetadata: body.sceneMetadata as CuratedAiSceneMetadata,
      widthPx: fit.widthPx,
      heightPx: fit.heightPx,
    });

    if (result.ok !== true) {
      return NextResponse.json({ error: "AI generování prostředí selhalo.", code: result.reason }, { status: 502 });
    }
    if (
      typeof result.environmentImageDataUrl !== "string" ||
      !result.environmentImageDataUrl.startsWith("data:image") ||
      result.widthPx <= 0 ||
      result.heightPx <= 0
    ) {
      return NextResponse.json({ error: "AI poskytovatel vrátil neplatný výsledek.", code: "invalid-response" }, { status: 502 });
    }

    return NextResponse.json({
      environmentImageDataUrl: result.environmentImageDataUrl,
      widthPx: result.widthPx,
      heightPx: result.heightPx,
      model: result.model,
      provider: provider.id,
      resolutionDownscaled: fit.downscaled,
    });
  } catch {
    return NextResponse.json({ error: "AI generování prostředí se nezdařilo." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleVisualizationAiGenerate(request);
}
