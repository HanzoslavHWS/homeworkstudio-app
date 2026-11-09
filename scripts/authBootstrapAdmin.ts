/**
 * First / emergency SPRÁVCE account (V1-AUTH-01) — a one-time, explicit step, never automatic.
 *
 *   npm run auth:dev:bootstrap-admin -- --email=<e-mail of the verified person>                       (dry run)
 *   npm run auth:dev:bootstrap-admin -- --email=<e-mail> [--name="Jméno"] --apply --confirm=<dev-ref>  (writes to DEV)
 *
 * Makes exactly the given e-mail an active admin: creates the Supabase Auth account if it does not
 * exist yet (admin.generateLink — NO e-mail is sent) and its app_users profile, or promotes an
 * existing profile. Then prints a one-time link (to this terminal only) with which the person sets
 * their own password. Never promotes "the first user who signs in" or all existing accounts, and
 * never stores or prints a password.
 *
 * Safety: DEV only (NEXT_PUBLIC_APP_ENV=development, SUPABASE_URL = SUPABASE_EXPECTED_PROJECT_REF,
 * never production; the database client is createScriptSupabaseClient).
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { KNOWN_PRODUCTION_SUPABASE_REFS, supabaseProjectRef } from "../lib/env/supabaseEnvironment.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
if (existsSync(`${root}.env.local`)) process.loadEnvFile(`${root}.env.local`);
const expectedRef = process.env.SUPABASE_EXPECTED_PROJECT_REF?.trim();
const appRef = supabaseProjectRef(process.env.SUPABASE_URL);
if (process.env.NEXT_PUBLIC_APP_ENV?.trim() !== "development" || !expectedRef || appRef !== expectedRef || KNOWN_PRODUCTION_SUPABASE_REFS.includes(appRef)) {
  console.error("✖ Skript běží jen proti DEV (NEXT_PUBLIC_APP_ENV=development, SUPABASE_URL = SUPABASE_EXPECTED_PROJECT_REF, ne produkce).");
  process.exit(1);
}
const option = (name: string) => process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = process.argv.includes("--apply");
const email = option("email")?.trim().toLowerCase();
const displayName = option("name")?.trim() || null;
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
  console.error("✖ Zadejte výslovně e-mail ověřené osoby: --email=<e-mail>. Skript nikoho nevybírá sám.");
  process.exit(1);
}
if (apply && option("confirm") !== appRef) {
  console.error(`✖ Zápis vyžaduje --confirm=${appRef}.`);
  process.exit(1);
}

const { createScriptSupabaseClient } = await import("../lib/db/scriptSupabase.server.ts");
const client = createScriptSupabaseClient();

async function findAuthUser(target: string): Promise<{ id: string; email?: string; last_sign_in_at?: string | null } | undefined> {
  for (let page = 1; page < 50; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data.users as readonly { id: string; email?: string; last_sign_in_at?: string | null }[];
    const found = users.find((user) => user.email?.toLowerCase() === target);
    if (found) return found;
    if (users.length < 200) return undefined;
  }
  throw new Error("Příliš mnoho účtů v Supabase Auth — vyhledání přerušeno.");
}

const authUser = await findAuthUser(email);
const { data: profile, error: profileError } = authUser ? await client.from("app_users").select("id, role, is_active").eq("id", authUser.id).maybeSingle() : { data: null, error: null };
if (profileError) throw profileError;
const { data: admins, error: adminsError } = await client.from("app_users").select("email").eq("role", "admin").eq("is_active", true);
if (adminsError) throw adminsError;

console.log(`Cíl: DEV ${appRef} · režim: ${apply ? "ZÁPIS" : "suchý běh (nic se nezapíše)"}`);
console.log(`E-mail: ${email}`);
console.log(`Účet Supabase Auth: ${authUser ? `existuje (${authUser.id})` : "neexistuje — vznikne bez odeslání e-mailu"}`);
console.log(`Profil aplikace: ${profile ? `${(profile as { role: string }).role}, ${(profile as { is_active: boolean }).is_active ? "aktivní" : "deaktivovaný"}` : "neexistuje — vznikne jako Správce"}`);
console.log(`Aktivní správci teď: ${(admins ?? []).length ? (admins as { email: string }[]).map((admin) => admin.email).join(", ") : "žádný"}`);
if (!apply) {
  console.log("\nSuchý běh — nic nebylo zapsáno. Pro zápis přidejte --apply --confirm=<ref DEV>.");
} else {
  const base = (process.env.APP_BASE_URL?.trim() || "http://localhost:3000").replace(/\/+$/u, "");
  const type: "invite" | "recovery" = authUser ? "recovery" : "invite";
  const { data: link, error: linkError } = await client.auth.admin.generateLink({ type, email, options: { redirectTo: `${base}/auth/callback` } });
  if (linkError || !link.user || !link.properties?.hashed_token) throw linkError ?? new Error("Odkaz se nepodařilo vytvořit.");
  const userId = link.user.id;
  if (profile) {
    const { error } = await client.from("app_users").update({ role: "admin", is_active: true, ...(displayName ? { display_name: displayName } : {}) }).eq("id", userId);
    if (error) throw error;
  } else {
    const { error } = await client.from("app_users").insert({ id: userId, email, display_name: displayName, role: "admin" });
    if (error) throw error;
  }
  console.log(`\n✔ ${email} je aktivní Správce (${userId}).`);
  console.log("Jednorázový odkaz pro nastavení hesla (nepřeposílejte, platí omezenou dobu):");
  console.log(`${base}/auth/confirm?token_hash=${encodeURIComponent(link.properties.hashed_token)}&type=${type}`);
}
