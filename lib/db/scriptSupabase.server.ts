import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { checkScriptDatabaseTarget, type ScriptDatabaseEnvironment } from "../env/supabaseEnvironment.ts";

/**
 * The only Supabase client the scripts in scripts/ may use (docs/DEV_DATA_IMPORT_PLAN.md).
 *
 * Why not createSupabaseServerClient: the app treats "no NEXT_PUBLIC_APP_ENV, no NODE_ENV" as
 * production with no restriction (that is Vercel). A plain `node scripts/x.ts` run looks exactly
 * like that, so a shell holding production credentials would write to production unchecked.
 *
 * Here:
 *   - the environment is resolved the same way for every script — the shell plus the repository's
 *     .env.local — and a variable that two sources (or two lines of .env.local) set differently
 *     is a refusal, not "last one wins";
 *   - checkScriptDatabaseTarget refuses any production ref and any ref other than
 *     SUPABASE_EXPECTED_PROJECT_REF; there is deliberately no override flag or variable;
 *   - every client built here is registered, and the import writers refuse any other client
 *     (assertScriptDatabaseClient), so a write can't happen through an unchecked client either.
 */

export class ScriptDatabaseTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScriptDatabaseTargetError";
  }
}

const GUARDED_VARIABLES = ["NEXT_PUBLIC_APP_ENV", "SUPABASE_URL", "SUPABASE_SECRET_KEY", "SUPABASE_EXPECTED_PROJECT_REF"] as const;
type GuardedVariable = (typeof GUARDED_VARIABLES)[number];

/** Values of one variable across all lines of an env file that define it (comments ignored). */
function envFileValues(envFileText: string, name: GuardedVariable): string[] {
  const values: string[] = [];
  for (const line of envFileText.split(/\r?\n/u)) {
    if (!new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`, "u").test(line)) continue;
    values.push((parseEnv(line)[name] ?? "").trim());
  }
  return values;
}

/**
 * Pure: merges the process environment with the text of .env.local. A variable defined twice
 * with different values — in the file, or in the shell and the file — is an error naming the
 * variable (never its value, which may be a secret).
 */
export function resolveScriptEnvironment(processEnvironment: Readonly<Record<string, string | undefined>>, envFileText: string | undefined): ScriptDatabaseEnvironment {
  const resolved: Partial<Record<GuardedVariable, string>> = {};
  for (const name of GUARDED_VARIABLES) {
    const fileValues = envFileText === undefined ? [] : envFileValues(envFileText, name);
    if (new Set(fileValues).size > 1) throw new ScriptDatabaseTargetError(`Skript odmítl připojení k databázi: ${name} je v .env.local definovaná vícekrát s různými hodnotami.`);
    const fileValue = fileValues[0];
    const shellValue = processEnvironment[name]?.trim();
    if (shellValue && fileValue && shellValue !== fileValue) {
      throw new ScriptDatabaseTargetError(`Skript odmítl připojení k databázi: ${name} má v prostředí shellu jinou hodnotu než v .env.local — není jasné, kam zapisovat.`);
    }
    const value = shellValue || fileValue;
    if (value) resolved[name] = value;
  }
  return resolved;
}

const ENV_FILE = new URL("../../.env.local", import.meta.url);

export function loadScriptEnvironment(): ScriptDatabaseEnvironment {
  return resolveScriptEnvironment(process.env, existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : undefined);
}

const verifiedClients = new WeakSet<object>();

export type ScriptDatabaseClientOptions = Readonly<{
  /** Tests only: an explicit environment instead of shell + .env.local. */
  environment?: ScriptDatabaseEnvironment;
  /** Tests only: builds a fake client — it is registered only after the same target check. */
  createClient?: (url: string, secretKey: string) => SupabaseClient;
}>;

/** Checks the target BEFORE building the client; throws ScriptDatabaseTargetError on any doubt. */
export function createScriptSupabaseClient(options: ScriptDatabaseClientOptions = {}): SupabaseClient {
  const environment = options.environment ?? loadScriptEnvironment();
  const target = checkScriptDatabaseTarget(environment);
  if (target.ok === false) throw new ScriptDatabaseTargetError(target.message);
  const url = environment.SUPABASE_URL!.trim();
  const secretKey = environment.SUPABASE_SECRET_KEY!.trim();
  const client = options.createClient
    ? options.createClient(url, secretKey)
    : createClient(url, secretKey, { auth: { persistSession: false, autoRefreshToken: false } });
  verifiedClients.add(client);
  if (!options.createClient) console.log(`Databáze: DEV projekt ${target.projectRef} (ověřeno proti SUPABASE_EXPECTED_PROJECT_REF, produkce blokována).`);
  return client;
}

/** First line of every import/repair writer: refuses a client that did not pass the script target check. */
export function assertScriptDatabaseClient(client: unknown): void {
  if (typeof client !== "object" || client === null || !verifiedClients.has(client)) {
    throw new ScriptDatabaseTargetError("Zápis odmítnut: klient databáze nebyl vytvořen přes createScriptSupabaseClient (kontrola cílového projektu neproběhla).");
  }
}
