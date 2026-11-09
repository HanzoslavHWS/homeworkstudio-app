import type { SupabaseClient } from "@supabase/supabase-js";
import type { CatalogImportRowOutcome } from "../db/catalogExcelImport.supabase.ts";

/**
 * Evidence of catalog-template imports run from the admin UI (V1-IMPORT-UI-01) — rows of the
 * existing import_batches table with kind = 'catalog-template' (migration 20261109120000).
 * The file content is never stored: only its name, size and SHA-256, the hash of the plan, the
 * author, the environment and the per-row outcome.
 */
export const CATALOG_TEMPLATE_KIND = "catalog-template";

export type CatalogImportRunStatus = "previewed" | "no_changes" | "superseded" | "running" | "succeeded" | "partial" | "failed" | "interrupted";
export type CatalogImportRun = Readonly<{
  id: string;
  status: CatalogImportRunStatus;
  createdBy: string | null;
  createdAt: string;
  environment: string | null;
  fileName: string;
  fileSha256: string | null;
  fileSize: number | null;
  planHash: string | null;
  previewExpiresAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  summary: unknown;
  resultRows: readonly CatalogImportRowOutcome[] | null;
  errorMessage: string | null;
}>;

export type NewPreviewRun = Readonly<{ status: "previewed" | "no_changes"; createdBy: string; environment: string; fileName: string; fileSha256: string; fileSize: number; planHash: string; previewExpiresAt: string; summary: unknown }>;

export class CatalogImportRunsNotMigratedError extends Error {
  constructor() {
    super("Databáze nemá evidenci importů z administrace (migrace 20261109120000_import_batches_catalog_template_runs).");
    this.name = "CatalogImportRunsNotMigratedError";
  }
}

export interface CatalogImportRunStore {
  createPreview(input: NewPreviewRun): Promise<CatalogImportRun>;
  get(id: string): Promise<CatalogImportRun | undefined>;
  listRecent(limit: number): Promise<readonly CatalogImportRun[]>;
  /** previewed → superseded (the plan changed); no-op otherwise. */
  markSuperseded(id: string): Promise<void>;
  /** running for longer than `olderThan` (a crashed / killed server) → interrupted. */
  expireStaleRunning(olderThan: string): Promise<void>;
  /**
   * previewed → running in ONE conditional update (id + author + still previewed + not expired).
   * "already" = the row is no longer previewed (double click, repeated request, second tab);
   * "busy" = another catalog-template import is running (unique index).
   */
  claim(id: string, userId: string, now: string): Promise<CatalogImportRun | "already" | "busy">;
  saveProgress(id: string, rows: readonly CatalogImportRowOutcome[]): Promise<void>;
  finish(id: string, status: "succeeded" | "partial" | "failed", rows: readonly CatalogImportRowOutcome[], errorMessage: string | null): Promise<void>;
}

type Row = { id: string; status: string; created_by: string | null; created_at: string; environment: string | null; source_file_name: string; file_sha256: string | null; file_size: number | null; plan_hash: string | null; preview_expires_at: string | null; started_at: string | null; finished_at: string | null; summary: unknown; result_rows: CatalogImportRowOutcome[] | null; error_message: string | null };
const COLUMNS = "id, status, created_by, created_at, environment, source_file_name, file_sha256, file_size, plan_hash, preview_expires_at, started_at, finished_at, summary, result_rows, error_message";
const toRun = (row: Row): CatalogImportRun => ({
  id: row.id,
  status: row.status as CatalogImportRunStatus,
  createdBy: row.created_by,
  createdAt: row.created_at,
  environment: row.environment,
  fileName: row.source_file_name,
  fileSha256: row.file_sha256,
  fileSize: row.file_size,
  planHash: row.plan_hash,
  previewExpiresAt: row.preview_expires_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
  summary: row.summary,
  resultRows: row.result_rows,
  errorMessage: row.error_message,
});
const isMissingSchema = (error: unknown) => ["42P01", "PGRST205", "PGRST204", "42703"].includes((error as { code?: string } | null)?.code ?? "");

export class SupabaseCatalogImportRunStore implements CatalogImportRunStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  private fail(error: unknown): never {
    if (isMissingSchema(error)) throw new CatalogImportRunsNotMigratedError();
    throw error;
  }

  async createPreview(input: NewPreviewRun) {
    const { data, error } = await this.client
      .from("import_batches")
      .insert({ kind: CATALOG_TEMPLATE_KIND, status: input.status, created_by: input.createdBy, environment: input.environment, source_file_name: input.fileName, source_fingerprint: input.fileSha256, source_version: "catalog-template/1", file_sha256: input.fileSha256, file_size: input.fileSize, plan_hash: input.planHash, preview_expires_at: input.previewExpiresAt, summary: input.summary })
      .select(COLUMNS)
      .single();
    if (error) this.fail(error);
    return toRun(data as Row);
  }

  async get(id: string) {
    const { data, error } = await this.client.from("import_batches").select(COLUMNS).eq("id", id).eq("kind", CATALOG_TEMPLATE_KIND).maybeSingle();
    if (error) this.fail(error);
    return data ? toRun(data as Row) : undefined;
  }

  async listRecent(limit: number) {
    const { data, error } = await this.client.from("import_batches").select(COLUMNS).eq("kind", CATALOG_TEMPLATE_KIND).neq("status", "superseded").order("created_at", { ascending: false }).limit(limit);
    if (error) this.fail(error);
    return ((data ?? []) as Row[]).map(toRun);
  }

  async markSuperseded(id: string) {
    const { error } = await this.client.from("import_batches").update({ status: "superseded" }).eq("id", id).eq("status", "previewed");
    if (error) this.fail(error);
  }

  async expireStaleRunning(olderThan: string) {
    const { error } = await this.client.from("import_batches").update({ status: "interrupted", finished_at: new Date().toISOString(), error_message: "Běh se nedokončil (server přerušen). Uložené řádky viz výsledky; ověřte stav novým náhledem." }).eq("kind", CATALOG_TEMPLATE_KIND).eq("status", "running").lt("started_at", olderThan);
    if (error) this.fail(error);
  }

  async claim(id: string, userId: string, now: string) {
    const { data, error } = await this.client.from("import_batches").update({ status: "running", started_at: now }).eq("id", id).eq("kind", CATALOG_TEMPLATE_KIND).eq("status", "previewed").eq("created_by", userId).gt("preview_expires_at", now).select(COLUMNS);
    if (error) {
      if ((error as { code?: string }).code === "23505") return "busy" as const;
      this.fail(error);
    }
    return data && data.length ? toRun((data as Row[])[0]!) : ("already" as const);
  }

  async saveProgress(id: string, rows: readonly CatalogImportRowOutcome[]) {
    const { error } = await this.client.from("import_batches").update({ result_rows: rows }).eq("id", id).eq("status", "running");
    if (error) this.fail(error);
  }

  async finish(id: string, status: "succeeded" | "partial" | "failed", rows: readonly CatalogImportRowOutcome[], errorMessage: string | null) {
    const { error } = await this.client.from("import_batches").update({ status, result_rows: rows, finished_at: new Date().toISOString(), error_message: errorMessage }).eq("id", id).eq("status", "running");
    if (error) this.fail(error);
  }
}
