/**
 * Visualization v3 — the provider-neutral AI environment-generation contract. Server-only
 * (`.server.ts` suffix, matching lib/storage/cloudflareR2.server.ts's convention) since a real
 * implementation needs a secret API key — never imported by client-bundled React code.
 *
 * No real provider is implemented in this batch (confirmed by audit: zero AI SDK/client exists
 * anywhere in this repo). `resolveVisualizationAiProvider` returns `undefined` by default —
 * never throws, never fabricates a key — unless a non-secret dev opt-in flag explicitly enables
 * the deterministic fake provider for foundation testing. This keeps "genuinely unavailable"
 * (production default today) cleanly distinguishable from "fake provider enabled for testing."
 */
import { DeterministicFakeAiProvider } from "./deterministicFakeAiProvider.ts";
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
 * in .env.example as dev/test-only. Real provider env vars (when one is eventually added) would
 * follow this codebase's existing SCREAMING_SNAKE_CASE-with-provider-prefix convention (e.g.
 * STABILITY_API_KEY — see the end-of-batch report for the recommended real provider) and would
 * be checked here FIRST, before ever falling back to the fake.
 */
const FAKE_PROVIDER_OPT_IN_ENV_VAR = "AI_VISUALIZATION_USE_FAKE_PROVIDER";

export function resolveVisualizationAiProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): VisualizationAiProvider | undefined {
  // No real provider is implemented this batch — there is nothing to check for here yet beyond
  // the fake-provider opt-in. When a real provider is added, its own env var check goes first.
  if (env[FAKE_PROVIDER_OPT_IN_ENV_VAR] === "1" || env[FAKE_PROVIDER_OPT_IN_ENV_VAR] === "true") {
    return new DeterministicFakeAiProvider();
  }
  return undefined;
}
