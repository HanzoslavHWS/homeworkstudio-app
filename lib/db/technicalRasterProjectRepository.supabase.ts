import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createDefaultRasterSettings,
  type RasterLayer,
  type RasterSettings,
  type RasterStandLabel,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
  type TechnicalRasterProjectCreateInput,
  type TechnicalRasterProjectRepository,
  type TechnicalRasterProjectSummary,
  type TechnicalStand,
} from "../../domain/technicalRaster.ts";
import type { StoredAsset } from "../../domain/assets.ts";
import { summarizeTechnicalRasterProject } from "../../domain/technicalRaster.ts";

type TechnicalRasterProjectRow = Readonly<{
  id: string;
  name: string;
  event_id: string | null;
  hall: string | null;
  created_by: string | null;
  document: unknown;
  created_at: string;
  updated_at: string;
}>;

/** Everything NOT already an indexed column above — see the migration's own comment on technical_raster_projects.document. */
type TechnicalRasterProjectDocument = Readonly<{
  sourceRasterAsset?: StoredAsset;
  rasterLayers?: readonly RasterLayer[];
  rasterSettings?: RasterSettings;
  rasterStandLabels?: readonly RasterStandLabel[];
  imports?: readonly TechnicalRasterImport[];
  stands?: readonly TechnicalStand[];
}>;

function rowToProject(row: TechnicalRasterProjectRow): TechnicalRasterProject {
  const document = (row.document ?? {}) as TechnicalRasterProjectDocument;
  return {
    id: row.id,
    name: row.name,
    eventId: row.event_id ?? undefined,
    hall: row.hall ?? undefined,
    sourceRasterAsset: document.sourceRasterAsset,
    rasterLayers: document.rasterLayers ?? [],
    rasterSettings: document.rasterSettings ?? createDefaultRasterSettings(),
    rasterStandLabels: document.rasterStandLabels ?? [],
    imports: document.imports ?? [],
    stands: document.stands ?? [],
    createdBy: row.created_by ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToSummary(row: TechnicalRasterProjectRow): TechnicalRasterProjectSummary {
  return summarizeTechnicalRasterProject(rowToProject(row));
}

function projectToRow(project: TechnicalRasterProject) {
  const document: TechnicalRasterProjectDocument = {
    sourceRasterAsset: project.sourceRasterAsset,
    rasterLayers: project.rasterLayers,
    rasterSettings: project.rasterSettings,
    rasterStandLabels: project.rasterStandLabels,
    imports: project.imports,
    stands: project.stands,
  };
  return {
    name: project.name,
    event_id: project.eventId ?? null,
    hall: project.hall ?? null,
    created_by: project.createdBy ?? null,
    document,
  };
}

export class SupabaseTechnicalRasterProjectRepository implements TechnicalRasterProjectRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(): Promise<readonly TechnicalRasterProjectSummary[]> {
    const { data, error } = await this.client.from("technical_raster_projects").select("*").order("updated_at", { ascending: false });
    if (error) throw error;
    return ((data ?? []) as TechnicalRasterProjectRow[]).map(rowToSummary);
  }

  async get(id: string): Promise<TechnicalRasterProject | undefined> {
    const { data, error } = await this.client.from("technical_raster_projects").select("*").eq("id", id).maybeSingle();
    if (error) throw error;
    return data ? rowToProject(data as TechnicalRasterProjectRow) : undefined;
  }

  async create(input: TechnicalRasterProjectCreateInput): Promise<TechnicalRasterProject> {
    const { data, error } = await this.client
      .from("technical_raster_projects")
      .insert({
        name: input.name,
        event_id: input.eventId ?? null,
        hall: input.hall ?? null,
        created_by: input.createdBy ?? null,
        document: { rasterLayers: [], rasterSettings: createDefaultRasterSettings(), rasterStandLabels: [], imports: [], stands: [] } satisfies TechnicalRasterProjectDocument,
      })
      .select()
      .single();
    if (error) throw error;
    return rowToProject(data as TechnicalRasterProjectRow);
  }

  async save(project: TechnicalRasterProject): Promise<TechnicalRasterProject> {
    const { data, error } = await this.client
      .from("technical_raster_projects")
      .update(projectToRow(project))
      .eq("id", project.id)
      .select()
      .single();
    if (error) throw error;
    return rowToProject(data as TechnicalRasterProjectRow);
  }

  async delete(id: string): Promise<void> {
    const { error } = await this.client.from("technical_raster_projects").delete().eq("id", id);
    if (error) throw error;
  }
}
