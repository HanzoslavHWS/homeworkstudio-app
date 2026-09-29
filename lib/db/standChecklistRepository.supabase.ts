import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  ChecklistTemplateItem,
  StandChecklistEntry,
  StandChecklistRepository,
  StandChecklistTemplate,
  StandKey,
} from "../../domain/standChecklist.ts";

type TemplateRow = Readonly<{ id: string; name: string; event_id: string | null; is_default: boolean; items: unknown }>;
type EntryRow = Readonly<{ event_id: string; stand_number: string; item_key: string; is_done: boolean; done_at: string | null; done_by: string | null }>;

function rowToTemplate(row: TemplateRow): StandChecklistTemplate {
  const items = Array.isArray(row.items) ? (row.items as ChecklistTemplateItem[]).filter((item) => item && typeof item.key === "string" && typeof item.label === "string") : [];
  return { id: row.id, name: row.name, eventId: row.event_id ?? undefined, isDefault: row.is_default, items };
}

function rowToEntry(row: EntryRow): StandChecklistEntry {
  return { eventId: row.event_id, standNumber: row.stand_number, itemKey: row.item_key, isDone: row.is_done, doneAt: row.done_at ?? undefined, doneBy: row.done_by ?? undefined };
}

export class SupabaseStandChecklistRepository implements StandChecklistRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async listTemplates(): Promise<readonly StandChecklistTemplate[]> {
    const { data, error } = await this.client.from("stand_checklist_templates").select("*");
    if (error) throw error;
    return ((data ?? []) as TemplateRow[]).map(rowToTemplate);
  }

  async listEntries(stand: StandKey): Promise<readonly StandChecklistEntry[]> {
    const { data, error } = await this.client.from("stand_checklist_entries").select("*").eq("event_id", stand.eventId).eq("stand_number", stand.standNumber);
    if (error) throw error;
    return ((data ?? []) as EntryRow[]).map(rowToEntry);
  }

  async setEntry(stand: StandKey, itemKey: string, isDone: boolean, doneBy?: string): Promise<StandChecklistEntry> {
    const { data, error } = await this.client
      .from("stand_checklist_entries")
      .upsert(
        {
          event_id: stand.eventId,
          stand_number: stand.standNumber,
          item_key: itemKey,
          is_done: isDone,
          done_at: isDone ? new Date().toISOString() : null,
          done_by: isDone ? doneBy ?? null : null,
        },
        { onConflict: "event_id,stand_number,item_key" },
      )
      .select()
      .single();
    if (error) throw error;
    return rowToEntry(data as EntryRow);
  }
}
