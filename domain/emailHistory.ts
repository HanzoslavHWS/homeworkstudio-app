/**
 * E-maily v1.2 — history of actually-used emails (section 10/11). Deliberately NOT written on
 * every AI generate/rewrite call — only when the user really uses the result (Kopírovat /
 * Otevřít v Outlooku / explicit Uložit do historie), to avoid flooding the list with throwaway
 * intermediate drafts. Globally shared for now (see domain/emailTemplate.ts's doc comment — no
 * per-user accounts exist yet); `userId` is reserved the same way.
 */

export type EmailHistoryEntry = Readonly<{
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Reserved for future per-user ownership — always undefined until real accounts exist. */
  userId?: string;
  eventId?: string;
  /** Stamped once at save time from the then-current event name — never re-derived, so history stays correct even if the event is later renamed. */
  eventNameSnapshot?: string;
  recipientName?: string;
  language: string;
  tone?: string;
  subject: string;
  body: string;
  sourceInput?: string;
  templateId?: string;
}>;

export type EmailHistorySaveInput = Readonly<{
  eventId?: string;
  eventNameSnapshot?: string;
  recipientName?: string;
  language: string;
  tone?: string;
  subject: string;
  body: string;
  sourceInput?: string;
  templateId?: string;
}>;

/** Loose shape check for the API routes — returns undefined (never throws) so callers can 400 with a generic message, matching this module's "pure, no fetch/DOM" scope. */
export function parseEmailHistorySaveInput(entry: Partial<EmailHistorySaveInput> | undefined): EmailHistorySaveInput | undefined {
  if (!entry) return undefined;
  if (typeof entry.language !== "string" || entry.language.length === 0) return undefined;
  if (typeof entry.subject !== "string") return undefined;
  if (typeof entry.body !== "string" || entry.body.trim().length === 0) return undefined;
  return {
    eventId: entry.eventId,
    eventNameSnapshot: entry.eventNameSnapshot,
    recipientName: entry.recipientName,
    language: entry.language,
    tone: entry.tone,
    subject: entry.subject,
    body: entry.body,
    sourceInput: entry.sourceInput,
    templateId: entry.templateId,
  };
}

export interface EmailHistoryRepository {
  list(): Promise<readonly EmailHistoryEntry[]>;
  create(input: EmailHistorySaveInput): Promise<EmailHistoryEntry>;
  update(id: string, input: EmailHistorySaveInput): Promise<EmailHistoryEntry>;
  delete(id: string): Promise<void>;
}

export type NextHistorySaveAction =
  | Readonly<{ action: "create" }>
  | Readonly<{ action: "update"; id: string }>;

/**
 * Section 12's dedup rule, isolated as a pure/testable decision: once the current working email
 * has been saved once, every further auto-save (Copy then Outlook, or several Copy clicks in a
 * row) updates that SAME record instead of creating a new one. Callers reset `currentHistoryId`
 * to undefined exactly on: a fresh "Vytvořit e-mail", loading a template, and "Znovu použít" from
 * history — never on a rewrite action or a manual subject/body edit.
 */
export function nextHistorySaveAction(currentHistoryId: string | undefined): NextHistorySaveAction {
  return currentHistoryId ? { action: "update", id: currentHistoryId } : { action: "create" };
}
