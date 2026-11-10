import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseServerClient } from "../db/supabase.server.ts";
import { AuthSchemaNotMigratedError, rowToAuthUser, type AuthUser } from "./authStore.server.ts";

/**
 * ABF → Administrace → Uživatelé a přiřazení (V1-AUTH-01, narrowed by V1-AUTH-02): the accounts that
 * are members of ABF, with their ABF role and state (read-only here) and their project assignments.
 * Accounts, access and roles are managed in the shared HomeworkStudio administration
 * (lib/accounts). Only called by the ABF API after `users.manage` was checked.
 */
export type AdminUserRecord = AuthUser & Readonly<{ createdAt: string; updatedAt: string; deactivatedAt: string | null; projectIds: readonly string[] }>;
export type AssignableProject = Readonly<{ id: string; name: string; eventId: string | null; boothNumber: string; updatedAt: string }>;

export class UserConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserConflictError";
  }
}

export interface UsersAdminStore {
  /** ABF members only (every ABF role, active and deactivated). */
  list(): Promise<readonly AdminUserRecord[]>;
  get(userId: string): Promise<AdminUserRecord | undefined>;
  setProjects(userId: string, projectIds: readonly string[], actorId: string): Promise<readonly string[]>;
  assignableProjects(): Promise<readonly AssignableProject[]>;
}

type Row = { id: string; email: string; display_name: string | null; is_active: boolean; is_hws_admin: boolean; created_at: string; updated_at: string; deactivated_at: string | null; app_memberships?: { app_key: string; role: string }[] | null };
const COLUMNS = "id, email, display_name, is_active, is_hws_admin, created_at, updated_at, deactivated_at, app_memberships!app_memberships_user_id_fkey (app_key, role)";
const isMissingSchema = (error: unknown) => ["42P01", "PGRST205", "PGRST200", "42703"].includes((error as { code?: string } | null)?.code ?? "");

export class SupabaseUsersAdminStore implements UsersAdminStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  private fail(error: unknown): never {
    if (isMissingSchema(error)) throw new AuthSchemaNotMigratedError();
    throw error;
  }

  private toRecord(row: Row, projectIds: readonly string[]): AdminUserRecord {
    return { ...rowToAuthUser(row), createdAt: row.created_at, updatedAt: row.updated_at, deactivatedAt: row.deactivated_at, projectIds };
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
    return ((data ?? []) as Row[]).map((row) => this.toRecord(row, byUser.get(row.id) ?? [])).filter((user) => user.role !== undefined);
  }

  async get(userId: string) {
    const { data, error } = await this.client.from("app_users").select(COLUMNS).eq("id", userId).maybeSingle();
    if (error) this.fail(error);
    if (!data) return undefined;
    const { data: members, error: membersError } = await this.client.from("project_members").select("project_id").eq("user_id", userId);
    if (membersError) this.fail(membersError);
    return this.toRecord(data as Row, ((members ?? []) as { project_id: string }[]).map((member) => member.project_id));
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
