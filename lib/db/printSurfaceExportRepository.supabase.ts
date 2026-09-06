import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PrintSurfaceExportCreateInput,
  PrintSurfaceExportRecord,
  PrintSurfaceExportRepository,
  PrintSurfaceExportType,
} from "../../domain/printSurfaceExport.ts";

type PrintSurfaceExportRow = Readonly<{
  id: string;
  project_id: string;
  export_type: string;
  created_by: string | null;
  created_at: string;
  sent_at: string | null;
  sent_by: string | null;
  recipient: string | null;
  language: string | null;
  file_storage_key: string | null;
}>;

function rowToExport(row: PrintSurfaceExportRow): PrintSurfaceExportRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    exportType: row.export_type as PrintSurfaceExportType,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
    sentBy: row.sent_by ?? undefined,
    recipient: row.recipient ?? undefined,
    language: row.language ?? undefined,
    fileStorageKey: row.file_storage_key ?? undefined,
  };
}

export class SupabasePrintSurfaceExportRepository implements PrintSurfaceExportRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(projectId: string): Promise<readonly PrintSurfaceExportRecord[]> {
    const { data, error } = await this.client
      .from("print_surface_exports")
      .select("*")
      .eq("project_id", projectId)
      .order("created_at", { ascending: false });
    if (error) throw error;
    return ((data ?? []) as PrintSurfaceExportRow[]).map(rowToExport);
  }

  async create(input: PrintSurfaceExportCreateInput): Promise<PrintSurfaceExportRecord> {
    const { data, error } = await this.client
      .from("print_surface_exports")
      .insert({ project_id: input.projectId, export_type: input.exportType, created_by: input.createdBy ?? null })
      .select()
      .single();
    if (error) throw error;
    return rowToExport(data as PrintSurfaceExportRow);
  }
}
