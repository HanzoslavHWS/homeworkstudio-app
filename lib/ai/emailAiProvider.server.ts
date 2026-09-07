/**
 * E-maily — the provider-neutral AI email-assistant contract. Server-only (`.server.ts` suffix,
 * matching lib/ai/visualizationAiProvider.server.ts's convention) since a real implementation
 * needs a secret API key — never imported by client-bundled React code.
 *
 * `resolveEmailAiProvider` returns `undefined` by default — never throws, never fabricates a key.
 * Resolution order (mirrors visualizationAiProvider.server.ts):
 *   1. OPENAI_API_KEY set -> the real OpenAiEmailAiProvider.
 *   2. else the non-secret dev opt-in flag -> DeterministicFakeEmailAiProvider (testing).
 *   3. else undefined ("genuinely unavailable").
 */
import { DeterministicFakeEmailAiProvider } from "./deterministicFakeEmailAiProvider.ts";
import { OpenAiEmailAiProvider } from "./openaiEmailAiProvider.server.ts";
import type { EmailAiTone } from "../../domain/emailAiConfig.ts";
import type { EmailEventContext } from "../../domain/emailEventContext.ts";

export type EmailAiGenerateInput = Readonly<{
  freeText: string;
  promptLanguage: string;
  tone: EmailAiTone;
  templateInstruction?: string;
  eventContext?: EmailEventContext;
  recipientName?: string;
  /** See domain/emailAiPrompt.ts's EmailAiGenerationPromptInput.additionalContext — grounding facts the model may reference but must not proactively list out. */
  additionalContext?: readonly string[];
}>;

export type EmailAiRewriteInput = Readonly<{
  currentSubject: string;
  currentBody: string;
  actionInstruction: string;
  promptLanguage: string;
}>;

export type EmailAiResult =
  | Readonly<{ ok: true; subject: string; body: string; model: string }>
  | Readonly<{ ok: false; reason: "provider-error" | "invalid-response" | "unavailable" }>;

export interface EmailAiProvider {
  readonly id: string;
  generateEmail(input: EmailAiGenerateInput): Promise<EmailAiResult>;
  rewriteEmail(input: EmailAiRewriteInput): Promise<EmailAiResult>;
}

/** A non-secret, dev-only opt-in — deliberately NOT an API key, documented in .env.example as dev/test-only. */
const FAKE_PROVIDER_OPT_IN_ENV_VAR = "AI_EMAIL_USE_FAKE_PROVIDER";
const OPENAI_API_KEY_ENV_VAR = "OPENAI_API_KEY";
const OPENAI_TEXT_MODEL_ENV_VAR = "OPENAI_TEXT_MODEL";

export function resolveEmailAiProvider(
  env: Readonly<Record<string, string | undefined>> = process.env,
): EmailAiProvider | undefined {
  const openAiApiKey = env[OPENAI_API_KEY_ENV_VAR];
  if (openAiApiKey) {
    return new OpenAiEmailAiProvider(openAiApiKey, { model: env[OPENAI_TEXT_MODEL_ENV_VAR] || undefined });
  }
  if (env[FAKE_PROVIDER_OPT_IN_ENV_VAR] === "1" || env[FAKE_PROVIDER_OPT_IN_ENV_VAR] === "true") {
    return new DeterministicFakeEmailAiProvider();
  }
  return undefined;
}
