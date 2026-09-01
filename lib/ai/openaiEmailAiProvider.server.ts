/**
 * E-maily — the real OpenAI Chat Completions provider. Implements the SAME EmailAiProvider
 * interface as lib/ai/deterministicFakeEmailAiProvider.ts — no second AI system, no parallel
 * request/response shape. `.server.ts` because it carries a real API key.
 *
 * Uses response_format: json_object so the model's reply is guaranteed-parseable JSON; the actual
 * prompt text (system + user) is built once in domain/emailAiPrompt.ts and never duplicated here.
 */
import { buildEmailGenerationPrompt, buildEmailRewritePrompt } from "../../domain/emailAiPrompt.ts";
import type { EmailAiGenerateInput, EmailAiProvider, EmailAiResult, EmailAiRewriteInput } from "./emailAiProvider.server.ts";

export const DEFAULT_OPENAI_TEXT_MODEL = "gpt-4o-mini";
const OPENAI_CHAT_COMPLETIONS_URL = "https://api.openai.com/v1/chat/completions";

type OpenAiChatCompletionsResponse = Readonly<{
  choices?: readonly Readonly<{ message?: Readonly<{ content?: string }> }>[];
  error?: Readonly<{ message?: string }>;
}>;

type ParsedEmailJson = Readonly<{ subject: string; body: string }>;

function parseEmailJson(content: string): ParsedEmailJson | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const record = parsed as Record<string, unknown>;
  if (typeof record.subject !== "string" || typeof record.body !== "string") return undefined;
  if (record.body.trim().length === 0) return undefined;
  return { subject: record.subject, body: record.body };
}

export type OpenAiEmailAiProviderOptions = Readonly<{
  model?: string;
  fetchImpl?: typeof fetch;
}>;

export class OpenAiEmailAiProvider implements EmailAiProvider {
  readonly id = "openai";
  /** Public (not a secret) so callers/tests can confirm what's actually configured without a network mock. */
  readonly model: string;

  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;

  constructor(apiKey: string, options: OpenAiEmailAiProviderOptions = {}) {
    this.apiKey = apiKey;
    this.model = options.model ?? DEFAULT_OPENAI_TEXT_MODEL;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async generateEmail(input: EmailAiGenerateInput): Promise<EmailAiResult> {
    const prompt = buildEmailGenerationPrompt(input);
    return this.requestCompletion(prompt.system, prompt.user);
  }

  async rewriteEmail(input: EmailAiRewriteInput): Promise<EmailAiResult> {
    const prompt = buildEmailRewritePrompt(input);
    return this.requestCompletion(prompt.system, prompt.user);
  }

  /** One never-throw HTTP request against chat/completions — every failure mode becomes a typed result. */
  private async requestCompletion(system: string, user: string): Promise<EmailAiResult> {
    let response: Response;
    try {
      response = await this.fetchImpl(OPENAI_CHAT_COMPLETIONS_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: this.model,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });
    } catch (reason) {
      console.error("OpenAI email provider: network request failed", reason);
      return { ok: false, reason: "provider-error" };
    }

    let json: OpenAiChatCompletionsResponse;
    try {
      json = await response.json() as OpenAiChatCompletionsResponse;
    } catch (reason) {
      console.error("OpenAI email provider: response was not valid JSON", reason);
      return { ok: false, reason: response.ok ? "invalid-response" : "provider-error" };
    }

    if (!response.ok) {
      console.error("OpenAI email provider: API returned an error", response.status, json.error?.message);
      return { ok: false, reason: "provider-error" };
    }

    const content = json.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      console.error("OpenAI email provider: response had no message content");
      return { ok: false, reason: "invalid-response" };
    }

    const parsed = parseEmailJson(content);
    if (!parsed) {
      console.error("OpenAI email provider: response content was not the expected {subject, body} JSON shape");
      return { ok: false, reason: "invalid-response" };
    }

    return { ok: true, subject: parsed.subject, body: parsed.body, model: this.model };
  }
}
