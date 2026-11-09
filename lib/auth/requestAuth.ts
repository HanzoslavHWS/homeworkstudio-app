import { NextResponse, type NextRequest } from "next/server.js";
import { can, fileScope, projectAccess, projectFileAccess, type FileAction, type Permission, type ProjectAction } from "../../domain/accessControl.ts";
import { SupabaseConfigurationError } from "../db/supabase.server.ts";
import { AuthSchemaNotMigratedError, authStore, type AuthUser, type StoredSession } from "./authStore.server.ts";
import { AUTH_COOKIE_NAME, readSessionToken, SESSION_TTL_SECONDS, isSessionSecretConfigured } from "./session.ts";

/**
 * V1-AUTH-01 — the ONE authorization path of every API route and page. A request is resolved to:
 *   authenticated  — valid signed cookie + session row not revoked/expired + active app_users row
 *   unauthenticated — no / invalid / expired / revoked cookie or session (→ 401, sign in again)
 *   inactive       — the account is deactivated (→ 403 "účet deaktivován", never a silent 401)
 *   unavailable    — missing configuration or migration, database error (→ 503 — never presented
 *                    as a wrong password, and never an open door)
 * Then `authorize(request, permission)` / `authorizeProject` / `authorizeFile` apply the shared
 * matrix of domain/accessControl.ts. The role always comes from app_users — never from the client.
 */
export type AuthEnvironment = Readonly<{ APP_SESSION_SECRET?: string }>;

export type AuthenticatedState = Readonly<{ status: "authenticated"; user: AuthUser; session: StoredSession; renewTo?: number }>;
export type AuthState =
  | AuthenticatedState
  | Readonly<{ status: "unauthenticated"; reason: "missing" | "invalid" | "expired" | "revoked" | "unknown_user" }>
  | Readonly<{ status: "inactive"; user: AuthUser }>
  | Readonly<{ status: "unavailable"; reason: "config" | "migration" | "database"; message: string }>;

const defaultEnvironment = (): AuthEnvironment => ({ APP_SESSION_SECRET: process.env.APP_SESSION_SECRET });

/** Renew the idle lifetime once less than half of it is left. */
const RENEW_THRESHOLD_MS = (SESSION_TTL_SECONDS * 1000) / 2;

export async function resolveSessionToken(token: string | undefined, environment: AuthEnvironment = defaultEnvironment(), nowMs = Date.now()): Promise<AuthState> {
  if (!isSessionSecretConfigured(environment.APP_SESSION_SECRET)) return { status: "unavailable", reason: "config", message: "Přihlášení není na serveru nakonfigurované (APP_SESSION_SECRET)." };
  if (!token) return { status: "unauthenticated", reason: "missing" };
  const claims = await readSessionToken(token, environment.APP_SESSION_SECRET, nowMs);
  if (!claims) return { status: "unauthenticated", reason: "invalid" };
  let loaded: Awaited<ReturnType<ReturnType<typeof authStore>["loadSession"]>>;
  try {
    loaded = await authStore().loadSession(claims.sessionId);
  } catch (error) {
    if (error instanceof AuthSchemaNotMigratedError) return { status: "unavailable", reason: "migration", message: error.message };
    if (error instanceof SupabaseConfigurationError) return { status: "unavailable", reason: "config", message: error.message };
    console.error("Auth: session lookup failed:", error instanceof Error ? error.message : error);
    return { status: "unavailable", reason: "database", message: "Ověření přihlášení se nezdařilo (databáze nedostupná). Zkuste to znovu." };
  }
  if (!loaded || loaded.session.userId !== claims.userId || loaded.user.id !== claims.userId) return { status: "unauthenticated", reason: "unknown_user" };
  const { session, user } = loaded;
  // A deactivated account is reported as such (its sessions are revoked by the same change).
  if (!user.isActive) return { status: "inactive", user };
  if (session.revokedAt !== null) return { status: "unauthenticated", reason: "revoked" };
  if (session.expiresAt <= nowMs || session.absoluteExpiresAt <= nowMs) return { status: "unauthenticated", reason: "expired" };
  const renewTo = session.expiresAt - nowMs < RENEW_THRESHOLD_MS ? Math.min(nowMs + SESSION_TTL_SECONDS * 1000, session.absoluteExpiresAt) : undefined;
  return { status: "authenticated", user, session, ...(renewTo && renewTo > session.expiresAt ? { renewTo } : {}) };
}

const memo = new WeakMap<object, Promise<AuthState>>();

/** Resolved once per request object (a route may ask several times). */
export function resolveRequestAuth(request: NextRequest, environment?: AuthEnvironment): Promise<AuthState> {
  if (environment) return resolveSessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value, environment);
  let pending = memo.get(request);
  if (!pending) {
    pending = resolveSessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value);
    memo.set(request, pending);
  }
  return pending;
}

