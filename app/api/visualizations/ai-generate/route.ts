import { NextResponse, type NextRequest } from "next/server.js";
import {
  assertValidVisualizationAiGenerateRequestBody,
  fitWithinMaxInputSize,
  VisualizationAiRequestError,
} from "../../../../domain/visualizationAi.ts";
import { isVisualizationAiRequestAuthorized } from "../../../../lib/ai/visualizationAiRouteAuth.server.ts";
import { resolveVisualizationAiProvider } from "../../../../lib/ai/visualizationAiProvider.server.ts";
import type { CuratedAiSceneMetadata } from "../../../../domain/visualizationAiPrompt.ts";
import type { VisualizationAiProvider } from "../../../../lib/ai/visualizationAiProvider.server.ts";

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
