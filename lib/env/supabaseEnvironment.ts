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

export type ScriptDatabaseEnvironment = Readonly<{
  NEXT_PUBLIC_APP_ENV?: string;
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_EXPECTED_PROJECT_REF?: string;
}>;

export type ScriptDatabaseTargetCheck = Readonly<{ ok: true; projectRef: string }> | Readonly<{ ok: false; message: string }>;

const PROJECT_REF_PATTERN = /^[a-z0-9]{20}$/u;

/**
 * Stricter sibling of checkSupabaseTarget for the scripts in scripts/ (imports, canonicalization,
 * repairs). Unlike the app it has NO production branch: a script never writes to a production
 * project, whatever NEXT_PUBLIC_APP_ENV, NODE_ENV or command-line flags say. Everything must be
 * stated explicitly — a missing or unreadable value is a refusal, never a default.
 * Never includes the secret key in a message.
 */
export function checkScriptDatabaseTarget(environment: ScriptDatabaseEnvironment): ScriptDatabaseTargetCheck {
  const fail = (message: string): ScriptDatabaseTargetCheck => ({ ok: false, message: `Skript odmítl připojení k databázi: ${message}` });
  const appEnvironment = environment.NEXT_PUBLIC_APP_ENV?.trim().toLowerCase();
  if (appEnvironment !== "development" && appEnvironment !== "preview") {
    return fail(`NEXT_PUBLIC_APP_ENV musí být výslovně „development“ nebo „preview“ (je „${environment.NEXT_PUBLIC_APP_ENV?.trim() ?? ""}“). Skripty do produkce nezapisují.`);
  }
  const expected = environment.SUPABASE_EXPECTED_PROJECT_REF?.trim();
  if (!expected) return fail("chybí SUPABASE_EXPECTED_PROJECT_REF (ref DEV projektu).");
  if (!PROJECT_REF_PATTERN.test(expected)) return fail(`SUPABASE_EXPECTED_PROJECT_REF „${expected}“ není platný project ref (20 znaků a–z, 0–9).`);
  if (KNOWN_PRODUCTION_SUPABASE_REFS.includes(expected)) return fail(`SUPABASE_EXPECTED_PROJECT_REF je PRODUKČNÍ projekt ${expected}.`);
  if (!environment.SUPABASE_URL?.trim()) return fail("chybí SUPABASE_URL.");
  const projectRef = supabaseProjectRef(environment.SUPABASE_URL);
  if (!projectRef || projectRef === "local") return fail("SUPABASE_URL není adresa Supabase projektu (https://<ref>.supabase.co) — nelze ověřit cíl.");
  if (KNOWN_PRODUCTION_SUPABASE_REFS.includes(projectRef)) return fail(`SUPABASE_URL míří na PRODUKČNÍ projekt ${projectRef}.`);
  if (projectRef !== expected) return fail(`SUPABASE_URL míří na projekt ${projectRef}, ale SUPABASE_EXPECTED_PROJECT_REF je ${expected}.`);
  if (!environment.SUPABASE_SECRET_KEY?.trim()) return fail("chybí SUPABASE_SECRET_KEY.");
  return { ok: true, projectRef };
}
