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
}
