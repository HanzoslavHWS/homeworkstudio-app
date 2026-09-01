/**
 * E-maily — deterministic fake AI provider, mirrors lib/ai/deterministicFakeAiProvider.ts's role:
 * exercises the full request/response pipeline (route validation, JSON shape, UI rendering)
 * without a network call or a real API key. Output is a pure function of the input text, never
 * random, so tests can assert exact equality across repeated calls.
 */
import type { EmailAiGenerateInput, EmailAiProvider, EmailAiResult, EmailAiRewriteInput } from "./emailAiProvider.server.ts";

export class DeterministicFakeEmailAiProvider implements EmailAiProvider {
  readonly id = "deterministic-fake";

  async generateEmail(input: EmailAiGenerateInput): Promise<EmailAiResult> {
    const firstLine = input.freeText.trim().split(/\r?\n/)[0] ?? "";
    const greeting = input.recipientName ? `Hello ${input.recipientName},` : "Hello,";
    const eventLine = input.eventContext ? `[event: ${input.eventContext.name}]\n` : "";
    return {
      ok: true,
      subject: `[${input.promptLanguage}/${input.tone.id}] ${firstLine.slice(0, 60)}`,
      body: `${eventLine}${greeting}\n\n${input.freeText.trim()}\n\nBest regards`,
      model: "deterministic-fake-email-v1",
    };
  }

  async rewriteEmail(input: EmailAiRewriteInput): Promise<EmailAiResult> {
    return {
      ok: true,
      subject: input.currentSubject,
      body: `${input.currentBody}\n\n[${input.actionInstruction}]`,
      model: "deterministic-fake-email-v1",
    };
  }
}
