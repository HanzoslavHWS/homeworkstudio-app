/**
 * E-maily — clean boundary for a real Outlook draft-creation provider (real-usage follow-up
 * spec sections 11/12/13). Pure types only, no HTTP/Graph SDK code here — any real
 * implementation (Microsoft Graph or otherwise) belongs entirely server-side, resolved by
 * lib/mail/outlookDraftProvider.server.ts, same separation as lib/ai/emailAiProvider.server.ts.
 *
 * This is intentionally NOT the same interface as domain/communication.ts's `EmailDraftProvider`/
 * `OutlookDraftProvider` — those belong to the older, unrelated per-project rule-based email
 * feature (WorkflowSteps.tsx's disabled "futureAccess" stub), built around a completely different
 * `EmailDraft`/`saveDraft` shape. This module is scoped to the CURRENT AI "E-maily" module
 * (subject/body already produced by /api/emails/ai-generate) and print-surfaces' attachment
 * handoff — named distinctly to avoid any confusion between the two.
 *
 * `attachments` reference a StoredAsset by storageKey rather than carrying inline bytes — a real
 * provider implementation fetches the bytes server-side (e.g. from Cloudflare R2) and
 * base64-encodes them for the Graph attachment API itself; the client never handles/uploads raw
 * PDF bytes a second time.
 */

export type EmailOutlookDraftAttachment = Readonly<{
  fileName: string;
  contentType: string;
  storageKey: string;
}>;

export type EmailOutlookDraftInput = Readonly<{
  recipient?: string;
  subject: string;
  body: string;
  attachments?: readonly EmailOutlookDraftAttachment[];
}>;

export type EmailOutlookDraftResult = Readonly<{
  draftId: string;
  webLink: string;
}>;

export interface EmailOutlookDraftProvider {
  readonly id: string;
  createDraft(input: EmailOutlookDraftInput): Promise<EmailOutlookDraftResult>;
}

export class EmailOutlookDraftRequestError extends Error {
  readonly code = "invalid-request" as const;
  constructor(message: string) {
    super(message);
    this.name = "EmailOutlookDraftRequestError";
  }
}

const MAX_SUBJECT_LENGTH = 500;
const MAX_BODY_LENGTH = 20000;
const MAX_RECIPIENT_LENGTH = 200;
const MAX_ATTACHMENTS = 5;

function assertValidAttachment(value: unknown): asserts value is EmailOutlookDraftAttachment {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new EmailOutlookDraftRequestError("Neplatná příloha.");
  const record = value as Record<string, unknown>;
  if (typeof record.fileName !== "string" || record.fileName.trim().length === 0) throw new EmailOutlookDraftRequestError("Neplatná příloha.");
  if (typeof record.contentType !== "string" || record.contentType.trim().length === 0) throw new EmailOutlookDraftRequestError("Neplatná příloha.");
  if (typeof record.storageKey !== "string" || record.storageKey.trim().length === 0) throw new EmailOutlookDraftRequestError("Neplatná příloha.");
}

/** Mirrors domain/emailAi.ts's `asserts`-based validator convention. Pure domain, no fetch/DOM. */
export function assertValidEmailOutlookDraftInput(body: unknown): asserts body is EmailOutlookDraftInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new EmailOutlookDraftRequestError("Požadavek musí být JSON objekt.");
  const record = body as Record<string, unknown>;
  if (typeof record.subject !== "string" || record.subject.length > MAX_SUBJECT_LENGTH) throw new EmailOutlookDraftRequestError("Neplatný předmět e-mailu.");
  if (typeof record.body !== "string" || record.body.trim().length === 0 || record.body.length > MAX_BODY_LENGTH) throw new EmailOutlookDraftRequestError("Neplatný text e-mailu.");
  if (record.recipient !== undefined && (typeof record.recipient !== "string" || record.recipient.length > MAX_RECIPIENT_LENGTH)) {
    throw new EmailOutlookDraftRequestError("Neplatný příjemce.");
  }
  if (record.attachments !== undefined) {
    if (!Array.isArray(record.attachments) || record.attachments.length > MAX_ATTACHMENTS) throw new EmailOutlookDraftRequestError("Neplatné přílohy.");
    for (const attachment of record.attachments) assertValidAttachment(attachment);
  }
}
