import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppRole } from "../../domain/accessControl.ts";
import { createSupabaseServerClient } from "../db/supabase.server.ts";
import { AuthSchemaNotMigratedError, rowToAuthUser, type AuthUser } from "./authStore.server.ts";

/**
 * Správa uživatelů (V1-AUTH-01) — rows of app_users and project_members. Only called by the admin
 * API after `users.manage` was checked. The last-active-admin rule is enforced by the database
 * trigger app_users_keep_last_admin (serialized, so concurrent requests cannot both pass).
 */
export type AdminUserRecord = AuthUser & Readonly<{ createdAt: string; updatedAt: string; deactivatedAt: string | null; projectIds: readonly string[] }>;
export type AssignableProject = Readonly<{ id: string; name: string; eventId: string | null; boothNumber: string; updatedAt: string }>;

export class LastActiveAdminError extends Error {
  constructor() {
    super("Poslední aktivní správce nemůže být deaktivován ani převeden na jinou roli. Nejdřív jmenujte jiného správce.");
    this.name = "LastActiveAdminError";
  }
}
export class UserConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserConflictError";
  }
}

export interface UsersAdminStore {
  list(): Promise<readonly AdminUserRecord[]>;
  get(userId: string): Promise<AdminUserRecord | undefined>;
  insert(input: Readonly<{ id: string; email: string; displayName: string | null; role: AppRole; createdBy: string }>): Promise<AdminUserRecord>;
  update(userId: string, patch: Readonly<{ role?: AppRole; isActive?: boolean; displayName?: string | null }>, expectedUpdatedAt: string): Promise<AdminUserRecord>;
  setProjects(userId: string, projectIds: readonly string[], actorId: string): Promise<readonly string[]>;
  assignableProjects(): Promise<readonly AssignableProject[]>;
}

type Row = { id: string; email: string; display_name: string | null; role: string; is_active: boolean; created_at: string; updated_at: string; deactivated_at: string | null };
const COLUMNS = "id, email, display_name, role, is_active, created_at, updated_at, deactivated_at";
const isMissingSchema = (error: unknown) => ["42P01", "PGRST205", "PGRST200", "42703"].includes((error as { code?: string } | null)?.code ?? "");

export class SupabaseUsersAdminStore implements UsersAdminStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  private fail(error: unknown): never {
    if (isMissingSchema(error)) throw new AuthSchemaNotMigratedError();
    const message = String((error as { message?: string } | null)?.message ?? "");
    if (message.includes("LAST_ACTIVE_ADMIN")) throw new LastActiveAdminError();
    if ((error as { code?: string } | null)?.code === "23505") throw new UserConflictError("Uživatel s tímto e-mailem už existuje.");
    throw error;
  }

  private toRecord(row: Row, projectIds: readonly string[]): AdminUserRecord {
    const user = rowToAuthUser(row);
    if (!user) throw new Error(`app_users ${row.id}: neznámá role ${row.role}`);
    return { ...user, createdAt: row.created_at, updatedAt: row.updated_at, deactivatedAt: row.deactivated_at, projectIds };
  }

  async list() {
    const [{ data, error }, { data: members, error: membersError }] = await Promise.all([
      this.client.from("app_users").select(COLUMNS).order("email"),
      this.client.from("project_members").select("project_id, user_id"),
    ]);
    if (error) this.fail(error);
    if (membersError) this.fail(membersError);
    const byUser = new Map<string, string[]>();
    for (const member of (members ?? []) as { project_id: string; user_id: string }[]) byUser.set(member.user_id, [...(byUser.get(member.user_id) ?? []), member.project_id]);
    return ((data ?? []) as Row[]).map((row) => this.toRecord(row, byUser.get(row.id) ?? []));
  }

  async get(userId: string) {
    const { data, error } = await this.client.from("app_users").select(COLUMNS).eq("id", userId).maybeSingle();
    if (error) this.fail(error);
    if (!data) return undefined;
    const { data: members, error: membersError } = await this.client.from("project_members").select("project_id").eq("user_id", userId);
    if (membersError) this.fail(membersError);
    return this.toRecord(data as Row, ((members ?? []) as { project_id: string }[]).map((member) => member.project_id));
  }

  async insert(input: Readonly<{ id: string; email: string; displayName: string | null; role: AppRole; createdBy: string }>) {
    const { data, error } = await this.client.from("app_users").insert({ id: input.id, email: input.email, display_name: input.displayName, role: input.role, created_by: input.createdBy }).select(COLUMNS).single();
    if (error) this.fail(error);
    return this.toRecord(data as Row, []);
  }

  async update(userId: string, patch: Readonly<{ role?: AppRole; isActive?: boolean; displayName?: string | null }>, expectedUpdatedAt: string) {
    const row: Record<string, unknown> = {};
    if (patch.role !== undefined) row.role = patch.role;
    if (patch.isActive !== undefined) row.is_active = patch.isActive;
    if (patch.displayName !== undefined) row.display_name = patch.displayName;
    const { data, error } = await this.client.from("app_users").update(row).eq("id", userId).eq("updated_at", expectedUpdatedAt).select(COLUMNS);
    if (error) this.fail(error);
    if (!data || data.length === 0) throw new UserConflictError("Účet byl mezitím změněn jinde. Obnovte seznam a zkuste to znovu.");
    return (await this.get(userId))!;
  }

  async setProjects(userId: string, projectIds: readonly string[], actorId: string) {
    const wanted = [...new Set(projectIds)];
    if (wanted.length) {
      const { data, error } = await this.client.from("projects").select("id").in("id", wanted);
      if (error) this.fail(error);
      const known = new Set(((data ?? []) as { id: string }[]).map((row) => row.id));
      const missing = wanted.filter((id) => !known.has(id));
      if (missing.length) throw new UserConflictError(`Projekt ${missing.join(", ")} neexistuje.`);
    }
    const { data: current, error } = await this.client.from("project_members").select("project_id").eq("user_id", userId);
    if (error) this.fail(error);
    const have = new Set(((current ?? []) as { project_id: string }[]).map((row) => row.project_id));
    const remove = [...have].filter((id) => !wanted.includes(id));
    const add = wanted.filter((id) => !have.has(id));
    if (remove.length) {
      const { error: removeError } = await this.client.from("project_members").delete().eq("user_id", userId).in("project_id", remove);
      if (removeError) this.fail(removeError);
    }
    if (add.length) {
      const { error: addError } = await this.client.from("project_members").insert(add.map((projectId) => ({ project_id: projectId, user_id: userId, created_by: actorId })));
      if (addError) this.fail(addError);
    }
    return wanted.sort();
  }

  async assignableProjects() {
    const { data, error } = await this.client.from("projects").select("id, event_id, updated_at, document").order("updated_at", { ascending: false });
    if (error) this.fail(error);
    return ((data ?? []) as { id: string; event_id: string | null; updated_at: string; document: { name?: string; boothNumber?: string } | null }[]).map((row) => ({ id: row.id, name: row.document?.name || row.id, eventId: row.event_id, boothNumber: row.document?.boothNumber ?? "", updatedAt: row.updated_at }));
  }
}

let override: UsersAdminStore | undefined;
export function usersAdminStore(): UsersAdminStore {
  return override ?? new SupabaseUsersAdminStore(createSupabaseServerClient());
}
/** Tests only (in-memory double with the same contract). */
export function setUsersAdminStoreForTesting(store: UsersAdminStore | undefined): void {
  override = store;
}
