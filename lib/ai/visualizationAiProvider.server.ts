/**
 * Visualization v3/v3.3 — the provider-neutral AI environment-generation contract. Server-only
 * (`.server.ts` suffix, matching lib/storage/cloudflareR2.server.ts's convention) since a real
 * implementation needs a secret API key — never imported by client-bundled React code.
 *
 * `resolveVisualizationAiProvider` returns `undefined` by default — never throws, never
 * fabricates a key. Resolution order (report v3.3 "Provider resolution"):
 *   1. OPENAI_API_KEY set -> the real OpenAiVisualizationAiProvider.
 *   2. else the non-secret dev opt-in flag -> DeterministicFakeAiProvider (foundation testing).
 *   3. else undefined ("genuinely unavailable").
 */
import { DeterministicFakeAiProvider } from "./deterministicFakeAiProvider.ts";
import { OpenAiVisualizationAiProvider } from "./openaiVisualizationAiProvider.server.ts";
import type { EnvironmentPreset, LightingPreset, PeoplePreset } from "../../domain/visualizationAi.ts";
import type { CuratedAiSceneMetadata } from "../../domain/visualizationAiPrompt.ts";

export type VisualizationAiCapabilities = Readonly<{
  supportsMask: boolean;
  supportsMultipleReferenceImages: boolean;
  supportsTransparentInput: boolean;
  /** Informational only — the resize/aspect-ratio policy itself lives in domain/visualizationAi.ts's fitWithinMaxInputSize, never here. */
  supportedAspectRatios: readonly string[];
  maxInputSize: Readonly<{ widthPx: number; heightPx: number }>;
}>;

export type VisualizationAiGenerateInput = Readonly<{
  beautyImageDataUrl: string;
  /** Sent even to a provider with !supportsMask, as a soft hint only — NEVER load-bearing for protection. The real guarantee is client-side compositing (domain/visualizationCompositing.ts), which runs regardless of what the provider did or didn't respect. */
  protectedMaskDataUrl: string;
  environmentPreset: EnvironmentPreset;
  peoplePreset: PeoplePreset;
  lightingPreset: LightingPreset;
  sceneMetadata: CuratedAiSceneMetadata;
  widthPx: number;
  heightPx: number;
}>;

export type VisualizationAiGenerateResult =
  | Readonly<{ ok: true; environmentImageDataUrl: string; widthPx: number; heightPx: number; model: string }>
  | Readonly<{ ok: false; reason: "provider-error" | "invalid-response" | "unavailable" }>;

export interface VisualizationAiProvider {
  readonly id: string;
  readonly capabilities: VisualizationAiCapabilities;
  generateEnvironment(input: VisualizationAiGenerateInput): Promise<VisualizationAiGenerateResult>;
}

/**
 * A non-secret, dev-only opt-in — deliberately NOT an API key, just a boolean-ish flag documented
 * in .env.example as dev/test-only.
 */
const FAKE_PROVIDER_OPT_IN_ENV_VAR = "AI_VISUALIZATION_USE_FAKE_PROVIDER";
const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";
const OPENAI_IMAGE_MODEL_ENV_VAR = "OPENAI_IMAGE_MODEL";
const OPENAI_IMAGE_QUALITY_ENV_VAR = "OPENAI_IMAGE_QUALITY";

export function resolveVisualizationAiProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): VisualizationAiProvider | undefined {
  const openAiApiKey = env[OPENAI_API_KEY_ENV_VAR];
  if (openAiApiKey) {
    return new OpenAiVisualizationAiProvider(openAiApiKey, {
      model: env[OPENAI_IMAGE_MODEL_ENV_VAR] || undefined,
      quality: env[OPENAI_IMAGE_QUALITY_ENV_VAR] || undefined,
    });
  }
  if (env[FAKE_PROVIDER_OPT_IN_ENV_VAR] === "1" || env[FAKE_PROVIDER_OPT_IN_ENV_VAR] === "true") {
    return new DeterministicFakeAiProvider();
  }
  return undefined;
}
