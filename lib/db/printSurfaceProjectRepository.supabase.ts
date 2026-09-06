import type { SupabaseClient } from "@supabase/supabase-js";
import {
  migrateLegacyPrintSurfaceDocument,
  type MarkerPlacement,
  type PrintSurfaceItem,
  type PrintSurfaceProject,
  type PrintSurfaceProjectCreateInput,
  type PrintSurfaceProjectImage,
  type PrintSurfaceProjectRepository,
  type PrintSurfaceProjectStatus,
  type PrintSurfaceProjectSummary,
  type PrintSurfaceView,
} from "../../domain/printSurfaceProject.ts";

type PrintSurfaceProjectRow = Readonly<{
  id: string;
  name: string;
  company_name: string;
  event_id: string | null;
  realization_company_id: string | null;
  status: string;
  created_by: string | null;
  sent_at: string | null;
  sent_by: string | null;
  document: unknown;
  created_at: string;
  updated_at: string;
}>;

/** Everything NOT already an indexed column above — see the migration's own comment on print_surface_projects.document. `image` is the pre-V3 shape; pre-V4 `items` may still embed position/imageId — both are readable via migrateLegacyPrintSurfaceDocument. */
type PrintSurfaceProjectDocument = Readonly<{
  views?: readonly PrintSurfaceView[];
  image?: PrintSurfaceProjectImage;
  items?: readonly unknown[];
  placements?: readonly MarkerPlacement[];
}>;

function rowToProject(row: PrintSurfaceProjectRow): PrintSurfaceProject {
  const document = (row.document ?? {}) as PrintSurfaceProjectDocument;
  const { views, items, placements } = migrateLegacyPrintSurfaceDocument(document);
  return {
    id: row.id,
    name: row.name,
    companyName: row.company_name,
    eventId: row.event_id ?? undefined,
    realizationCompanyId: row.realization_company_id ?? undefined,
    views,
    items,
    placements,
    status: row.status as PrintSurfaceProjectStatus,
    createdBy: row.created_by ?? undefined,
    sentAt: row.sent_at ?? undefined,
    sentBy: row.sent_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSummary(row: PrintSurfaceProjectRow): PrintSurfaceProjectSummary {
  const document = (row.document ?? {}) as PrintSurfaceProjectDocument;
  const itemCount = migrateLegacyPrintSurfaceDocument(document).items.length;
  return {
    id: row.id,
    name: row.name,
    companyName: row.company_name,
    eventId: row.event_id ?? undefined,
    realizationCompanyId: row.realization_company_id ?? undefined,
    status: row.status as PrintSurfaceProjectStatus,
    itemCount,
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function projectToRow(project: PrintSurfaceProject) {
  const document: PrintSurfaceProjectDocument = { views: project.views, items: project.items as readonly PrintSurfaceItem[], placements: project.placements };
  return {
    name: project.name,
    company_name: project.companyName,
    event_id: project.eventId ?? null,
    realization_company_id: project.realizationCompanyId ?? null,
    status: project.status,
    created_by: project.createdBy ?? null,
    sent_at: project.sentAt ?? null,
    sent_by: project.sentBy ?? null,
    document,
  };
}

export class SupabasePrintSurfaceProjectRepository implements PrintSurfaceProjectRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(): Promise<readonly PrintSurfaceProjectSummary[]> {
    const { data, error } = await this.client.from("print_surface_projects").select("*").order("updated_at", { ascending: false });
    if (error) throw error;
    return ((data ?? []) as PrintSurfaceProjectRow[]).map(rowToSummary);
  }

  async get(id: string): Promise<PrintSurfaceProject | undefined> {
    const { data, error } = await this.client.from("print_surface_projects").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? rowToProject(data as PrintSurfaceProjectRow) : undefined;
  }

  async create(input: PrintSurfaceProjectCreateInput): Promise<PrintSurfaceProject> {
    const { data, error } = await this.client
      .from("print_surface_projects")
      .insert({
        name: input.name,
        company_name: input.companyName,
        event_id: input.eventId ?? null,
        realization_company_id: input.realizationCompanyId ?? null,
        status: "draft",
        created_by: input.createdBy ?? null,
        document: { views: [], items: [], placements: [] } satisfies PrintSurfaceProjectDocument,
      })
      .select()
      .single();
    if (error) throw error;
    return rowToProject(data as PrintSurfaceProjectRow);
  }

  async save(project: PrintSurfaceProject): Promise<PrintSurfaceProject> {
    const { data, error } = await this.client
      .from("print_surface_projects")
      .update(projectToRow(project))
      .eq("id", project.id)
      .select()
      .single();
    if (error) throw error;
    return rowToProject(data as PrintSurfaceProjectRow);
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.client.from("print_surface_projects").delete().eq("id", id);
    if (error) throw error;
  }
}
