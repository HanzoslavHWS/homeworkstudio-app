/**
 * DEV / PROD separation for the Supabase database (docs/DEV_PROD_SETUP.md).
 *
 * The environment is decided by NEXT_PUBLIC_APP_ENV:
 *   - "production" or unset → no restriction (Vercel production keeps working exactly as before);
 *   - "development" / "preview" → the database must be a NON-production project whose ref is
 *     stated explicitly in SUPABASE_EXPECTED_PROJECT_REF.
 * `next dev` with NEXT_PUBLIC_APP_ENV unset is treated as "development" too, so a forgotten variable
 * can never silently run local development against production.
 *
 * Environments are told apart by the project REF (the subdomain of SUPABASE_URL / the host or user
 * of a Postgres connection string), never by a project name. A project ref is an identifier, not a
 * credential — it is safe in the repository.
 */

/** Supabase project refs that are production. Anything listed here is refused outside production. */
export const KNOWN_PRODUCTION_SUPABASE_REFS: readonly string[] = ["fwchkogtaqaunaxmchtu"];

export type AppEnvironmentName = "development" | "preview" | "production";

export type SupabaseTargetEnvironment = Readonly<{
  NEXT_PUBLIC_APP_ENV?: string;
  NODE_ENV?: string;
  SUPABASE_URL?: string;
  SUPABASE_EXPECTED_PROJECT_REF?: string;
}>;

export function resolveAppEnvironment(environment: Pick<SupabaseTargetEnvironment, "NEXT_PUBLIC_APP_ENV" | "NODE_ENV">): AppEnvironmentName {
  const explicit = environment.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase();
  if (explicit === "development" || explicit === "preview" || explicit === "production") return explicit;
  return environment.NODE_ENV === "development" ? "development" : "production";
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "host.docker.internal"]);

/**
 * Project ref of a Supabase API URL (`https://<ref>.supabase.co`) or a Postgres connection string
 * (`…@db.<ref>.supabase.co:5432/…` or pooler `postgres.<ref>:…@aws-0-…pooler.supabase.com`).
 * `"local"` for a local Supabase stack, undefined when it cannot be read.
 */
export function supabaseProjectRef(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host)) return "local";
  const poolerUser = /^postgres\.([a-z0-9]{20})$/u.exec(decodeURIComponent(url.username));
  if (poolerUser) return poolerUser[1];
  const hostRef = /^(?:db\.)?([a-z0-9]{20})\.supabase\.(?:co|com|in)$/u.exec(host);
  return hostRef?.[1];
}

export type SupabaseTargetCheck =
  | Readonly<{ ok: true; environment: AppEnvironmentName; projectRef: string | undefined }>
  | Readonly<{ ok: false; environment: AppEnvironmentName; projectRef: string | undefined; message: string }>;

/** Pure check used by the server client and by scripts/supabaseDevMigrate.ts. Never includes secrets in the message. */
export function checkSupabaseTarget(environment: SupabaseTargetEnvironment): SupabaseTargetCheck {
  const appEnvironment = resolveAppEnvironment(environment);
  const projectRef = supabaseProjectRef(environment.SUPABASE_URL);
  if (appEnvironment === "production") return { ok: true, environment: appEnvironment, projectRef };

  const fail = (message: string): SupabaseTargetCheck => ({ ok: false, environment: appEnvironment, projectRef, message });
  if (!projectRef) return fail(`Prostředí ${appEnvironment}: SUPABASE_URL není adresa Supabase projektu — nelze ověřit, kam aplikace zapisuje.`);
  if (KNOWN_PRODUCTION_SUPABASE_REFS.includes(projectRef)) {
    return fail(`Prostředí ${appEnvironment} míří na PRODUKČNÍ databázi (${projectRef}). Lokální vývoj smí používat jen DEV projekt — upravte SUPABASE_URL a SUPABASE_SECRET_KEY v .env.local (docs/DEV_PROD_SETUP.md).`);
  }
  if (projectRef === "local") return { ok: true, environment: appEnvironment, projectRef };
  const expected = environment.SUPABASE_EXPECTED_PROJECT_REF?.trim();
  if (!expected) return fail(`Prostředí ${appEnvironment}: chybí SUPABASE_EXPECTED_PROJECT_REF — uveďte v .env.local ref DEV projektu, aby šlo ověřit cílovou databázi.`);
  if (expected !== projectRef) return fail(`SUPABASE_URL míří na projekt ${projectRef}, ale SUPABASE_EXPECTED_PROJECT_REF je ${expected}. Sjednoťte .env.local.`);
  return { ok: true, environment: appEnvironment, projectRef };
}
