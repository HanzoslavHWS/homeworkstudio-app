import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  PrintSurfaceProductionDimension,
  PrintSurfaceProductionDimensionRepository,
} from "../../domain/printSurfaceProductionDimension.ts";

type PrintSurfaceProductionDimensionRow = Readonly<{
  realization_company_id: string;
  preset_id: string;
  status: string;
  width_mm: number | null;
  height_mm: number | null;
  note: string | null;
}>;

function rowToDimension(row: PrintSurfaceProductionDimensionRow): PrintSurfaceProductionDimension {
  if (row.status === "unavailable") {
    return { realizationCompanyId: row.realization_company_id, presetId: row.preset_id, status: "unavailable", note: row.note ?? undefined };
  }
  return {
    realizationCompanyId: row.realization_company_id,
    presetId: row.preset_id,
    status: "available",
    widthMm: row.width_mm as number,
    heightMm: row.height_mm as number,
    note: row.note ?? undefined,
  };
}

export class SupabasePrintSurfaceProductionDimensionRepository implements PrintSurfaceProductionDimensionRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(): Promise<readonly PrintSurfaceProductionDimension[]> {
    const { data, error } = await this.client.from("print_surface_production_dimensions").select("*");
    if (error) throw error;
    return ((data ?? []) as PrintSurfaceProductionDimensionRow[]).map(rowToDimension);
  }

  /** Full atomic replace — how a fresh Excel import applies its result. */
  async replaceAll(dimensions: readonly PrintSurfaceProductionDimension[]): Promise<void> {
    const { error: deleteError } = await this.client.from("print_surface_production_dimensions").delete().not("preset_id", "is", null);
    if (deleteError) throw deleteError;
    if (dimensions.length === 0) return;

    const { error: insertError } = await this.client.from("print_surface_production_dimensions").insert(
      dimensions.map((dimension) => ({
        realization_company_id: dimension.realizationCompanyId,
        preset_id: dimension.presetId,
        status: dimension.status,
        width_mm: dimension.status === "available" ? dimension.widthMm : null,
        height_mm: dimension.status === "available" ? dimension.heightMm : null,
        note: dimension.note ?? null,
      })),
    );
    if (insertError) throw insertError;
  }
}
