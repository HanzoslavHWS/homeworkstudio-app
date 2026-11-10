/**
 * First / emergency administrator (V1-AUTH-01, V1-AUTH-02) — a one-time, explicit step, never automatic.
 *
 *   npm run auth:dev:bootstrap-admin -- --email=<e-mail> --hws-admin --abf-admin                       (dry run)
 *   npm run auth:dev:bootstrap-admin -- --email=<e-mail> [--name="Jméno"] --hws-admin --abf-admin --apply --confirm=<dev-ref>
 *
 * Gives exactly the given e-mail the roles that are asked for, each named on its own:
 *   --hws-admin   správce HomeworkStudia (shared accounts and access; app_users.is_hws_admin)
 *   --abf-admin   role Správce in ABF Generator (app_memberships abf/admin)
 * An existing account keeps its id, password, other memberships and history and is (re)activated; a
 * missing one is created in Supabase Auth (admin.generateLink — NO e-mail is sent) and the one-time
 * set-password link is printed to this terminal only. An existing account gets a link only with
 * --link (its password changes only if the person uses it). Never promotes "the first user who signs
 * in" or all accounts, never stores or prints a password.
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
const flag = (name: string) => process.argv.includes(`--${name}`);
const apply = flag("apply");
const makeHwsAdmin = flag("hws-admin");
const makeAbfAdmin = flag("abf-admin");
const wantLink = flag("link");
const email = option("email")?.trim().toLowerCase();
const displayName = option("name")?.trim() || null;
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email)) {
  console.error("✖ Zadejte výslovně e-mail ověřené osoby: --email=<e-mail>. Skript nikoho nevybírá sám.");
  process.exit(1);
}
if (!makeHwsAdmin && !makeAbfAdmin) {
  console.error("✖ Řekněte výslovně, co má účet dostat: --hws-admin (správce HomeworkStudia) a/nebo --abf-admin (Správce v ABF).");
  process.exit(1);
}
if (apply && option("confirm") !== appRef) {
  console.error(`✖ Zápis vyžaduje --confirm=${appRef}.`);
  process.exit(1);
}

const { createScriptSupabaseClient } = await import("../lib/db/scriptSupabase.server.ts");
const client = createScriptSupabaseClient();

async function findAuthUser(target: string): Promise<{ id: string; email?: string } | undefined> {
  for (let page = 1; page < 50; page += 1) {
    const { data, error } = await client.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw error;
    const users = data.users as readonly { id: string; email?: string }[];
    const found = users.find((user) => user.email?.toLowerCase() === target);
    if (found) return found;
    if (users.length < 200) return undefined;
  }
  throw new Error("Příliš mnoho účtů v Supabase Auth — vyhledání přerušeno.");
}

const authUser = await findAuthUser(email);
const { data: profile, error: profileError } = authUser
  ? await client.from("app_users").select("id, is_active, is_hws_admin, app_memberships!app_memberships_user_id_fkey (app_key, role)").eq("id", authUser.id).maybeSingle()
  : { data: null, error: null };
if (profileError) throw profileError;
const current = profile as { is_active: boolean; is_hws_admin: boolean; app_memberships: { app_key: string; role: string }[] } | null;
const { data: hwsAdmins, error: hwsError } = await client.from("app_users").select("email").eq("is_hws_admin", true).eq("is_active", true);
if (hwsError) throw hwsError;

console.log(`Cíl: DEV ${appRef} · režim: ${apply ? "ZÁPIS" : "suchý běh (nic se nezapíše)"}`);
console.log(`E-mail: ${email}`);
console.log(`Účet Supabase Auth: ${authUser ? `existuje (${authUser.id}) — heslo zůstává` : "neexistuje — vznikne bez odeslání e-mailu"}`);
console.log(`Profil: ${current ? `${current.is_active ? "aktivní" : "deaktivovaný"}, správce HWS: ${current.is_hws_admin ? "ano" : "ne"}, aplikace: ${current.app_memberships.map((m) => `${m.app_key}=${m.role}`).join(", ") || "žádná"}` : "neexistuje — vznikne"}`);
console.log(`Aktivní správci HomeworkStudia teď: ${(hwsAdmins ?? []).length ? (hwsAdmins as { email: string }[]).map((admin) => admin.email).join(", ") : "žádný"}`);
console.log(`Změna: ${[makeHwsAdmin ? "správce HomeworkStudia" : "", makeAbfAdmin ? "Správce v ABF" : ""].filter(Boolean).join(" + ")}, účet aktivní`);
if (!apply) {
  console.log("\nSuchý běh — nic nebylo zapsáno. Pro zápis přidejte --apply --confirm=<ref DEV>.");
  process.exit(0);
}

const base = (process.env.APP_BASE_URL?.trim() || "http://localhost:3000").replace(/\/+$/u, "");
let userId = authUser?.id;
let link: string | undefined;
if (!userId || wantLink) {
  const type: "invite" | "recovery" = userId ? "recovery" : "invite";
  const { data, error } = await client.auth.admin.generateLink({ type, email, options: { redirectTo: `${base}/auth/callback` } });
  if (error || !data.user || !data.properties?.hashed_token) throw error ?? new Error("Odkaz se nepodařilo vytvořit.");
  userId = data.user.id;
  link = `${base}/auth/confirm?token_hash=${encodeURIComponent(data.properties.hashed_token)}&type=${type}`;
}
if (current) {
  const { error } = await client.from("app_users").update({ is_active: true, ...(makeHwsAdmin ? { is_hws_admin: true } : {}), ...(displayName ? { display_name: displayName } : {}) }).eq("id", userId);
  if (error) throw error;
} else {
  const { error } = await client.from("app_users").insert({ id: userId, email, display_name: displayName, is_hws_admin: makeHwsAdmin });
  if (error) throw error;
}
if (makeAbfAdmin) {
  const { error } = await client.from("app_memberships").upsert({ user_id: userId, app_key: "abf", role: "admin" }, { onConflict: "user_id,app_key" });
  if (error) throw error;
}
const { data: after, error: afterError } = await client.from("app_users").select("is_active, is_hws_admin, app_memberships!app_memberships_user_id_fkey (app_key, role)").eq("id", userId).single();
if (afterError) throw afterError;
const result = after as { is_active: boolean; is_hws_admin: boolean; app_memberships: { app_key: string; role: string }[] };
console.log(`\n✔ ${email} (${userId}): ${result.is_active ? "aktivní" : "NEAKTIVNÍ"}, správce HWS: ${result.is_hws_admin ? "ano" : "ne"}, aplikace: ${result.app_memberships.map((m) => `${m.app_key}=${m.role}`).join(", ") || "žádná"}`);
if (link) {
  console.log("Jednorázový odkaz pro nastavení hesla (nepřeposílejte, platí omezenou dobu):");
  console.log(link);
}
