import type { NextRequest } from "next/server.js";
import { createSeeDeps, type SeeDeps } from "../../../../../../../lib/see/backend.server.ts";
import { grantTokens, seeErrorResponse, seeJson } from "../../../../../../../lib/see/http.server.ts";
import { publicFileUrl } from "../../../../../../../lib/see/service.server.ts";

type Params = Readonly<{ slug: string; fileId: string }>;

/**
 * PUBLIC. Every model/document request is authorized here again (publication, project status,
 * PIN grant, file belongs to the published snapshot) before a short-lived URL is issued.
 */
export async function handleSeePublicFile(request: NextRequest, params: Params, depsFactory: () => SeeDeps = createSeeDeps) {
  try {
    const result = await publicFileUrl(depsFactory(), params.slug, params.fileId, grantTokens(request), request.nextUrl.searchParams.get("download") === "1");
    if (result.ok === false) return seeJson({ error: "Soubor není dostupný.", manifest: result.manifest }, result.status, true);
    return seeJson({ url: result.url, expiresInSeconds: result.expiresInSeconds }, 200, true);
  } catch (error) {
    return seeErrorResponse(error, true);
  }
}

export async function GET(request: NextRequest, context: { params: Promise<Params> }) {
  return handleSeePublicFile(request, await context.params);
}
