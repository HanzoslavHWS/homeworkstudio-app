import { NextResponse, type NextRequest } from "next/server.js";
import { permissionsOf, safeReturnPath } from "../../domain/accessControl.ts";
import { SupabaseConfigurationError } from "../db/supabase.server.ts";
import { AuthSchemaNotMigratedError, authStore, type AuthUser } from "./authStore.server.ts";
import { authFailureResponse, resolveRequestAuth } from "./requestAuth.ts";
import {
  AUTH_COOKIE_NAME,
  createPasswordSetupToken,
  createSessionToken,
  isSessionSecretConfigured,
  PASSWORD_SETUP_COOKIE_NAME,
  PASSWORD_SETUP_TTL_SECONDS,
  readPasswordSetupToken,
  readSessionToken,
  SESSION_ABSOLUTE_TTL_SECONDS,
  SESSION_TTL_SECONDS,
  sessionCookieOptions,
} from "./session.ts";
import { AppBaseUrlError, appBaseUrl, authGateway, normalizeEmail, passwordProblem, type EmailLinkType } from "./supabaseAuth.server.ts";

/**
 * Login, logout, session, password reset and invitation acceptance (V1-AUTH-01). No public sign-up:
 * an account exists only when an administrator created it (app_users + Supabase Auth). Signing in
 * needs an active shared account only (V1-AUTH-02): what it may open is decided per application by
 * its memberships — an account without any application gets the launcher's explanation, not a login error. Errors are reported
 * by kind — wrong credentials, deactivated account, no access, rate limit, missing configuration or
 * migration — never a configuration problem disguised as a wrong password. Passwords and tokens are
 * never logged.
 */
export type LoginErrorCode = "invalid" | "inactive" | "no_access" | "unconfirmed" | "rate_limited" | "config" | "migration" | "unavailable";

const secret = () => process.env.APP_SESSION_SECRET;
const wantsJson = (request: NextRequest) => (request.headers.get("accept") ?? "").includes("application/json") || (request.headers.get("content-type") ?? "").includes("application/json");

// Small per-instance limiter on top of Supabase Auth's own: 8 failed attempts per e-mail+IP / 15 min.
const failures = new Map<string, { count: number; until: number }>();
const LIMIT = 8;
const WINDOW_MS = 15 * 60 * 1000;
const limiterKey = (request: NextRequest, email: string) => `${request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "local"}|${email}`;
function limited(key: string, nowMs = Date.now()): boolean {
  const entry = failures.get(key);
  return Boolean(entry && entry.until > nowMs && entry.count >= LIMIT);
}
function recordFailure(key: string, nowMs = Date.now()): void {
  const entry = failures.get(key);
  failures.set(key, entry && entry.until > nowMs ? { count: entry.count + 1, until: entry.until } : { count: 1, until: nowMs + WINDOW_MS });
}
export function resetLoginLimiterForTesting(): void {
  failures.clear();
}

async function readBody(request: NextRequest): Promise<Record<string, unknown>> {
  try {
    if ((request.headers.get("content-type") ?? "").includes("application/json")) return ((await request.json()) ?? {}) as Record<string, unknown>;
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  } catch {
    return {};
  }
}

/** Issues a new revocable session for an active user and sets the cookie on `response`. */
export async function startSession(response: NextResponse, user: AuthUser, nowMs = Date.now()): Promise<NextResponse> {
  const sessionSecret = secret();
  if (!isSessionSecretConfigured(sessionSecret)) throw new SupabaseConfigurationError(["APP_SESSION_SECRET"]);
  const expiresAt = nowMs + SESSION_TTL_SECONDS * 1000;
  const session = await authStore().createSession(user.id, expiresAt, nowMs + SESSION_ABSOLUTE_TTL_SECONDS * 1000);
  response.cookies.set(AUTH_COOKIE_NAME, await createSessionToken(sessionSecret, { sessionId: session.id, userId: user.id, expiresAt }), sessionCookieOptions());
  return response;
}

