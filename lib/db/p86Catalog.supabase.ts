import type { SupabaseClient } from "@supabase/supabase-js";
import { assertScriptDatabaseClient } from "./scriptSupabase.server.ts";
import { DuplicateInternalCodeError } from "../../domain/catalogReadiness.ts";
import { DuplicateAbfCodeError } from "../../domain/catalogItemTypes.ts";
import type { P86CardPlan } from "../../domain/p86CatalogImport.ts";

/**
 * V1-COMPLETE-02 writer: inserts the ONE planned P86 card (domain/p86CatalogImport.ts) — never any
 * other row, never an update. Only for scripts (createScriptSupabaseClient: DEV target checked).
 * The unique indexes on internal_code / abf_code are the last guard against a concurrent duplicate.
 */
export async function applyP86CardPlan(client: SupabaseClient, plan: Extract<P86CardPlan, { action: "create" }>): Promise<string> {
  assertScriptDatabaseClient(client);
  const { data, error } = await client.from("catalog_items").insert(plan.row).select("id").single();
  if (error) {
    if ((error as { code?: string }).code === "23505") {
      const message = (error as { message?: string }).message ?? "";
      throw message.includes("abf_code") ? new DuplicateAbfCodeError("P86") : new DuplicateInternalCodeError("P86");
    }
    throw error;
  }
  return (data as { id: string }).id;
}