export type AuthDecision = Readonly<{ ok: true; auth: AuthenticatedState }> | Readonly<{ ok: false; response: NextResponse }>;

export function authFailureResponse(state: Exclude<AuthState, AuthenticatedState>): NextResponse {
  switch (state.status) {
    case "unauthenticated":
      return NextResponse.json({ error: state.reason === "expired" ? "Přihlášení vypršelo. Přihlaste se znovu." : "Pro tuto akci je vyžadováno přihlášení.", code: "unauthenticated" }, { status: 401 });
    case "inactive":
      return NextResponse.json({ error: "Účet je deaktivovaný. Obraťte se na správce.", code: "account_inactive" }, { status: 403 });
    case "unavailable":
      return NextResponse.json({ error: state.message, code: `auth_${state.reason}` }, { status: 503 });
  }
}

export const forbiddenResponse = (message = "K této akci nemáte oprávnění.") => NextResponse.json({ error: message, code: "forbidden" }, { status: 403 });

/** Signed in with an active account (any role) — e.g. "who am I". */
export async function authenticate(request: NextRequest): Promise<AuthDecision> {
  const state = await resolveRequestAuth(request);
  return state.status === "authenticated" ? { ok: true, auth: state } : { ok: false, response: authFailureResponse(state) };
}

/** Signed in AND the role has the permission. */
export async function authorize(request: NextRequest, permission: Permission): Promise<AuthDecision> {
  const decision = await authenticate(request);
  if (decision.ok === false) return decision;
  return can(decision.auth.user.role, permission) ? decision : { ok: false, response: forbiddenResponse() };
}

/** Signed in AND may do `action` on this one 3D project (role + assignment, see projectAccess). */
export async function authorizeProject(request: NextRequest, projectId: string, action: ProjectAction): Promise<AuthDecision> {
  const decision = await authenticate(request);
  if (decision.ok === false) return decision;
  const allowed = await projectAllowed(decision.auth.user, projectId, action);
  if (allowed === "error") return { ok: false, response: NextResponse.json({ error: "Oprávnění k projektu se nepodařilo ověřit.", code: "auth_database" }, { status: 503 }) };
  return allowed ? decision : { ok: false, response: forbiddenResponse("K tomuto projektu nemáte přístup.") };
}

async function projectAllowed(user: AuthUser, projectId: string, action: ProjectAction, folder?: string): Promise<boolean | "error"> {
  if (user.role === "admin") return true;
  try {
    const store = authStore();
    const [exists, isMember] = await Promise.all([store.projectExists(projectId), store.isProjectMember(user.id, projectId)]);
    if (folder !== undefined) return projectFileAccess(user.role, action === "read" ? "read" : "write", folder, { exists, isMember });
    return projectAccess(user.role, action, { exists, isMember });
  } catch (error) {
    console.error("Auth: project access check failed:", error instanceof Error ? error.message : error);
    return "error";
  }
}

/** Signed in AND may read/write this storage key (owning module from the key prefix, project files by assignment). */
export async function authorizeFile(request: NextRequest, storageKey: string, action: FileAction): Promise<AuthDecision> {
  const decision = await authenticate(request);
  if (decision.ok === false) return decision;
  const scope = fileScope(storageKey, action);
  if (scope.kind === "invalid") return { ok: false, response: NextResponse.json({ error: "Neplatný storageKey.", code: "invalid-key" }, { status: 400 }) };
  if (scope.kind === "global") return can(decision.auth.user.role, scope.permission) ? decision : { ok: false, response: forbiddenResponse("K tomuto souboru nemáte přístup.") };
  const allowed = await projectAllowed(decision.auth.user, scope.projectId, action === "read" ? "read" : "write", scope.folder);
  if (allowed === "error") return { ok: false, response: NextResponse.json({ error: "Oprávnění k souboru se nepodařilo ověřit.", code: "auth_database" }, { status: 503 }) };
  return allowed ? decision : { ok: false, response: forbiddenResponse("K tomuto souboru nemáte přístup.") };
}

/** Project ids the user may list: undefined = all (admin), else the assigned ones. */
export async function visibleProjectIds(user: AuthUser): Promise<ReadonlySet<string> | undefined> {
  if (user.role === "admin") return undefined;
  return authStore().memberProjectIds(user.id);
}

/** One-line guard for route handlers: the failure response, or undefined when allowed. */
export async function denyUnless(request: NextRequest, permission: Permission): Promise<NextResponse | undefined> {
  const decision = await authorize(request, permission);
  return decision.ok === false ? decision.response : undefined;
}