const clearCookie = (response: NextResponse, name: string) => {
  response.cookies.set(name, "", { ...sessionCookieOptions(), maxAge: 0 });
  return response;
};

function loginFailure(request: NextRequest, code: LoginErrorCode, returnPath: string, message: string, status: number): NextResponse {
  if (wantsJson(request)) return NextResponse.json({ error: message, code }, { status });
  const url = new URL("/login", request.url);
  url.searchParams.set("error", code);
  if (returnPath !== "/") url.searchParams.set("next", returnPath);
  return NextResponse.redirect(url, 303);
}

export const LOGIN_ERROR_MESSAGES: Readonly<Record<LoginErrorCode, string>> = {
  invalid: "E-mail nebo heslo není správné.",
  inactive: "Účet je deaktivovaný. Obraťte se na správce.",
  no_access: "Tento účet nemá přístup do aplikace. Obraťte se na správce.",
  unconfirmed: "Účet ještě není aktivovaný — použijte odkaz z pozvánky.",
  rate_limited: "Příliš mnoho pokusů o přihlášení. Zkuste to za několik minut.",
  config: "Přihlášení není na serveru nakonfigurované. Kontaktujte správce.",
  migration: "Databáze nemá tabulky přihlášení (chybí migrace). Kontaktujte správce.",
  unavailable: "Služba přihlášení je dočasně nedostupná. Zkuste to znovu.",
};

export async function handleLogin(request: NextRequest): Promise<NextResponse> {
  const body = await readBody(request);
  const returnPath = safeReturnPath(body.next);
  const fail = (code: LoginErrorCode, status: number) => loginFailure(request, code, returnPath, LOGIN_ERROR_MESSAGES[code], status);
  if (!isSessionSecretConfigured(secret()) || !process.env.SUPABASE_URL?.trim() || !process.env.SUPABASE_SECRET_KEY?.trim()) return fail("config", 503);
  const email = normalizeEmail(body.email);
  const password = typeof body.password === "string" ? body.password : "";
  if (!email || !password) return fail("invalid", 401);
  const key = limiterKey(request, email);
  if (limited(key)) return fail("rate_limited", 429);

  const result = await authGateway().signInWithPassword(email, password);
  if (result.ok === false) {
    if (result.reason === "invalid") { recordFailure(key); return fail("invalid", 401); }
    if (result.reason === "unconfirmed") return fail("unconfirmed", 403);
    if (result.reason === "rate_limited") return fail("rate_limited", 429);
    return fail(/nakonfigurov|SUPABASE|Chybí/iu.test(result.message ?? "") ? "config" : "unavailable", 503);
  }
  try {
    const user = await authStore().findUserById(result.userId);
    if (!user) { recordFailure(key); return fail("no_access", 403); }
    if (!user.isActive) return fail("inactive", 403);
    failures.delete(key);
    const response = wantsJson(request) ? NextResponse.json({ ok: true, redirectTo: returnPath }) : NextResponse.redirect(new URL(returnPath, request.url), 303);
    return await startSession(response, user);
  } catch (error) {
    if (error instanceof AuthSchemaNotMigratedError) return fail("migration", 503);
    if (error instanceof SupabaseConfigurationError) return fail("config", 503);
    console.error("Login: session could not be created:", error instanceof Error ? error.message : error);
    return fail("unavailable", 503);
  }
}

export async function handleLogout(request: NextRequest): Promise<NextResponse> {
  const claims = await readSessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value, secret());
  if (claims) await authStore().revokeSession(claims.sessionId, "logout").catch((error) => console.error("Logout: revoke failed:", error instanceof Error ? error.message : error));
  const response = wantsJson(request) ? NextResponse.json({ ok: true }) : NextResponse.redirect(new URL("/login?status=logged_out", request.url), 303);
  clearCookie(response, PASSWORD_SETUP_COOKIE_NAME);
  return clearCookie(response, AUTH_COOKIE_NAME);
}

