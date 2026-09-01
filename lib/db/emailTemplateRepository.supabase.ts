import type { SupabaseClient } from "@supabase/supabase-js";
import {
  EmailTemplateProtectedError,
  type EmailTemplate,
  type EmailTemplateCreateInput,
  type EmailTemplateEditInput,
  type EmailTemplateRepository,
  type EmailTemplateScope,
} from "../../domain/emailTemplate.ts";

type EmailTemplateRow = Readonly<{
  id: string;
  name: string;
  scope: string;
  user_id: string | null;
  document: unknown;
  created_at: string;
  updated_at: string;
}>;

type EmailTemplateDocument = Readonly<{
  freeText?: string;
  aiInstruction?: string;
  languageCode?: string;
  toneId?: string;
}>;

function rowToTemplate(row: EmailTemplateRow): EmailTemplate {
  const document = (row.document ?? {}) as EmailTemplateDocument;
  return {
    id: row.id,
    name: row.name,
    scope: row.scope as EmailTemplateScope,
    userId: row.user_id ?? undefined,
    freeText: document.freeText,
    aiInstruction: document.aiInstruction,
    languageCode: document.languageCode,
    toneId: document.toneId,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function editToDocument(edit: EmailTemplateEditInput): EmailTemplateDocument {
  return {
    freeText: edit.freeText,
    aiInstruction: edit.aiInstruction,
    languageCode: edit.languageCode,
    toneId: edit.toneId,
  };
}

export class SupabaseEmailTemplateRepository implements EmailTemplateRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(): Promise<readonly EmailTemplate[]> {
    const { data, error } = await this.client.from("email_templates").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return ((data ?? []) as EmailTemplateRow[]).map(rowToTemplate);
  }

  /** Always inserts scope: "user" — this app's API never creates a system template (those exist only via migration seed). */
  async create(input: EmailTemplateCreateInput): Promise<EmailTemplate> {
    const { data, error } = await this.client
      .from("email_templates")
      .insert({ name: input.name, scope: "user", document: editToDocument(input) })
      .select()
      .single();
    if (error) throw error;
    return rowToTemplate(data as EmailTemplateRow);
  }

  async update(id: string, edit: EmailTemplateEditInput): Promise<EmailTemplate> {
    await this.assertNotProtected(id);
    const { data, error } = await this.client
      .from("email_templates")
      .update({ name: edit.name, document: editToDocument(edit) })
      .eq("id", id)
      .eq("scope", "user")
      .select();
    if (error) throw error;
    if (!data || data.length === 0) throw new EmailTemplateProtectedError(id);
    return rowToTemplate((data as EmailTemplateRow[])[0]!);
  }

  async delete(id: string): Promise<void> {
    await this.assertNotProtected(id);
    const { error } = await this.client.from("email_templates").delete().eq("id", id).eq("scope", "user");
    if (error) throw error;
  }

  /** Pre-check so callers get a clear EmailTemplateProtectedError instead of a silent no-op when the row simply doesn't exist yet. */
  private async assertNotProtected(id: string): Promise<void> {
    const { data, error } = await this.client.from("email_templates").select("scope").eq("id", id).maybeSingle();
    if (error) throw error;
    if (data && (data as { scope: string }).scope === "system") throw new EmailTemplateProtectedError(id);
  }
}
