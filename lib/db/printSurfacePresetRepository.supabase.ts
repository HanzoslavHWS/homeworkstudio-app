import type { SupabaseClient } from "@supabase/supabase-js";
import type { PrintSurfacePreset, PrintSurfacePresetRepository } from "../../domain/printSurfacePreset.ts";
import type { PrintSurfaceTypeId } from "../../domain/printSurfaceTypeCatalog.ts";

type PrintSurfacePresetRow = Readonly<{
  id: string;
  type_id: string;
  name: string;
  description: string | null;
  is_active: boolean;
  parent_id: string | null;
  parent_name: string | null;
}>;

function rowToPreset(row: PrintSurfacePresetRow): PrintSurfacePreset {
  return {
    id: row.id,
    typeId: row.type_id as PrintSurfaceTypeId,
    name: row.name,
    description: row.description ?? undefined,
    isActive: row.is_active,
    parentId: row.parent_id ?? undefined,
    parentName: row.parent_name ?? undefined,
  };
}

export class SupabasePrintSurfacePresetRepository implements PrintSurfacePresetRepository {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list(): Promise<readonly PrintSurfacePreset[]> {
    const { data, error } = await this.client.from("print_surface_presets").select("*").order("name", { ascending: true });
    if (error) throw error;
    return ((data ?? []) as PrintSurfacePresetRow[]).map(rowToPreset);
  }

  /** Full atomic replace — how a fresh Excel import applies its result. parent_id is a soft reference (no FK — the parent Excel row never becomes its own preset row), so a single bulk insert is safe regardless of ordering. */
  async replaceAll(presets: readonly PrintSurfacePreset[]): Promise<void> {
    const { error: deleteError } = await this.client.from("print_surface_presets").delete().not("id", "is", null);
    if (deleteError) throw deleteError;
    if (presets.length === 0) return;

    const { error: insertError } = await this.client.from("print_surface_presets").insert(
      presets.map((preset) => ({
        id: preset.id,
        type_id: preset.typeId,
        name: preset.name,
        description: preset.description ?? null,
        is_active: preset.isActive,
        parent_id: preset.parentId ?? null,
        parent_name: preset.parentName ?? null,
      })),
    );
    if (insertError) throw insertError;
  }
}
