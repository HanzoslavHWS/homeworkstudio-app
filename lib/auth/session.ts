export const AUTH_COOKIE_NAME = "homeworkstudio_session";
export const SESSION_TTL_SECONDS = 60 * 60 * 12;

type SessionPayload = {
  version: 1;
  expiresAt: number;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function isSessionSecretConfigured(
  secret: string | undefined,
): secret is string {
  return typeof secret === "string" && secret.length >= 32;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function sign(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return encodeBase64Url(new Uint8Array(signature));
}

function signaturesMatch(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
}

export async function createSessionToken(
  secret: string,
  nowMs = Date.now(),
): Promise<string> {
  if (!isSessionSecretConfigured(secret)) {
    throw new Error("APP_SESSION_SECRET must contain at least 32 characters");
  }
  const payload: SessionPayload = {
    version: 1,
    expiresAt: nowMs + SESSION_TTL_SECONDS * 1000,
  };
  const encodedPayload = encodeBase64Url(
    encoder.encode(JSON.stringify(payload)),
  );
  return `${encodedPayload}.${await sign(encodedPayload, secret)}`;
}

export async function verifySessionToken(
  token: string | undefined,
  secret: string | undefined,
  nowMs = Date.now(),
): Promise<boolean> {
  if (!token || !isSessionSecretConfigured(secret)) {
    return false;
  }
  const [encodedPayload, signature, extra] = token.split(".");
  if (!encodedPayload || !signature || extra) {
    return false;
  }

  try {
    const expectedSignature = await sign(encodedPayload, secret);
    if (!signaturesMatch(signature, expectedSignature)) {
      return false;
    }
    const payload = JSON.parse(
      decoder.decode(decodeBase64Url(encodedPayload)),
    ) as Partial<SessionPayload>;
    return (
      payload.version === 1 &&
      typeof payload.expiresAt === "number" &&
      payload.expiresAt > nowMs
    );
  } catch {
    return false;
  }
}

export function sessionCookieOptions() {
  return {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  };
}
