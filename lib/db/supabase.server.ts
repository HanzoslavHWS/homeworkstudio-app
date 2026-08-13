import { createClient, type SupabaseClient } from "@supabase/supabase-js";

export type SupabaseEnvironment = Readonly<{
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
}>;

export class SupabaseConfigurationError extends Error {
  readonly missingVariables: readonly string[];

  constructor(missingVariables: readonly string[]) {
    super(`Supabase není nakonfigurováno. Chybí: ${missingVariables.join(", ")}.`);
    this.name = "SupabaseConfigurationError";
    this.missingVariables = missingVariables;
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
}): SupabaseClient {
  const missing = (["SUPABASE_URL", "SUPABASE_SECRET_KEY"] as const).filter((name) => !environment[name]?.trim());
  if (missing.length) throw new SupabaseConfigurationError(missing);
  return createClient(environment.SUPABASE_URL!.trim(), environment.SUPABASE_SECRET_KEY!.trim(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
