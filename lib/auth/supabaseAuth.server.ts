import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveAppEnvironment } from "../env/supabaseEnvironment.ts";
import { createSupabaseServerClient } from "../db/supabase.server.ts";

/**
 * Supabase Auth gateway (V1-AUTH-01) — the ONLY place that talks to Supabase Auth. Credentials,
 * invitations and password resets are Supabase Auth's job; the app never stores a password. Every
 * call uses a FRESH server client (a signed-in client would otherwise carry the user's token into
 * later queries) and discards it; no Supabase token is ever handed to the browser.
 *
 * Invitation and reset links are generated with admin.generateLink — that does NOT send an e-mail.
 * The admin hands the link over; only "Zapomenuté heslo" on the login page asks Supabase to send
 * its own e-mail (to the address the user typed, and only for an existing active account).
 */
export type AuthGateway = Readonly<{
  signInWithPassword(email: string, password: string): Promise<SignInResult>;
  verifyEmailLinkToken(tokenHash: string, type: EmailLinkType): Promise<string | undefined>;
  verifyAccessToken(accessToken: string): Promise<string | undefined>;
  generateLink(type: "invite" | "recovery", email: string, redirectTo: string): Promise<Readonly<{ userId: string; tokenHash: string }>>;
  createConfirmedUser(email: string, password: string): Promise<string>;
  setPassword(userId: string, password: string): Promise<void>;
  sendRecoveryEmail(email: string, redirectTo: string): Promise<void>;
  authUserInfo(userId: string): Promise<AuthUserInfo | undefined>;
}>;

export type SignInResult =
  | Readonly<{ ok: true; userId: string }>
  | Readonly<{ ok: false; reason: "invalid" | "unconfirmed" | "rate_limited" | "unavailable"; message?: string }>;
export type EmailLinkType = "invite" | "recovery";
export type AuthUserInfo = Readonly<{ invitedAt: string | null; confirmedAt: string | null; lastSignInAt: string | null; hasPassword: boolean }>;

export class AuthGatewayError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "AuthGatewayError";
    this.code = code;
  }
}

const client = (): SupabaseClient => createSupabaseServerClient();

function gatewayError(error: { code?: string; message?: string; status?: number } | null | undefined, fallback: string): AuthGatewayError {
  const code = error?.code ?? (error?.status ? `http_${error.status}` : "unknown");
  if (code === "email_exists" || code === "user_already_exists" || /already (been )?registered/iu.test(error?.message ?? "")) return new AuthGatewayError("email_exists", "Účet s tímto e-mailem už v Supabase Auth existuje.");
  return new AuthGatewayError(code, fallback);
}

export const supabaseAuthGateway: AuthGateway = {
  async signInWithPassword(email, password) {
    let auth: SupabaseClient;
    try {
      auth = client();
    } catch (error) {
      return { ok: false, reason: "unavailable", message: error instanceof Error ? error.message : "Supabase není nakonfigurováno." };
    }
    try {
      const { data, error } = await auth.auth.signInWithPassword({ email, password });
      if (error) {
        if (error.code === "email_not_confirmed") return { ok: false, reason: "unconfirmed" };
        if (error.code === "invalid_credentials" || error.status === 400) return { ok: false, reason: "invalid" };
        if (error.status === 429 || error.code === "over_request_rate_limit") return { ok: false, reason: "rate_limited" };
        return { ok: false, reason: "unavailable", message: "Služba přihlášení neodpověděla. Zkuste to znovu." };
      }
      const userId = data.user?.id;
      // The Supabase session is not kept — the app issues its own revocable session cookie.
      if (data.session?.access_token) await auth.auth.admin.signOut(data.session.access_token).catch(() => undefined);
      return userId ? { ok: true, userId } : { ok: false, reason: "unavailable" };
    } catch {
      return { ok: false, reason: "unavailable", message: "Služba přihlášení není dostupná. Zkuste to znovu." };
    }
  },

  async verifyEmailLinkToken(tokenHash, type) {
    const { data, error } = await client().auth.verifyOtp({ token_hash: tokenHash, type });
    if (error || !data.user) return undefined;
    if (data.session?.access_token) await client().auth.admin.signOut(data.session.access_token).catch(() => undefined);
    return data.user.id;
  },

  async verifyAccessToken(accessToken) {
    const { data, error } = await client().auth.getUser(accessToken);
    if (error || !data.user) return undefined;
    await client().auth.admin.signOut(accessToken).catch(() => undefined);
    return data.user.id;
  },

  async generateLink(type, email, redirectTo) {
    const { data, error } = await client().auth.admin.generateLink({ type, email, options: { redirectTo } });
    if (error || !data.user || !data.properties?.hashed_token) throw gatewayError(error, "Odkaz se nepodařilo vytvořit (Supabase Auth).");
    return { userId: data.user.id, tokenHash: data.properties.hashed_token };
  },

  async createConfirmedUser(email, password) {
    const { data, error } = await client().auth.admin.createUser({ email, password, email_confirm: true });
    if (error || !data.user) throw gatewayError(error, "Účet se nepodařilo založit (Supabase Auth).");
    return data.user.id;
  },

  async setPassword(userId, password) {
    const { error } = await client().auth.admin.updateUserById(userId, { password });
    if (error) throw new AuthGatewayError(error.code ?? "password", error.code === "weak_password" ? "Heslo je příliš slabé." : "Heslo se nepodařilo nastavit.");
  },

  async sendRecoveryEmail(email, redirectTo) {
    const { error } = await client().auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw gatewayError(error, "Odkaz pro obnovu hesla se nepodařilo odeslat.");
  },

  async authUserInfo(userId) {
    const { data, error } = await client().auth.admin.getUserById(userId);
    if (error || !data.user) return undefined;
    const user = data.user as { invited_at?: string | null; email_confirmed_at?: string | null; confirmed_at?: string | null; last_sign_in_at?: string | null; identities?: unknown[] };
    return { invitedAt: user.invited_at ?? null, confirmedAt: user.email_confirmed_at ?? user.confirmed_at ?? null, lastSignInAt: user.last_sign_in_at ?? null, hasPassword: Boolean(user.last_sign_in_at || user.email_confirmed_at) };
  },
};