/** Who am I + session renewal (sliding idle lifetime, capped by the absolute one). */
export async function handleSession(request: NextRequest): Promise<NextResponse> {
  const state = await resolveRequestAuth(request);
  if (state.status !== "authenticated") {
    const response = authFailureResponse(state);
    return state.status === "unavailable" ? response : clearCookie(response, AUTH_COOKIE_NAME);
  }
  const { user, session } = state;
  // role / permissions = ABF (this application); apps and isHwsAdmin = the shared account (V1-AUTH-02)
  const response = NextResponse.json({ user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role ?? null, isHwsAdmin: user.isHwsAdmin, apps: user.apps }, permissions: permissionsOf(user.role), expiresAt: new Date(state.renewTo ?? session.expiresAt).toISOString() });
  if (state.renewTo) {
    await authStore().extendSession(session.id, state.renewTo);
    response.cookies.set(AUTH_COOKIE_NAME, await createSessionToken(secret()!, { sessionId: session.id, userId: user.id, expiresAt: state.renewTo }), sessionCookieOptions(Math.max(60, Math.round((state.renewTo - Date.now()) / 1000))));
  }
  return response;
}

// ---------------------------------------------------------------------------------------------
// Password reset / invitation acceptance
// ---------------------------------------------------------------------------------------------
const GENERIC_FORGOT = "Pokud k e-mailu existuje aktivní účet, poslali jsme na něj odkaz pro nastavení nového hesla.";

/** Always the same answer (no account enumeration); an e-mail is sent only for an existing active account. */
export async function handleForgotPassword(request: NextRequest): Promise<NextResponse> {
  const body = await readBody(request);
  const email = normalizeEmail(body.email);
  if (!email) return NextResponse.json({ error: "Zadejte platný e-mail." }, { status: 400 });
  let redirectTo: string;
  try {
    redirectTo = `${appBaseUrl(request.url)}/auth/callback`;
  } catch (error) {
    return NextResponse.json({ error: error instanceof AppBaseUrlError ? error.message : "Chybí konfigurace adresy aplikace.", code: "config" }, { status: 503 });
  }
  try {
    const user = await authStore().findUserByEmail(email);
    if (user?.isActive) await authGateway().sendRecoveryEmail(email, redirectTo);
  } catch (error) {
    if (error instanceof AuthSchemaNotMigratedError) return NextResponse.json({ error: LOGIN_ERROR_MESSAGES.migration, code: "migration" }, { status: 503 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: LOGIN_ERROR_MESSAGES.config, code: "config" }, { status: 503 });
    // Rate limit / mailer problems are not revealed per address either.
    console.error("Forgot password failed:", error instanceof Error ? error.message : error);
  }
  return NextResponse.json({ ok: true, message: GENERIC_FORGOT });
}

async function grantPasswordSetup(response: NextResponse, userId: string, kind: EmailLinkType): Promise<NextResponse> {
  response.cookies.set(PASSWORD_SETUP_COOKIE_NAME, await createPasswordSetupToken(secret()!, userId, kind), sessionCookieOptions(PASSWORD_SETUP_TTL_SECONDS));
  return response;
}

async function linkUserAllowed(userId: string): Promise<"ok" | "no_access" | "inactive"> {
  const user = await authStore().findUserById(userId);
  if (!user) return "no_access";
  return user.isActive ? "ok" : "inactive";
}

/** GET /auth/confirm?token_hash=…&type=invite|recovery — links generated by the admin (or a customized e-mail template). */
export async function handleConfirmLink(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const tokenHash = url.searchParams.get("token_hash") ?? "";
  const type = url.searchParams.get("type");
  const toLogin = (error: string) => NextResponse.redirect(new URL(`/login?error=${error}`, request.url), 303);
  if (!isSessionSecretConfigured(secret())) return toLogin("config");
  if (!tokenHash || (type !== "invite" && type !== "recovery")) return toLogin("link_invalid");
  try {
    const userId = await authGateway().verifyEmailLinkToken(tokenHash, type);
    if (!userId) return toLogin("link_invalid");
    const allowed = await linkUserAllowed(userId);
    if (allowed !== "ok") return toLogin(allowed);
    return await grantPasswordSetup(NextResponse.redirect(new URL(`/login/nove-heslo?kind=${type}`, request.url), 303), userId, type);
  } catch (error) {
    if (error instanceof AuthSchemaNotMigratedError) return toLogin("migration");
    return toLogin("unavailable");
  }
}

