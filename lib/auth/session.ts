/**
 * Signed session cookie (V1-AUTH-01). The cookie carries ONLY the session id, the user id and an
 * expiry, HMAC-signed with APP_SESSION_SECRET — never a role, an e-mail or a Supabase token. The
 * role and the active state are read from the database (app_users / app_sessions) on every
 * authorized request (lib/auth/requestAuth.ts), so a revoked session or a deactivated account stops
 * working immediately even though its cookie is still validly signed.
 *
 * verifySessionToken() (signature + expiry, no I/O) is the cheap first gate used by proxy.ts.
 */
export const AUTH_COOKIE_NAME = "homeworkstudio_session";
/** Idle lifetime: the cookie and the session row are extended while the user is active (lib/auth/requestAuth.ts). */
export const SESSION_TTL_SECONDS = 60 * 60 * 12;
/** Hard upper bound of one login, however active — then the user signs in again. */
export const SESSION_ABSOLUTE_TTL_SECONDS = 60 * 60 * 24 * 14;

export type SessionClaims = Readonly<{ sessionId: string; userId: string; expiresAt: number }>;

type SessionPayload = { version: 2; sid: string; uid: string; expiresAt: number };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isSessionSecretConfigured(secret: string | undefined): secret is string {
  return typeof secret === "string" && secret.length >= 32;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return encodeBase64Url(new Uint8Array(signature));
}

function signaturesMatch(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return mismatch === 0;
}

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export async function createSessionToken(secret: string, claims: Readonly<{ sessionId: string; userId: string; expiresAt: number }>): Promise<string> {
  if (!isSessionSecretConfigured(secret)) throw new Error("APP_SESSION_SECRET must contain at least 32 characters");
  if (!ID_PATTERN.test(claims.sessionId) || !ID_PATTERN.test(claims.userId)) throw new Error("Session token needs a session id and a user id.");
  const payload: SessionPayload = { version: 2, sid: claims.sessionId, uid: claims.userId, expiresAt: claims.expiresAt };
  const encodedPayload = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encodedPayload}.${await sign(encodedPayload, secret)}`;
}

/** Signature, shape and expiry — undefined for anything else (including the old v1 shared-password cookie). */
export async function readSessionToken(token: string | undefined, secret: string | undefined, nowMs = Date.now()): Promise<SessionClaims | undefined> {
  if (!token || !isSessionSecretConfigured(secret)) return undefined;
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra !== undefined) return undefined;
  try {
    if (!signaturesMatch(signature, await sign(encodedPayload, secret))) return undefined;
    const payload = JSON.parse(decoder.decode(decodeBase64Url(encodedPayload))) as Partial<SessionPayload>;
    if (payload.version !== 2 || typeof payload.sid !== "string" || typeof payload.uid !== "string" || !ID_PATTERN.test(payload.sid) || !ID_PATTERN.test(payload.uid)) return undefined;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt <= nowMs) return undefined;
    return { sessionId: payload.sid, userId: payload.uid, expiresAt: payload.expiresAt };
  } catch {
    return undefined;
  }
}

/** Cheap gate (no database): a validly signed, unexpired v2 cookie. Authorization is decided elsewhere. */
export async function verifySessionToken(token: string | undefined, secret: string | undefined, nowMs = Date.now()): Promise<boolean> {
  return (await readSessionToken(token, secret, nowMs)) !== undefined;
}

export function sessionCookieOptions(maxAgeSeconds = SESSION_TTL_SECONDS) {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: maxAgeSeconds,
  };
}

// ---------------------------------------------------------------------------------------------
// Password-setup grant: after a verified invitation / reset link, a short-lived signed cookie lets
// exactly that user set a password once. A different purpose than the session — never accepted as one.
// ---------------------------------------------------------------------------------------------
export const PASSWORD_SETUP_COOKIE_NAME = "homeworkstudio_password_setup";
export const PASSWORD_SETUP_TTL_SECONDS = 15 * 60;

type SetupPayload = { purpose: "password-setup"; uid: string; kind: "invite" | "recovery"; expiresAt: number };

export async function createPasswordSetupToken(secret: string, userId: string, kind: "invite" | "recovery", nowMs = Date.now()): Promise<string> {
  if (!isSessionSecretConfigured(secret)) throw new Error("APP_SESSION_SECRET must contain at least 32 characters");
  if (!ID_PATTERN.test(userId)) throw new Error("Password setup token needs a user id.");
  const payload: SetupPayload = { purpose: "password-setup", uid: userId, kind, expiresAt: nowMs + PASSWORD_SETUP_TTL_SECONDS * 1000 };
  const encoded = encodeBase64Url(encoder.encode(JSON.stringify(payload)));
  return `${encoded}.${await sign(`setup:${encoded}`, secret)}`;
}

export async function readPasswordSetupToken(token: string | undefined, secret: string | undefined, nowMs = Date.now()): Promise<Readonly<{ userId: string; kind: "invite" | "recovery" }> | undefined> {
  if (!token || !isSessionSecretConfigured(secret)) return undefined;
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return undefined;
  try {
    if (!signaturesMatch(signature, await sign(`setup:${encoded}`, secret))) return undefined;
    const payload = JSON.parse(decoder.decode(decodeBase64Url(encoded))) as Partial<SetupPayload>;
    if (payload.purpose !== "password-setup" || typeof payload.uid !== "string" || !ID_PATTERN.test(payload.uid) || (payload.kind !== "invite" && payload.kind !== "recovery")) return undefined;
    if (typeof payload.expiresAt !== "number" || payload.expiresAt <= nowMs) return undefined;
    return { userId: payload.uid, kind: payload.kind };
  } catch {
    return undefined;
  }
}
