import type { NextRequest } from "next/server.js";
import { createSeeDeps, type SeeDeps } from "../../../../../../lib/see/backend.server.ts";
import { grantCookieOptions, readJson, SEE_GRANT_COOKIE, seeErrorResponse, seeJson } from "../../../../../../lib/see/http.server.ts";
import { clientIp } from "../../../../../../lib/see/security.server.ts";
import { unlockPublication } from "../../../../../../lib/see/service.server.ts";

type Params = Readonly<{ slug: string }>;

/** PUBLIC. Server-verified PIN → short-lived grant (HttpOnly cookie + in-memory header fallback). */
export async function handleSeePublicUnlock(request: NextRequest, params: Params, depsFactory: () => SeeDeps = createSeeDeps) {
  try {
    const deps = depsFactory();
    const result = await unlockPublication(deps, params.slug, await readJson(request), clientIp(request.headers));
    if (result.ok === false) {
      const response = seeJson({ error: result.error, ...(result.manifest ? { manifest: result.manifest } : {}) }, result.status, true);
      if (result.retryAfterSeconds) response.headers.set("Retry-After", String(result.retryAfterSeconds));
      return response;
    }
    const response = seeJson({ ok: true, grant: result.token, expiresAt: result.expiresAt }, 200, true);
    response.cookies.set(SEE_GRANT_COOKIE, result.token, grantCookieOptions(deps, params.slug));
    return response;
  } catch (error) {
    return seeErrorResponse(error, true);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<Params> }) {
  return handleSeePublicUnlock(request, await context.params);
}
