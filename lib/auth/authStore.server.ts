import type { SupabaseClient } from "@supabase/supabase-js";
import { isAppRole, type AppRole } from "../../domain/accessControl.ts";
import { createSupabaseServerClient } from "../db/supabase.server.ts";

/**
 * Server-side store of the auth state (V1-AUTH-01): app_users (role, active), app_sessions
 * (revocable logins) and project_members (project assignments). Always the service-role server
 * client — every caller has already decided WHAT it may do (lib/auth/requestAuth.ts); this module
 * only reads and writes the rows.
 */
export type AuthUser = Readonly<{ id: string; email: string; displayName: string | null; role: AppRole; isActive: boolean }>;
export type StoredSession = Readonly<{ id: string; userId: string; createdAt: number; expiresAt: number; absoluteExpiresAt: number; revokedAt: number | null }>;

export class AuthSchemaNotMigratedError extends Error {
  constructor() {
    super("Databáze nemá tabulky přihlášení (migrace 20261106120000_app_users_sessions_project_members). Přihlášení je do aplikace migrace vypnuté.");
    this.name = "AuthSchemaNotMigratedError";
  }
}

export interface AuthStore {
  loadSession(sessionId: string): Promise<Readonly<{ session: StoredSession; user: AuthUser }> | undefined>;
  createSession(userId: string, expiresAt: number, absoluteExpiresAt: number): Promise<StoredSession>;
  extendSession(sessionId: string, expiresAt: number): Promise<void>;
  revokeSession(sessionId: string, reason: string): Promise<void>;
  revokeUserSessions(userId: string, reason: string): Promise<void>;
  findUserById(userId: string): Promise<AuthUser | undefined>;
  findUserByEmail(email: string): Promise<AuthUser | undefined>;
  projectExists(projectId: string): Promise<boolean>;
  isProjectMember(userId: string, projectId: string): Promise<boolean>;
  memberProjectIds(userId: string): Promise<ReadonlySet<string>>;
  addProjectMember(projectId: string, userId: string, createdBy: string | null): Promise<void>;
}

type UserRow = { id: string; email: string; display_name: string | null; role: string; is_active: boolean };
type SessionRow = { id: string; user_id: string; created_at: string; expires_at: string; absolute_expires_at: string; revoked_at: string | null };

const isMissingSchema = (error: unknown) => {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205" || code === "PGRST200" || code === "42703";
};

export function rowToAuthUser(row: UserRow): AuthUser | undefined {
  if (!isAppRole(row.role)) return undefined;
  return { id: row.id, email: row.email, displayName: row.display_name, role: row.role, isActive: row.is_active === true };
}

const rowToSession = (row: SessionRow): StoredSession => ({
  id: row.id,
  userId: row.user_id,
  createdAt: Date.parse(row.created_at),
  expiresAt: Date.parse(row.expires_at),
  absoluteExpiresAt: Date.parse(row.absolute_expires_at),
  revokedAt: row.revoked_at ? Date.parse(row.revoked_at) : null,
});

const USER_COLUMNS = "id, email, display_name, role, is_active";

export class SupabaseAuthStore implements AuthStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  private check(error: unknown): void {
    if (!error) return;
    if (isMissingSchema(error)) throw new AuthSchemaNotMigratedError();
    throw error;
  }

  async loadSession(sessionId: string) {
    const { data, error } = await this.client.from("app_sessions").select(`id, user_id, created_at, expires_at, absolute_expires_at, revoked_at, app_users (${USER_COLUMNS})`).eq("id", sessionId).maybeSingle();
    this.check(error);
    if (!data) return undefined;
    const row = data as unknown as SessionRow & { app_users: UserRow | null };
    const user = row.app_users ? rowToAuthUser(row.app_users) : undefined;
    return user ? { session: rowToSession(row), user } : undefined;
  }

  async createSession(userId: string, expiresAt: number, absoluteExpiresAt: number) {
    const { data, error } = await this.client.from("app_sessions").insert({ user_id: userId, expires_at: new Date(expiresAt).toISOString(), absolute_expires_at: new Date(absoluteExpiresAt).toISOString() }).select("id, user_id, created_at, expires_at, absolute_expires_at, revoked_at").single();
    this.check(error);
    return rowToSession(data as SessionRow);
  }

  async extendSession(sessionId: string, expiresAt: number) {
    const { error } = await this.client.from("app_sessions").update({ expires_at: new Date(expiresAt).toISOString(), last_seen_at: new Date().toISOString() }).eq("id", sessionId).is("revoked_at", null);
    this.check(error);
  }

  async revokeSession(sessionId: string, reason: string) {
    const { error } = await this.client.from("app_sessions").update({ revoked_at: new Date().toISOString(), revoke_reason: reason }).eq("id", sessionId).is("revoked_at", null);
    this.check(error);
  }

  async revokeUserSessions(userId: string, reason: string) {
    const { error } = await this.client.from("app_sessions").update({ revoked_at: new Date().toISOString(), revoke_reason: reason }).eq("user_id", userId).is("revoked_at", null);
    this.check(error);
  }

  async findUserById(userId: string) {
    const { data, error } = await this.client.from("app_users").select(USER_COLUMNS).eq("id", userId).maybeSingle();
    this.check(error);
    return data ? rowToAuthUser(data as UserRow) : undefined;
  }

  async findUserByEmail(email: string) {
    const { data, error } = await this.client.from("app_users").select(USER_COLUMNS).eq("email", email.trim().toLowerCase()).maybeSingle();
    this.check(error);
    return data ? rowToAuthUser(data as UserRow) : undefined;
  }

  async projectExists(projectId: string) {
    const { data, error } = await this.client.from("projects").select("id").eq("id", projectId).maybeSingle();
    this.check(error);
    return Boolean(data);
  }

  async isProjectMember(userId: string, projectId: string) {
    const { data, error } = await this.client.from("project_members").select("project_id").eq("user_id", userId).eq("project_id", projectId).maybeSingle();
    this.check(error);
    return Boolean(data);
  }

  async memberProjectIds(userId: string) {
    const { data, error } = await this.client.from("project_members").select("project_id").eq("user_id", userId);
    this.check(error);
    return new Set(((data ?? []) as { project_id: string }[]).map((row) => row.project_id));
  }

  async addProjectMember(projectId: string, userId: string, createdBy: string | null) {
    const { error } = await this.client.from("project_members").upsert({ project_id: projectId, user_id: userId, created_by: createdBy }, { onConflict: "project_id,user_id", ignoreDuplicates: true });
    this.check(error);
  }
}

let override: AuthStore | undefined;

/** The store every auth check uses: the database, unless a test injected an in-memory one. */
export function authStore(): AuthStore {
  return override ?? new SupabaseAuthStore(createSupabaseServerClient());
}

/**
 * Dependency injection for automated tests (an in-memory store with the same contract). It never
 * skips a check — the cookie must still be validly signed and the store still decides — and no
 * runtime path of the app calls it.
 */
export function setAuthStoreForTesting(store: AuthStore | undefined): void {
  override = store;
}
