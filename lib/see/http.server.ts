import { NextResponse, type NextRequest } from "next/server.js";
import { SeeValidationError } from "../../domain/seeProject.ts";
import { SupabaseConfigurationError } from "../db/supabase.server.ts";
import { R2ConfigurationError } from "../storage/r2Config.ts";
import type { SeeDeps } from "./backend.server.ts";
import { SeeSecretConfigurationError } from "./security.server.ts";
import { SeeStorageUnavailableError } from "./storage.server.ts";

export const SEE_GRANT_COOKIE = "hws_see_grant";
export const SEE_GRANT_HEADER = "x-see-grant";

const NO_STORE = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };
const PUBLIC_HEADERS = { ...NO_STORE, "X-Robots-Tag": "noindex, nofollow, noarchive" };

export function seeJson(body: unknown, status = 200, publicRoute = false): NextResponse {
  return NextResponse.json(body, { status, headers: publicRoute ? PUBLIC_HEADERS : NO_STORE });
}

/** Maps errors to Czech messages; never echoes request bodies, PINs, tokens or storage keys. */
export function seeErrorResponse(error: unknown, publicRoute = false): NextResponse {
  if (error instanceof SeeValidationError) return seeJson({ error: error.message }, error.status, publicRoute);
  if (error instanceof SeeStorageUnavailableError) {
    // R2 / network outage: nothing was half-applied (see lib/see/service.server.ts), retry is safe.
    console.error("HWS SEE storage unavailable:", { name: (error as { cause?: { name?: unknown } }).cause?.name });
    const response = seeJson({ error: publicRoute ? "Prezentace je dočasně nedostupná, zkuste to prosím za chvíli." : error.message, code: "storage-unavailable" }, 503, publicRoute);
    response.headers.set("Retry-After", "30");
    return response;
  }
  if (error instanceof SupabaseConfigurationError || error instanceof R2ConfigurationError || error instanceof SeeSecretConfigurationError) {
    // Missing *variable names* only — no values. Public visitors get a generic message.
    return seeJson({ error: publicRoute ? "Prezentace je dočasně nedostupná." : error.message, code: "not-configured" }, 503, publicRoute);
  }
  const details = error && typeof error === "object" ? { name: (error as { name?: unknown }).name, code: (error as { code?: unknown }).code } : {};
  console.error("HWS SEE request failed:", details);
  return seeJson({ error: publicRoute ? "Prezentaci se nepodařilo načíst." : "Operaci HWS SEE se nepodařilo dokončit." }, 502, publicRoute);
}

/**
 * Every HWS SEE request with a body goes through here. Besides parsing it is the CSRF guard:
 * - the body must be declared as application/json (a cross-site HTML form can only send
 *   urlencoded / multipart / text/plain, and a cross-site fetch with JSON needs a CORS preflight
 *   that this API never grants);
 * - a browser-declared cross-site request (Sec-Fetch-Site) or a foreign Origin is refused.
 * The portal session cookie is SameSite=Lax as well, so this is defense in depth.
 */
export async function readJson(request: NextRequest): Promise<unknown> {
  assertSameOriginJson(request);
  try {
    return await request.json();
  } catch {
    throw new SeeValidationError("Neplatný JSON požadavek.");
  }
}

export function assertSameOriginJson(request: NextRequest): void {
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/json(\s*;|$)/iu.test(contentType)) throw new SeeValidationError("Požadavek musí být JSON.", 415);
  if (request.headers.get("sec-fetch-site") === "cross-site") throw new SeeValidationError("Požadavek z cizího webu byl odmítnut.", 403);
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      originHost = "";
    }
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? request.nextUrl.host;
    if (originHost !== host) throw new SeeValidationError("Požadavek z cizího webu byl odmítnut.", 403);
  }
}

export function grantTokens(request: NextRequest): readonly (string | undefined)[] {
  return [request.headers.get(SEE_GRANT_HEADER) ?? undefined, request.cookies.get(SEE_GRANT_COOKIE)?.value];
}

/**
 * Grant cookie scoped to the API of ONE share link. In production it is `SameSite=None; Secure;
 * Partitioned` so it also works inside a cross-site <iframe> where the browser allows partitioned
 * cookies; where third-party cookies are blocked entirely the viewer keeps the grant token in
 * memory and sends it in the x-see-grant header (same server check, never weaker).
 */
export function grantCookieOptions(deps: Pick<SeeDeps, "secureCookies" | "grantTtlMinutes">, slug: string) {
  return {
    httpOnly: true,
    secure: deps.secureCookies,
    sameSite: deps.secureCookies ? "none" as const : "lax" as const,
    ...(deps.secureCookies ? { partitioned: true } : {}),
    path: `/api/see/public/${slug}`,
    maxAge: deps.grantTtlMinutes * 60,
  };
}
