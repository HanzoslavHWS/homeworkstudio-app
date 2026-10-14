import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { checkSupabaseTarget, type SupabaseTargetEnvironment } from "../env/supabaseEnvironment.ts";

export type SupabaseEnvironment = Readonly<{
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
}> & Omit<SupabaseTargetEnvironment, "SUPABASE_URL">;

export class SupabaseConfigurationError extends Error {
  readonly missingVariables: readonly string[];

  constructor(missingVariables: readonly string[], message?: string) {
    super(message ?? `Supabase není nakonfigurováno. Chybí: ${missingVariables.join(", ")}.`);
    this.name = "SupabaseConfigurationError";
    this.missingVariables = missingVariables;
  }
}

/**
 * Local development / preview pointed at a production or unverified database
 * (lib/env/supabaseEnvironment.ts). A configuration error, so every route answers 503 with this
 * message instead of touching the database.
 */
export class SupabaseEnvironmentGuardError extends SupabaseConfigurationError {
  constructor(message: string) {
    super([], message);
    this.name = "SupabaseEnvironmentGuardError";
  }
}

/**
 * Server-only. SUPABASE_SECRET_KEY is a service-role key that bypasses RLS — it must
 * never reach the browser bundle (no NEXT_PUBLIC_ prefix, never logged, never returned in
 * an API response). Browsers talk to Postgres exclusively through our own authenticated
 * Next.js API routes, which use this client — never directly.
 */
export function createSupabaseServerClient(environment: SupabaseEnvironment = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_SECRET_KEY: process.env.SUPABASE_SECRET_KEY,
  NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
  NODE_ENV: process.env.NODE_ENV,
  SUPABASE_EXPECTED_PROJECT_REF: process.env.SUPABASE_EXPECTED_PROJECT_REF,
}): SupabaseClient {
  const missing = (["SUPABASE_URL", "SUPABASE_SECRET_KEY"] as const).filter((name) => !environment[name]?.trim());
  if (missing.length) throw new SupabaseConfigurationError(missing);
  const target = checkSupabaseTarget(environment);
  if (target.ok === false) throw new SupabaseEnvironmentGuardError(target.message);
  return createClient(environment.SUPABASE_URL!.trim(), environment.SUPABASE_SECRET_KEY!.trim(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
