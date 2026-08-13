import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeExhibition, type Exhibition } from "../../domain/organizations.ts";
import type { PersistedExhibition, RemoteEventRepository } from "../../domain/remotePersistence.ts";
import { ConcurrencyConflictError } from "./concurrency.ts";

export type { PersistedExhibition, RemoteEventRepository } from "../../domain/remotePersistence.ts";

type EventRow = Readonly<{
  id: string;
  source_key: string;
  name: string;
  year: number;
  active: boolean;
  start_date: string | null;
  end_date: string | null;
  document: unknown;
  revision: number;
  created_at: string;
  updated_at: string;
}>;

function rowToEvent(row: EventRow): PersistedExhibition {
  const event = normalizeExhibition(row.document as Partial<Exhibition> & Pick<Exhibition, "id">);
  return { ...event, revision: row.revision };
}

function eventToRow(event: Exhibition): Readonly<{
  id: string;
  source_key: string;
  name: string;
  year: number;
  active: boolean;
  start_date: string | null;
  end_date: string | null;
  document: Exhibition;
}> {
  return {
    id: event.id,
    source_key: event.slug,
    name: event.name,
    year: event.year,
    active: event.active,
    start_date: event.eventFrom ?? null,
    end_date: event.eventTo ?? null,
    document: event,
  };
}

export class SupabaseEventRepository implements RemoteEventRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(): Promise<readonly Exhibition[]> {
    const { data, error } = await this.client.from("events").select("*").order("start_date", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as EventRow[]).map(rowToEvent);
  }

  async getWithRevision(id: string): Promise<PersistedExhibition | undefined> {
    const { data, error } = await this.client.from("events").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? rowToEvent(data as EventRow) : undefined;
  }

  /** Convenience path matching the plain EventRepository contract; prefer saveWithRevision when the caller already holds a known revision. */
  async save(event: Exhibition): Promise<Exhibition> {
    const existing = await this.getWithRevision(event.id);
    return this.saveWithRevision(event, existing?.revision ?? null);
  }

  async saveWithRevision(event: Exhibition, expectedRevision: number | null): Promise<PersistedExhibition> {
    const normalized = normalizeExhibition(event);
    const row = eventToRow(normalized);
    if (expectedRevision === null) {
      const { data, error } = await this.client.from("events").insert({ ...row, revision: 1 }).select().single();
      if (error) throw error;
      return rowToEvent(data as EventRow);
    }
    const { data, error } = await this.client
      .from("events")
      .update({ ...row, revision: expectedRevision + 1, updated_at: new Date().toISOString() })
      .eq("id", normalized.id)
      .eq("revision", expectedRevision)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) throw new ConcurrencyConflictError("event", normalized.id);
    return rowToEvent(data[0] as EventRow);
  }
}