let gatewayOverride: AuthGateway | undefined;
export function authGateway(): AuthGateway {
  return gatewayOverride ?? supabaseAuthGateway;
}
/** Tests only — an in-memory Supabase Auth double (never a bypass: the app logic is unchanged). */
export function setAuthGatewayForTesting(gateway: AuthGateway | undefined): void {
  gatewayOverride = gateway;
}

// ---------------------------------------------------------------------------------------------
// Links must point to THIS environment's app (a DEV link never to production)
// ---------------------------------------------------------------------------------------------
export class AppBaseUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppBaseUrlError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Base URL for invitation / reset links. APP_BASE_URL decides; in development it must be a local
 * address (so a DEV link can never lead to the production app), and without it the request's own
 * local origin is used. Outside development APP_BASE_URL is required and must be https.
 */
export function appBaseUrl(requestUrl: string, environment: Readonly<{ APP_BASE_URL?: string; NEXT_PUBLIC_APP_ENV?: string; NODE_ENV?: string }> = { APP_BASE_URL: process.env.APP_BASE_URL, NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV, NODE_ENV: process.env.NODE_ENV }): string {
  const appEnvironment = resolveAppEnvironment(environment);
  const configured = environment.APP_BASE_URL?.trim().replace(/\/+$/u, "");
  if (configured) {
    let url: URL;
    try {
      url = new URL(configured);
    } catch {
      throw new AppBaseUrlError("APP_BASE_URL není platná adresa.");
    }
    if (appEnvironment === "development" && !LOCAL_HOSTS.has(url.hostname)) throw new AppBaseUrlError("Ve vývoji (DEV) musí APP_BASE_URL mířit na lokální aplikaci (localhost) — odkazy z DEV nesmí vést jinam.");
    if (appEnvironment !== "development" && url.protocol !== "https:") throw new AppBaseUrlError("APP_BASE_URL musí mimo vývoj používat https.");
    return url.origin;
  }
  const request = new URL(requestUrl);
  if (appEnvironment === "development" && LOCAL_HOSTS.has(request.hostname)) return request.origin;
  throw new AppBaseUrlError("Chybí APP_BASE_URL (adresa aplikace pro odkazy z pozvánek a obnovy hesla).");
}

export const PASSWORD_MIN_LENGTH = 10;
export function passwordProblem(password: unknown): string | undefined {
  if (typeof password !== "string" || password.length < PASSWORD_MIN_LENGTH) return `Heslo musí mít alespoň ${PASSWORD_MIN_LENGTH} znaků.`;
  if (password.length > 200) return "Heslo je příliš dlouhé.";
  if (password.trim() !== password || !/\S/u.test(password)) return "Heslo nesmí začínat ani končit mezerou.";
  return undefined;
}

export function normalizeEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim().toLowerCase();
  return email.length <= 254 && /^[^\s@<>()]+@[^\s@<>()]+\.[^\s@<>()]+$/u.test(email) ? email : undefined;
}
