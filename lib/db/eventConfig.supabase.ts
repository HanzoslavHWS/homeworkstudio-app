import type { SupabaseClient } from "@supabase/supabase-js";
import type { EventPathMapping, EventPathRole, EventRealizationLink, RealizationCompanyOption } from "../../domain/eventAdmin.ts";

/** Active links are one list per event, stored with this role (migration 20261022160000). */
const LIST_ROLE = "construction";
import { isMissingSchemaError } from "./realizationCompanyRepository.supabase.ts";

/**
 * Server-only access to the event configuration sections of V1-DATA-06 (migration
 * 20261022150000_events_admin.sql, 20261022160000): one list of realization firms and folder paths. Both sections share
 * events.config_revision for optimistic concurrency; the card document keeps events.revision.
 */

export class EventConfigNotMigratedError extends Error {
  constructor() {
    super("Databáze ještě nemá nastavení veletrhů. Aplikujte supabase/migrations/20261022150000_events_admin.sql.");
    this.name = "EventConfigNotMigratedError";
  }
}

/** Somebody changed the event configuration since it was loaded (SQLSTATE P0409). Nothing was written. */
export class EventConfigConflictError extends Error {
  readonly currentRevision?: number;
  constructor(message: string, currentRevision?: number) {
    super(message);
    this.name = "EventConfigConflictError";
    if (currentRevision !== undefined) this.currentRevision = currentRevision;
  }
}

function check<T>(result: { data: T | null; error: unknown }): T {
  if (result.error) {
    if (isMissingSchemaError(result.error)) throw new EventConfigNotMigratedError();
    const error = result.error as { code?: string; message?: string; details?: string };
    if (error.code === "P0409") {
      const match = /current_revision=(\d+)/u.exec(error.details ?? "");
      throw new EventConfigConflictError(error.message ?? "Nastavení veletrhu mezitím změnil někdo jiný.", match ? Number(match[1]) : undefined);
    }
    throw result.error;
  }
  return result.data as T;
}

export type EventConfig = Readonly<{
  eventId: string;
  configRevision: number;
  realizationLinks: readonly EventRealizationLink[];
  pathMappings: readonly EventPathMapping[];
}>;

export type EventConfigRepository = Readonly<{
  /** Undefined when the event is not stored yet. */
  load(eventId: string): Promise<EventConfig | undefined>;
  listCompanies(): Promise<readonly RealizationCompanyOption[]>;
  saveRealizationLinks(eventId: string, expectedConfigRevision: number, links: readonly EventRealizationLink[]): Promise<number>;
  savePathMappings(eventId: string, expectedConfigRevision: number, paths: readonly EventPathMapping[]): Promise<number>;
}>;

type Row = Record<string, unknown>;

export function createSupabaseEventConfigRepository(client: SupabaseClient): EventConfigRepository {
  return {
    async load(eventId) {
      const events = check(await client.from("events").select("id, config_revision").eq("id", eventId).limit(1)) as Row[];
      if (!events.length) return undefined;
      const [links, paths] = await Promise.all([
        client.from("event_realization_companies").select("realization_company_id, is_default, note").eq("event_id", eventId).eq("is_active", true).eq("role", LIST_ROLE).order("realization_company_id"),
        client.from("event_path_mappings").select("role, configured_path, note").eq("event_id", eventId),
      ]);
      return {
        eventId,
        configRevision: Number(events[0]!.config_revision ?? 1),
        realizationLinks: (check(links) as Row[]).map((row) => ({
          realizationCompanyId: row.realization_company_id as string,
          isDefault: row.is_default === true,
          ...(typeof row.note === "string" && row.note ? { note: row.note } : {}),
        })),
        pathMappings: (check(paths) as Row[]).map((row) => ({
          role: row.role as EventPathRole,
          path: row.configured_path as string,
          ...(typeof row.note === "string" && row.note ? { note: row.note } : {}),
        })),
      };
    },
    async listCompanies() {
      const rows = check(await client.from("print_surface_realization_companies").select("id, name, is_active").order("name")) as Row[];
      return rows.map((row) => ({ id: row.id as string, name: row.name as string, isActive: row.is_active !== false }));
    },
    async saveRealizationLinks(eventId, expectedConfigRevision, links) {
      return Number(
        check(
          await client.rpc("save_event_realization_companies", {
            p_event_id: eventId,
            p_expected_config_revision: expectedConfigRevision,
            p_links: links.map((link) => ({ realization_company_id: link.realizationCompanyId, role: LIST_ROLE, is_default: link.isDefault, note: link.note ?? null })),
          }),
        ),
      );
    },
    async savePathMappings(eventId, expectedConfigRevision, paths) {
      return Number(
        check(
          await client.rpc("save_event_path_mappings", {
            p_event_id: eventId,
            p_expected_config_revision: expectedConfigRevision,
            p_paths: paths.map((path) => ({ role: path.role, configured_path: path.path, note: path.note ?? null })),
          }),
        ),
      );
    },
  };
}
