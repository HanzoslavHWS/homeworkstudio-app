import type { NextRequest } from "next/server.js";
import { createSeeDeps, type SeeDeps } from "../../../../../lib/see/backend.server.ts";
import { grantTokens, seeErrorResponse, seeJson } from "../../../../../lib/see/http.server.ts";
import { publicManifest } from "../../../../../lib/see/service.server.ts";

type Params = Readonly<{ slug: string }>;

/**
 * PUBLIC (no portal login; exempted in proxy.ts). Returns the published snapshot only when the
 * publication is live, the project active and — for `pin` — a valid server-side grant is presented.
 * Before that, nothing about the content is returned (not even the project name).
 */
export async function handleSeePublicManifest(request: NextRequest, params: Params, depsFactory: () => SeeDeps = createSeeDeps) {
  try {
    const result = await publicManifest(depsFactory(), params.slug, grantTokens(request));
    return seeJson(result.manifest, result.status, true);
  } catch (error) {
    return seeErrorResponse(error, true);
  }
}

export async function GET(request: NextRequest, context: { params: Promise<Params> }) {
  return handleSeePublicManifest(request, await context.params);
}
