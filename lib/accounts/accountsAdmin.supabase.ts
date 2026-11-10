import type { SupabaseClient } from "@supabase/supabase-js";
import { isHwsAppKey, type AppMemberships, type HwsAppStatus, type InvitationStatus, type RequestedAccess } from "../../domain/hwsApps.ts";
import { createSupabaseServerClient } from "../db/supabase.server.ts";
import { AuthSchemaNotMigratedError } from "../auth/authStore.server.ts";

/**
 * Shared account administration (V1-AUTH-02) — app_users, app_memberships, account_invitations and
 * the hws_apps registry. Only called by the shared-administration API after its own permission was
 * checked. Writes that touch several rows go through the database functions hws_update_account /
 * hws_set_memberships (one transaction each); the last-administrator rules are database triggers
 * serialized by an advisory lock, so concurrent requests cannot both pass.
 */
export type InvitationRecord = Readonly<{ id: string; status: InvitationStatus; delivery: "manual" | "email"; lastError: string | null; createdAt: string; updatedAt: string }>;

export type AccountRecord = Readonly<{
  id: string;
  email: string;
  displayName: string | null;
  isActive: boolean;
  isHwsAdmin: boolean;
  apps: AppMemberships;
  createdAt: string;
  updatedAt: string;
  deactivatedAt: string | null;
  /** The latest invitation attempt, if any. */
  invitation: InvitationRecord | null;
}>;

export type RegisteredApp = Readonly<{ key: string; name: string; url: string | null; status: HwsAppStatus; roles: readonly string[]; sortOrder: number }>;

export class LastAdminError extends Error {
  readonly scope: "hws" | "app";
  readonly appKey: string | null;
  constructor(scope: "hws" | "app", appKey: string | null) {
    super(scope === "hws"
      ? "Poslední aktivní správce HomeworkStudia nemůže být deaktivován ani odebrán. Nejdřív jmenujte jiného."
      : `Poslední aktivní správce aplikace${appKey === "abf" ? " ABF Generator" : ""} nemůže přijít o roli, přístup ani aktivní účet. Nejdřív jmenujte jiného.`);
    this.name = "LastAdminError";
    this.scope = scope;
    this.appKey = appKey;
  }
}
export class AccountConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccountConflictError";
  }
}

export interface AccountsAdminStore {
  list(): Promise<readonly AccountRecord[]>;
  get(userId: string): Promise<AccountRecord | undefined>;
  findByEmail(email: string): Promise<AccountRecord | undefined>;
  /** Creates the account row if it does not exist (idempotent); never changes an existing one. */
  ensureAccount(input: Readonly<{ id: string; email: string; displayName: string | null; createdBy: string }>): Promise<AccountRecord>;
  setMemberships(userId: string, access: readonly RequestedAccess[], actorId: string): Promise<void>;
  /** false = the account changed meanwhile (stale expectedUpdatedAt), nothing written. */
  updateAccount(userId: string, patch: Readonly<{ displayName?: string | null; isActive?: boolean; isHwsAdmin?: boolean; access?: readonly RequestedAccess[] }>, expectedUpdatedAt: string, actorId: string): Promise<boolean>;
  createInvitation(input: Readonly<{ userId: string; access: readonly RequestedAccess[]; delivery: "manual" | "email"; createdBy: string }>): Promise<InvitationRecord>;
  updateInvitation(invitationId: string, patch: Readonly<{ status: InvitationStatus; lastError?: string | null }>): Promise<void>;
  apps(): Promise<readonly RegisteredApp[]>;
}

type MembershipRow = { app_key: string; role: string };
type InvitationRow = { id: string; status: InvitationStatus; delivery: "manual" | "email"; last_error: string | null; created_at: string; updated_at: string };
type Row = { id: string; email: string; display_name: string | null; is_active: boolean; is_hws_admin: boolean; created_at: string; updated_at: string; deactivated_at: string | null; app_memberships?: MembershipRow[] | null; account_invitations?: InvitationRow[] | null };

const COLUMNS = "id, email, display_name, is_active, is_hws_admin, created_at, updated_at, deactivated_at, app_memberships!app_memberships_user_id_fkey (app_key, role), account_invitations!account_invitations_user_id_fkey (id, status, delivery, last_error, created_at, updated_at)";
const isMissingSchema = (error: unknown) => ["42P01", "PGRST205", "PGRST200", "PGRST202", "42703", "42883"].includes((error as { code?: string } | null)?.code ?? "");

function toInvitation(row: InvitationRow): InvitationRecord {
  return { id: row.id, status: row.status, delivery: row.delivery, lastError: row.last_error, createdAt: row.created_at, updatedAt: row.updated_at };
}

