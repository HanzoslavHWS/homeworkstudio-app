import { createHash, createHmac, pbkdf2, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

/**
 * HWS SEE server-side secrets handling. Nothing in here may be logged: PINs, grant tokens and
 * tickets are credentials.
 *
 * - PIN: numeric, 8–12 digits, stored only as PBKDF2-HMAC-SHA256 (600 000 iterations, OWASP 2023
 *   guidance for this PRF) with a per-PIN 16-byte salt. Node's built-in crypto, no native module,
 *   so it runs unchanged on Vercel / Node.
 * - Grant token: 32 random bytes, handed to the visitor once; only its SHA-256 is stored.
 * - Client / visitor keys: HMAC of the IP (and UA + day for visitors) with a key derived from
 *   APP_SESSION_SECRET — a raw IP is never stored.
 * - Ticket: short-lived HMAC-signed capability for one object (stream delivery / local dev storage).
 */

const pbkdf2Async = promisify(pbkdf2);

export const SEE_PIN_MIN_LENGTH = 8;
export const SEE_PIN_MAX_LENGTH = 12;
export const SEE_GENERATED_PIN_LENGTH = 8;
const PBKDF2_ITERATIONS = 600_000;
const PBKDF2_KEY_LENGTH = 32;

export class SeeSecretConfigurationError extends Error {
  constructor() {
    super("APP_SESSION_SECRET není nakonfigurovaný (min. 32 znaků) — HWS SEE nemůže podepisovat přístupy.");
    this.name = "SeeSecretConfigurationError";
  }
}

export function isValidPinFormat(value: unknown): value is string {
  return typeof value === "string" && new RegExp(`^[0-9]{${SEE_PIN_MIN_LENGTH},${SEE_PIN_MAX_LENGTH}}$`, "u").test(value);
}

/** Uniformly random digits from the CSPRNG (no modulo bias: randomInt is rejection-sampled). */
export function generatePin(length = SEE_GENERATED_PIN_LENGTH): string {
  let pin = "";
  for (let index = 0; index < length; index += 1) pin += String(randomInt(0, 10));
  return pin;
}

export async function hashPin(pin: string, iterations = PBKDF2_ITERATIONS): Promise<string> {
  if (!isValidPinFormat(pin)) throw new Error("PIN must be 8–12 digits.");
  const salt = randomBytes(16);
  const derived = await pbkdf2Async(pin, salt, iterations, PBKDF2_KEY_LENGTH, "sha256");
  return `pbkdf2_sha256$${iterations}$${salt.toString("base64url")}$${derived.toString("base64url")}`;
}

export async function verifyPin(pin: string, stored: string | undefined): Promise<boolean> {
  if (!stored || typeof pin !== "string" || !isValidPinFormat(pin)) return false;
  const [scheme, iterationsText, saltText, hashText, extra] = stored.split("$");
  const iterations = Number(iterationsText);
  if (scheme !== "pbkdf2_sha256" || extra !== undefined || !Number.isSafeInteger(iterations) || iterations < 100_000 || !saltText || !hashText) return false;
  const expected = Buffer.from(hashText, "base64url");
  const derived = await pbkdf2Async(pin, Buffer.from(saltText, "base64url"), iterations, expected.length, "sha256");
  return derived.length === expected.length && timingSafeEqual(derived, expected);
}

export function generateShareSlug(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let slug = "";
  for (let index = 0; index < 32; index += 1) slug += alphabet[randomInt(0, alphabet.length)];
  return slug;
}

export function generateGrantToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashGrantToken(token: string): string {
  return createHash("sha256").update(`hws-see-grant:${token}`).digest("hex");
}

export function isPlausibleGrantToken(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/u.test(value);
}

function derivedKey(secret: string | undefined, purpose: string): Buffer {
  if (typeof secret !== "string" || secret.length < 32) throw new SeeSecretConfigurationError();
  return createHmac("sha256", secret).update(`hws-see:${purpose}`).digest();
}

/** Hashed rate-limit key for one client (IP only; no UA so rotating the UA does not reset it). */
export function pinClientHash(ip: string, secret: string | undefined): string {
  return createHmac("sha256", derivedKey(secret, "pin-client")).update(ip).digest("hex").slice(0, 40);
}

/** Approximate unique visitor for one day; unlinkable across days, never reversible to an IP. */
export function visitorHash(ip: string, userAgent: string, day: string, secret: string | undefined): string {
  return createHmac("sha256", derivedKey(secret, "visitor")).update(`${day}|${ip}|${userAgent}`).digest("hex").slice(0, 40);
}

export type SeeTicketPayload = Readonly<{
  /** what: "get" = read one object, "put" = local dev upload */
  op: "get" | "put";
  key: string;
  fileId: string;
  /** public tickets re-check the publication epoch on every request */
  publicationId?: string;
  epoch?: number;
  mime: string;
  name?: string;
  attachment?: boolean;
  exp: number;
}>;

export function signTicket(payload: SeeTicketPayload, secret: string | undefined): string {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", derivedKey(secret, "ticket")).update(body).digest("base64url");
  return `${body}.${signature}`;
}

export function verifyTicket(ticket: unknown, secret: string | undefined, nowMs = Date.now()): SeeTicketPayload | undefined {
  if (typeof ticket !== "string" || ticket.length > 4096) return undefined;
  const [body, signature, extra] = ticket.split(".");
  if (!body || !signature || extra !== undefined) return undefined;
  // Compare the canonical text form: base64url decoding ignores the padding bits of the last
  // character, so several spellings would otherwise map to one signature (ticket malleability).
  const expected = Buffer.from(createHmac("sha256", derivedKey(secret, "ticket")).update(body).digest("base64url"));
  const given = Buffer.from(signature);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SeeTicketPayload;
    return typeof payload.exp === "number" && payload.exp > nowMs ? payload : undefined;
  } catch {
    return undefined;
  }
}

/** First address of X-Forwarded-For (set by Vercel/Cloudflare), else X-Real-IP, else a constant. */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || headers.get("x-real-ip")?.trim() || "unknown";
}

const BOT_PATTERN = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|headless|lighthouse|curl|wget|python-requests|httpclient/iu;

export function looksLikeBot(userAgent: string | null): boolean {
  return !userAgent || BOT_PATTERN.test(userAgent);
}
