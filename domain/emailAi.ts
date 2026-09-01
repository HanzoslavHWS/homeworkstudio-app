/**
 * E-maily — server route request contracts + validation. Mirrors domain/visualizationAi.ts's
 * `asserts`-based validator convention. Pure domain, no fetch/DOM.
 */
import { findEmailAiLanguage, findEmailAiTone, findEmailAiRewriteAction, DEFAULT_EMAIL_AI_TONE_ID } from "./emailAiConfig.ts";
import type { EmailEventContext } from "./emailEventContext.ts";

export class EmailAiRequestError extends Error {
  readonly code = "invalid-request" as const;
  constructor(message: string) {
    super(message);
    this.name = "EmailAiRequestError";
  }
}

const MAX_FREE_TEXT_LENGTH = 8000;
const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 20000;
const MAX_RECIPIENT_NAME_LENGTH = 120;
const MAX_EVENT_FIELD_LENGTH = 200;

export type EmailAiGenerateRequestBody = Readonly<{
  freeText: string;
  languageCode: string;
  toneId: string;
  templateInstruction?: string;
  eventContext?: EmailEventContext;
  recipientName?: string;
}>;

function assertValidEventContext(value: unknown): asserts value is EmailEventContext {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EmailAiRequestError("Neplatný event kontext.");
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) throw new EmailAiRequestError("Neplatný event kontext.");
  if (typeof record.name !== "string" || record.name.trim().length === 0 || record.name.length > MAX_EVENT_FIELD_LENGTH) throw new EmailAiRequestError("Neplatný event kontext.");
  for (const field of ["dateFrom", "dateTo", "venue"] as const) {
    if (record[field] !== undefined && (typeof record[field] !== "string" || (record[field] as string).length > MAX_EVENT_FIELD_LENGTH)) {
      throw new EmailAiRequestError("Neplatný event kontext.");
    }
  }
}

export function assertValidEmailAiGenerateRequestBody(body: unknown): asserts body is EmailAiGenerateRequestBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new EmailAiRequestError("Požadavek musí být JSON objekt.");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.freeText !== "string" || record.freeText.trim().length === 0) throw new EmailAiRequestError("Zadejte text e-mailu.");
  if (record.freeText.length > MAX_FREE_TEXT_LENGTH) throw new EmailAiRequestError("Zadaný text je příliš dlouhý.");
  if (typeof record.languageCode !== "string" || !findEmailAiLanguage(record.languageCode)) throw new EmailAiRequestError("Neplatný jazyk.");
  if (record.toneId !== undefined && (typeof record.toneId !== "string" || !findEmailAiTone(record.toneId))) throw new EmailAiRequestError("Neplatný styl e-mailu.");
  if (record.templateInstruction !== undefined && typeof record.templateInstruction !== "string") throw new EmailAiRequestError("Neplatná instrukce vzoru.");
  if (record.eventContext !== undefined) assertValidEventContext(record.eventContext);
  if (record.recipientName !== undefined && (typeof record.recipientName !== "string" || record.recipientName.length > MAX_RECIPIENT_NAME_LENGTH)) {
    throw new EmailAiRequestError("Neplatné jméno / oslovení.");
  }
}

export type EmailAiRewriteRequestBody = Readonly<{
  subject: string;
  body: string;
  actionId: string;
  languageCode: string;
}>;

export function assertValidEmailAiRewriteRequestBody(body: unknown): asserts body is EmailAiRewriteRequestBody {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new EmailAiRequestError("Požadavek musí být JSON objekt.");
  }
  const record = body as Record<string, unknown>;
  if (typeof record.subject !== "string") throw new EmailAiRequestError("Chybí předmět e-mailu.");
  if (record.subject.length > MAX_SUBJECT_LENGTH) throw new EmailAiRequestError("Předmět e-mailu je příliš dlouhý.");
  if (typeof record.body !== "string" || record.body.trim().length === 0) throw new EmailAiRequestError("Chybí text e-mailu.");
  if (record.body.length > MAX_BODY_LENGTH) throw new EmailAiRequestError("Text e-mailu je příliš dlouhý.");
  if (typeof record.actionId !== "string" || !findEmailAiRewriteAction(record.actionId)) throw new EmailAiRequestError("Neplatná rychlá úprava.");
  if (typeof record.languageCode !== "string" || !findEmailAiLanguage(record.languageCode)) throw new EmailAiRequestError("Neplatný jazyk.");
}

/** Convenience resolver used by both API routes — falls back to the default tone when omitted. */
export function resolveEmailAiTone(toneId: string | undefined) {
  return findEmailAiTone(toneId ?? DEFAULT_EMAIL_AI_TONE_ID) ?? findEmailAiTone(DEFAULT_EMAIL_AI_TONE_ID)!;
}
