/**
 * E-maily — saved templates ("Uložit jako vzor"). Globally shared, matching this app's single
 * shared-login model (no per-user ownership concept exists anywhere else either — see
 * lib/auth/session.ts). A template can carry BOTH a sample free-text seed AND a standing AI
 * instruction (e.g. "always mention this is a proforma invoice"), per spec — never text-only.
 *
 * v1.2 — `scope` distinguishes company-wide "system" templates (seeded by migration, read-only
 * through this app's API) from "user" templates (created/edited/deleted freely). `userId` is a
 * reserved, currently-unused column: this app has no per-user accounts yet (one shared login —
 * see lib/auth/session.ts), so it is always undefined today. It exists purely so a future
 * per-user ownership feature is a data migration away, never a schema rewrite; "system" templates
 * are protected by scope alone regardless of identity, which is already enforceable now.
 */

export type EmailTemplateScope = "system" | "user";

export type EmailTemplate = Readonly<{
  id: string;
  name: string;
  scope: EmailTemplateScope;
  /** Reserved for future per-user ownership — always undefined until real accounts exist. */
  userId?: string;
  freeText?: string;
  aiInstruction?: string;
  languageCode?: string;
  toneId?: string;
  createdAt: string;
  updatedAt: string;
}>;

export type EmailTemplateCreateInput = Readonly<{
  name: string;
  freeText?: string;
  aiInstruction?: string;
  languageCode?: string;
  toneId?: string;
}>;

export type EmailTemplateEditInput = EmailTemplateCreateInput;

/** Thrown by a repository when an update/delete targets a scope: "system" row — those are never editable through this app's API, regardless of who's asking. */
export class EmailTemplateProtectedError extends Error {
  readonly code = "template-protected" as const;
  constructor(id: string) {
    super(`Systémový vzor (${id}) nelze upravit ani smazat.`);
    this.name = "EmailTemplateProtectedError";
  }
}

export interface EmailTemplateRepository {
  list(): Promise<readonly EmailTemplate[]>;
  /** Always creates a scope: "user" template — the API/UI can never create a system template. */
  create(input: EmailTemplateCreateInput): Promise<EmailTemplate>;
  /** Throws EmailTemplateProtectedError when the target row is scope: "system". */
  update(id: string, edit: EmailTemplateEditInput): Promise<EmailTemplate>;
  /** Throws EmailTemplateProtectedError when the target row is scope: "system". */
  delete(id: string): Promise<void>;
}
