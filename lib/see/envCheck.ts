/**
 * HWS SEE deployment check of environment variables (scripts/hwsSeeEnvCheck.ts). Pure and OFFLINE:
 * it validates presence and format only, never connects to Supabase / R2 and never prints a secret
 * value (only "nastaveno (N znaků)").
 */
import { isValidEmbedOrigin } from "../../domain/seeEmbed.ts";

export type SeeEnvTarget = "production" | "preview" | "development";
export type SeeEnvLevel = "ok" | "warn" | "error";
export type SeeEnvFinding = Readonly<{ level: SeeEnvLevel; variable: string; message: string }>;

type Env = Readonly<Record<string, string | undefined>>;

const SECRET_NAMES = ["APP_LOGIN_PASSWORD", "APP_SESSION_SECRET", "SUPABASE_SECRET_KEY", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"];

function present(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function describeSecret(value: string): string {
  return `nastaveno (${value.length} znaků)`;
}

/** Decodes only the `role` claim of a legacy Supabase JWT key, to catch an anon key used by mistake. */
function jwtRole(value: string): string | undefined {
  const parts = value.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const json = JSON.parse(Buffer.from(parts[1].replace(/-/gu, "+").replace(/_/gu, "/"), "base64").toString("utf8")) as { role?: unknown };
    return typeof json.role === "string" ? json.role : undefined;
  } catch {
    return undefined;
  }
}

function numberInRange(value: string | undefined, min: number, max: number): boolean {
  if (!present(value)) return true;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max;
}

export function checkSeeEnvironment(env: Env, target: SeeEnvTarget): readonly SeeEnvFinding[] {
  const findings: SeeEnvFinding[] = [];
  const ok = (variable: string, message: string) => findings.push({ level: "ok", variable, message });
  const warn = (variable: string, message: string) => findings.push({ level: "warn", variable, message });
  const error = (variable: string, message: string) => findings.push({ level: "error", variable, message });
  const deployed = target !== "development";

  // ── existing portal login (unchanged, only verified) ──
  if (!present(env.APP_LOGIN_PASSWORD)) error("APP_LOGIN_PASSWORD", "chybí — portálový login nebude fungovat");
  else if (env.APP_LOGIN_PASSWORD.length < 12) warn("APP_LOGIN_PASSWORD", `${describeSecret(env.APP_LOGIN_PASSWORD)} — doporučeno alespoň 12 znaků`);
  else ok("APP_LOGIN_PASSWORD", describeSecret(env.APP_LOGIN_PASSWORD));
  if (!present(env.APP_SESSION_SECRET)) error("APP_SESSION_SECRET", "chybí — session, PIN rate-limit i tickety HWS SEE ji potřebují");
  else if (env.APP_SESSION_SECRET.length < 32) error("APP_SESSION_SECRET", `${describeSecret(env.APP_SESSION_SECRET)} — musí mít alespoň 32 znaků`);
  else ok("APP_SESSION_SECRET", describeSecret(env.APP_SESSION_SECRET));

  // ── local dev mode must never reach a deployment ──
  if (env.SEE_BACKEND === "local") {
    if (deployed) error("SEE_BACKEND", "\"local\" patří jen na vývojářský počítač — ve Vercelu proměnnou odstraňte");
    else ok("SEE_BACKEND", "local (data v .see-local/, Supabase ani R2 se nepoužijí)");
  } else if (present(env.SEE_BACKEND)) {
    error("SEE_BACKEND", "neznámá hodnota — ponechte prázdné (produkce) nebo \"local\" (jen vývoj)");
  }
  const localOnly = env.SEE_BACKEND === "local" && !deployed;

  // ── Supabase ──
  if (!localOnly) {
    if (!present(env.SUPABASE_URL)) error("SUPABASE_URL", "chybí");
    else if (!/^https:\/\//u.test(env.SUPABASE_URL)) error("SUPABASE_URL", "musí začínat https://");
    else if (!/^https:\/\/[a-z0-9]{10,40}\.supabase\.co\/?$/u.test(env.SUPABASE_URL)) warn("SUPABASE_URL", `${env.SUPABASE_URL} — neobvyklý tvar (čekáno https://<projekt>.supabase.co)`);
    else ok("SUPABASE_URL", env.SUPABASE_URL);
    if (!present(env.SUPABASE_SECRET_KEY)) error("SUPABASE_SECRET_KEY", "chybí (server-only service role / secret key)");
    else if (env.SUPABASE_SECRET_KEY.startsWith("sb_publishable_") || jwtRole(env.SUPABASE_SECRET_KEY) === "anon") error("SUPABASE_SECRET_KEY", "vypadá jako veřejný (anon/publishable) klíč — server potřebuje secret/service-role klíč");
    else ok("SUPABASE_SECRET_KEY", describeSecret(env.SUPABASE_SECRET_KEY));
  }

  // ── Cloudflare R2 ──
  if (!localOnly) {
    if (!present(env.R2_ACCOUNT_ID)) error("R2_ACCOUNT_ID", "chybí");
    else if (!/^[0-9a-f]{32}$/u.test(env.R2_ACCOUNT_ID)) warn("R2_ACCOUNT_ID", "neobvyklý tvar (čekáno 32 hexadecimálních znaků)");
    else ok("R2_ACCOUNT_ID", "nastaveno");
    for (const name of ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"] as const) {
      if (!present(env[name])) error(name, "chybí");
      else ok(name, describeSecret(env[name]!));
    }
    if (!present(env.R2_ENDPOINT)) error("R2_ENDPOINT", "chybí");
    else if (!/^https:\/\//u.test(env.R2_ENDPOINT)) error("R2_ENDPOINT", "musí začínat https://");
    else if (present(env.R2_ACCOUNT_ID) && !env.R2_ENDPOINT.includes(env.R2_ACCOUNT_ID)) warn("R2_ENDPOINT", "neobsahuje R2_ACCOUNT_ID — ověřte, že míří na správný účet");
    else ok("R2_ENDPOINT", "nastaveno");
    const bucketPattern = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u;
    if (!present(env.R2_BUCKET_NAME)) error("R2_BUCKET_NAME", "chybí (sdílený bucket portálu)");
    else if (!bucketPattern.test(env.R2_BUCKET_NAME)) error("R2_BUCKET_NAME", "neplatný název bucketu");
    else ok("R2_BUCKET_NAME", env.R2_BUCKET_NAME);
    if (!present(env.SEE_R2_BUCKET_NAME)) warn("SEE_R2_BUCKET_NAME", `nenastaveno — HWS SEE použije sdílený bucket s prefixem "${env.SEE_R2_PREFIX || "hws-see"}/" (doporučen samostatný bucket hws-see-*)`);
    else if (!bucketPattern.test(env.SEE_R2_BUCKET_NAME)) error("SEE_R2_BUCKET_NAME", "neplatný název bucketu");
    else ok("SEE_R2_BUCKET_NAME", env.SEE_R2_BUCKET_NAME);
  }
  if (present(env.SEE_R2_PREFIX) && !/^[a-z0-9][a-z0-9-]{0,40}$/u.test(env.SEE_R2_PREFIX.replace(/^\/+|\/+$/gu, ""))) error("SEE_R2_PREFIX", "jen malá písmena, číslice a pomlčky");

  // ── HWS SEE tuning ──
  if (!numberInRange(env.SEE_MAX_MODEL_MB, 1, 1000)) error("SEE_MAX_MODEL_MB", "číslo 1–1000");
  if (!numberInRange(env.SEE_MAX_DOCUMENT_MB, 1, 500)) error("SEE_MAX_DOCUMENT_MB", "číslo 1–500");
  if (!numberInRange(env.SEE_FILE_URL_TTL_SECONDS, 30, 300)) error("SEE_FILE_URL_TTL_SECONDS", "číslo 30–300 (s)");
  if (!numberInRange(env.SEE_PIN_GRANT_TTL_MINUTES, 5, 720)) error("SEE_PIN_GRANT_TTL_MINUTES", "číslo 5–720 (min)");
  if (present(env.SEE_FILE_DELIVERY) && !["signed-url", "stream", "hybrid"].includes(env.SEE_FILE_DELIVERY)) error("SEE_FILE_DELIVERY", "signed-url | stream | hybrid");
  else if (env.SEE_FILE_DELIVERY === "stream" || env.SEE_FILE_DELIVERY === "hybrid") warn("SEE_FILE_DELIVERY", `${env.SEE_FILE_DELIVERY} — bajty jdou přes Vercel funkce; ověřte limity velikosti odpovědi a náklady na Preview`);
  else ok("SEE_FILE_DELIVERY", env.SEE_FILE_DELIVERY || "signed-url (výchozí)");
  if (present(env.SEE_REKEY_ON_REVOKE) && !["true", "false"].includes(env.SEE_REKEY_ON_REVOKE)) error("SEE_REKEY_ON_REVOKE", "true | false");
  else if (env.SEE_REKEY_ON_REVOKE === "false") warn("SEE_REKEY_ON_REVOKE", "vypnuto — již vydané odkazy po zrušení přístupu platí ještě do vypršení TTL");
  else ok("SEE_REKEY_ON_REVOKE", "zapnuto (okamžité zneplatnění vydaných odkazů)");
  if (present(env.SEE_EMBED_FRAME_ANCESTORS)) {
    const tokens = env.SEE_EMBED_FRAME_ANCESTORS.split(/\s+/u).filter(Boolean);
    const invalid = tokens.filter((token) => token !== "'self'" && token !== "https:" && !isValidEmbedOrigin(token.toLowerCase()));
    if (invalid.length) error("SEE_EMBED_FRAME_ANCESTORS", `neplatné položky: ${invalid.join(" ")}`);
    else if (deployed && tokens.some((token) => token.startsWith("http://"))) warn("SEE_EMBED_FRAME_ANCESTORS", "obsahuje http://localhost — na Vercelu nepotřebné");
    else ok("SEE_EMBED_FRAME_ANCESTORS", tokens.join(" "));
  } else {
    ok("SEE_EMBED_FRAME_ANCESTORS", "nenastaveno → výchozí politika 'self' https: (každá prezentace ji může zúžit)");
  }

  // ── secrets must never be exposed to the browser bundle ──
  for (const name of Object.keys(env)) {
    if (name.startsWith("NEXT_PUBLIC_") && SECRET_NAMES.some((secret) => name.includes(secret) || name.includes(secret.replace(/^APP_/u, "")))) {
      error(name, "tajná hodnota s prefixem NEXT_PUBLIC_ by se dostala do prohlížeče — odstraňte");
    }
  }
  return findings;
}

export function formatSeeEnvReport(findings: readonly SeeEnvFinding[], target: SeeEnvTarget): string {
  const icon = { ok: "✓", warn: "⚠", error: "✗" } as const;
  const lines = [`HWS SEE – kontrola proměnných prostředí (cíl: ${target})`, ""];
  for (const finding of findings) lines.push(`${icon[finding.level]} ${finding.variable}: ${finding.message}`);
  const errors = findings.filter((finding) => finding.level === "error").length;
  const warnings = findings.filter((finding) => finding.level === "warn").length;
  lines.push("", errors ? `Výsledek: ${errors} chyb, ${warnings} upozornění — NASAZENÍ NENÍ PŘIPRAVENO.` : `Výsledek: bez chyb, ${warnings} upozornění.`);
  return lines.join("\n");
}
