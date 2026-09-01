import type { SupabaseClient } from "@supabase/supabase-js";
import type { EmailHistoryEntry, EmailHistoryRepository, EmailHistorySaveInput } from "../../domain/emailHistory.ts";

type EmailHistoryRow = Readonly<{
  id: string;
  user_id: string | null;
  event_id: string | null;
  event_name_snapshot: string | null;
  recipient_name: string | null;
  language: string;
  tone: string | null;
  subject: string;
  body: string;
  source_input: string | null;
  template_id: string | null;
  created_at: string;
  updated_at: string;
}>;

function rowToEntry(row: EmailHistoryRow): EmailHistoryEntry {
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    userId: row.user_id ?? undefined,
    eventId: row.event_id ?? undefined,
    eventNameSnapshot: row.event_name_snapshot ?? undefined,
    recipientName: row.recipient_name ?? undefined,
    language: row.language,
    tone: row.tone ?? undefined,
    subject: row.subject,
    body: row.body,
    sourceInput: row.source_input ?? undefined,
    templateId: row.template_id ?? undefined,
  };
}

function inputToRow(input: EmailHistorySaveInput) {
  return {
    event_id: input.eventId ?? null,
    event_name_snapshot: input.eventNameSnapshot ?? null,
    recipient_name: input.recipientName ?? null,
    language: input.language,
    tone: input.tone ?? null,
    subject: input.subject,
    body: input.body,
    source_input: input.sourceInput ?? null,
    template_id: input.templateId ?? null,
  };
}

export class SupabaseEmailHistoryRepository implements EmailHistoryRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(): Promise<readonly EmailHistoryEntry[]> {
    const { data, error } = await this.client.from("email_history").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return ((data ?? []) as EmailHistoryRow[]).map(rowToEntry);
  }

  async create(input: EmailHistorySaveInput): Promise<EmailHistoryEntry> {
    const { data, error } = await this.client.from("email_history").insert(inputToRow(input)).select().single();
    if (error) throw error;
    return rowToEntry(data as EmailHistoryRow);
  }

  async update(id: string, input: EmailHistorySaveInput): Promise<EmailHistoryEntry> {
    const { data, error } = await this.client
      .from("email_history")
      .update(inputToRow(input))
      .eq("id", id)
      .select()
      .single();
    if (error) throw error;
    return rowToEntry(data as EmailHistoryRow);
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.client.from("email_history").delete().eq("id", id);
    if (error) throw error;
  }
}