/** POST /api/auth/callback {accessToken, type} — the default Supabase e-mail link (#access_token=… fragment). */
export async function handleCallbackToken(request: NextRequest): Promise<NextResponse> {
  const body = await readBody(request);
  const accessToken = typeof body.accessToken === "string" ? body.accessToken : "";
  const type = body.type === "invite" || body.type === "recovery" ? body.type : body.type === "signup" || body.type === "magiclink" ? "invite" : undefined;
  if (!isSessionSecretConfigured(secret())) return NextResponse.json({ error: LOGIN_ERROR_MESSAGES.config, code: "config" }, { status: 503 });
  if (!accessToken || !type) return NextResponse.json({ error: "Odkaz je neplatný nebo neúplný.", code: "link_invalid" }, { status: 400 });
  try {
    const userId = await authGateway().verifyAccessToken(accessToken);
    if (!userId) return NextResponse.json({ error: "Odkaz je neplatný nebo vypršel. Požádejte o nový.", code: "link_invalid" }, { status: 400 });
    const allowed = await linkUserAllowed(userId);
    if (allowed !== "ok") return NextResponse.json({ error: LOGIN_ERROR_MESSAGES[allowed], code: allowed }, { status: 403 });
    return await grantPasswordSetup(NextResponse.json({ ok: true, redirectTo: `/login/nove-heslo?kind=${type}` }), userId, type);
  } catch (error) {
    if (error instanceof AuthSchemaNotMigratedError) return NextResponse.json({ error: LOGIN_ERROR_MESSAGES.migration, code: "migration" }, { status: 503 });
    return NextResponse.json({ error: LOGIN_ERROR_MESSAGES.unavailable, code: "unavailable" }, { status: 503 });
  }
}

/** POST /api/auth/password/set {password} — only with a fresh password-setup grant; ends all old sessions and signs in. */
export async function handleSetPassword(request: NextRequest): Promise<NextResponse> {
  const grant = await readPasswordSetupToken(request.cookies.get(PASSWORD_SETUP_COOKIE_NAME)?.value, secret());
  if (!grant) return NextResponse.json({ error: "Odkaz pro nastavení hesla vypršel. Požádejte o nový.", code: "grant_missing" }, { status: 401 });
  const body = await readBody(request);
  const problem = passwordProblem(body.password);
  if (problem) return NextResponse.json({ error: problem, code: "weak_password" }, { status: 400 });
  try {
    const user = await authStore().findUserById(grant.userId);
    if (!user) return NextResponse.json({ error: LOGIN_ERROR_MESSAGES.no_access, code: "no_access" }, { status: 403 });
    if (!user.isActive) return NextResponse.json({ error: LOGIN_ERROR_MESSAGES.inactive, code: "inactive" }, { status: 403 });
    await authGateway().setPassword(user.id, body.password as string);
    await authStore().revokeUserSessions(user.id, "password_changed");
    const response = clearCookie(NextResponse.json({ ok: true, redirectTo: "/" }), PASSWORD_SETUP_COOKIE_NAME);
    return await startSession(response, user);
  } catch (error) {
    if (error instanceof AuthSchemaNotMigratedError) return NextResponse.json({ error: LOGIN_ERROR_MESSAGES.migration, code: "migration" }, { status: 503 });
    return NextResponse.json({ error: error instanceof Error && error.name === "AuthGatewayError" ? error.message : "Heslo se nepodařilo nastavit.", code: "unavailable" }, { status: 502 });
  }
}