export function rowToAccount(row: Row): AccountRecord {
  const apps: Partial<Record<string, string>> = {};
  for (const membership of row.app_memberships ?? []) if (isHwsAppKey(membership.app_key)) apps[membership.app_key] = membership.role;
  const latest = [...(row.account_invitations ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    isActive: row.is_active === true,
    isHwsAdmin: row.is_hws_admin === true,
    apps: apps as AppMemberships,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deactivatedAt: row.deactivated_at,
    invitation: latest ? toInvitation(latest) : null,
  };
}

/** Database errors → typed errors the API answers precisely (never a raw database message). */
export function accountsError(error: unknown): Error {
  if (isMissingSchema(error)) return new AuthSchemaNotMigratedError();
  const message = String((error as { message?: string } | null)?.message ?? "");
  if (message.includes("LAST_ACTIVE_HWS_ADMIN")) return new LastAdminError("hws", null);
  const app = /LAST_ACTIVE_APP_ADMIN:([a-z0-9-]+)/u.exec(message);
  if (app) return new LastAdminError("app", app[1]!);
  if (message.includes("INVALID_APP_ROLE")) return new AccountConflictError("Role neplatí pro zvolenou aplikaci.");
  if ((error as { code?: string } | null)?.code === "23505") return new AccountConflictError("Účet s tímto e-mailem už existuje.");
  return error instanceof Error ? error : new Error(message || "Databázová chyba.");
}

const accessJson = (access: readonly RequestedAccess[]) => access.map((entry) => ({ appKey: entry.appKey, role: entry.role }));

export class SupabaseAccountsAdminStore implements AccountsAdminStore {
  private readonly client: SupabaseClient;

  constructor(client: SupabaseClient) {
    this.client = client;
  }

  async list() {
    const { data, error } = await this.client.from("app_users").select(COLUMNS).order("email");
    if (error) throw accountsError(error);
    return ((data ?? []) as Row[]).map(rowToAccount);
  }

  async get(userId: string) {
    const { data, error } = await this.client.from("app_users").select(COLUMNS).eq("id", userId).maybeSingle();
    if (error) throw accountsError(error);
    return data ? rowToAccount(data as Row) : undefined;
  }

  async findByEmail(email: string) {
    const { data, error } = await this.client.from("app_users").select(COLUMNS).eq("email", email.trim().toLowerCase()).maybeSingle();
    if (error) throw accountsError(error);
    return data ? rowToAccount(data as Row) : undefined;
  }

  async ensureAccount(input: Readonly<{ id: string; email: string; displayName: string | null; createdBy: string }>) {
    const { error } = await this.client.from("app_users").upsert({ id: input.id, email: input.email, display_name: input.displayName, created_by: input.createdBy }, { onConflict: "id", ignoreDuplicates: true });
    if (error) throw accountsError(error);
    const account = await this.get(input.id);
    if (!account) throw new AccountConflictError("Účet se nepodařilo založit.");
    if (account.email !== input.email) throw new AccountConflictError("Účet Supabase Auth patří jinému e-mailu — založení zastaveno.");
    return account;
  }

  async setMemberships(userId: string, access: readonly RequestedAccess[], actorId: string) {
    const { error } = await this.client.rpc("hws_set_memberships", { p_user_id: userId, p_access: accessJson(access), p_actor: actorId });
    if (error) throw accountsError(error);
  }

  async updateAccount(userId: string, patch: Readonly<{ displayName?: string | null; isActive?: boolean; isHwsAdmin?: boolean; access?: readonly RequestedAccess[] }>, expectedUpdatedAt: string, actorId: string) {
    const { data, error } = await this.client.rpc("hws_update_account", {
      p_user_id: userId,
      p_expected_updated_at: expectedUpdatedAt,
      p_set_display_name: patch.displayName !== undefined,
      p_display_name: patch.displayName ?? null,
      p_is_active: patch.isActive ?? null,
      p_is_hws_admin: patch.isHwsAdmin ?? null,
      p_access: patch.access ? accessJson(patch.access) : null,
      p_actor: actorId,
    });
    if (error) throw accountsError(error);
    return data === true;
  }

  async createInvitation(input: Readonly<{ userId: string; access: readonly RequestedAccess[]; delivery: "manual" | "email"; createdBy: string }>) {
    const { data, error } = await this.client.from("account_invitations").insert({ user_id: input.userId, requested_access: accessJson(input.access), status: "access_pending", delivery: input.delivery, created_by: input.createdBy }).select("id, status, delivery, last_error, created_at, updated_at").single();
    if (error) throw accountsError(error);
    return toInvitation(data as InvitationRow);
  }

  async updateInvitation(invitationId: string, patch: Readonly<{ status: InvitationStatus; lastError?: string | null }>) {
    const { error } = await this.client.from("account_invitations").update({ status: patch.status, last_error: patch.lastError === undefined ? null : patch.lastError?.slice(0, 300) ?? null }).eq("id", invitationId);
    if (error) throw accountsError(error);
  }

  async apps() {
    const { data, error } = await this.client.from("hws_apps").select("key, name, url, status, roles, sort_order").order("sort_order");
    if (error) throw accountsError(error);
    return ((data ?? []) as { key: string; name: string; url: string | null; status: HwsAppStatus; roles: string[]; sort_order: number }[]).map((row) => ({ key: row.key, name: row.name, url: row.url, status: row.status, roles: row.roles, sortOrder: row.sort_order }));
  }
}

let override: AccountsAdminStore | undefined;
export function accountsAdminStore(): AccountsAdminStore {
  return override ?? new SupabaseAccountsAdminStore(createSupabaseServerClient());
}
/** Tests only (in-memory double with the same contract). */
export function setAccountsAdminStoreForTesting(store: AccountsAdminStore | undefined): void {
  override = store;
}
