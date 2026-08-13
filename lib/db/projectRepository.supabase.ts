import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeProjectRecord, type ProjectRecord } from "../../domain/project.ts";
import type { PersistedProjectRecord, RemoteProjectRepository } from "../../domain/remotePersistence.ts";
import { ConcurrencyConflictError } from "./concurrency.ts";

export type { PersistedProjectRecord, RemoteProjectRepository } from "../../domain/remotePersistence.ts";

type ProjectRow = Readonly<{
  id: string;
  schema_version: number;
  event_id: string | null;
  company_name: string | null;
  lifecycle_status: string;
  document: unknown;
  revision: number;
  created_at: string;
  updated_at: string;
}>;

function rowToProject(row: ProjectRow): PersistedProjectRecord {
  const project = normalizeProjectRecord(row.document as Partial<ProjectRecord> & Pick<ProjectRecord, "id">);
  return { ...project, revision: row.revision };
}

function projectToRow(project: ProjectRecord): Readonly<{
  id: string;
  schema_version: number;
  event_id: string | null;
  company_name: string | null;
  lifecycle_status: string;
  document: ProjectRecord;
}> {
  return {
    id: project.id,
    schema_version: project.schemaVersion,
    event_id: project.fairId || null,
    company_name: project.company || null,
    lifecycle_status: project.status,
    document: project,
  };
}

export class SupabaseProjectRepository implements RemoteProjectRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(): Promise<readonly ProjectRecord[]> {
    const { data, error } = await this.client.from("projects").select("*").order("updated_at", { ascending: false });
    if (error) throw error;
    return ((data ?? []) as ProjectRow[]).map(rowToProject);
  }

  async get(id: string): Promise<ProjectRecord | undefined> {
    return this.getWithRevision(id);
  }

  async getWithRevision(id: string): Promise<PersistedProjectRecord | undefined> {
    const { data, error } = await this.client.from("projects").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? rowToProject(data as ProjectRow) : undefined;
  }

  /** Convenience path matching the plain ProjectRepository contract. Prefer saveWithRevision when the caller already holds a known revision — this reads-then-writes and is not itself race-free. */
  async save(project: ProjectRecord): Promise<ProjectRecord> {
    const existing = await this.getWithRevision(project.id);
    return this.saveWithRevision(project, existing?.revision ?? null);
  }

  async saveWithRevision(project: ProjectRecord, expectedRevision: number | null): Promise<PersistedProjectRecord> {
    const row = projectToRow(project);
    if (expectedRevision === null) {
      const { data, error } = await this.client.from("projects").insert({ ...row, revision: 1 }).select().single();
      if (error) throw error;
      return rowToProject(data as ProjectRow);
    }
    const { data, error } = await this.client
      .from("projects")
      .update({ ...row, revision: expectedRevision + 1, updated_at: new Date().toISOString() })
      .eq("id", project.id)
      .eq("revision", expectedRevision)
      .select();
    if (error) throw error;
    if (!data || data.length === 0) throw new ConcurrencyConflictError("project", project.id);
    return rowToProject(data[0] as ProjectRow);
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.client.from("projects").delete().eq("id", id);
    if (error) throw error;
  }
}
