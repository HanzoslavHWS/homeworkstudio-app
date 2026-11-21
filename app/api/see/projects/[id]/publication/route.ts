import type { NextRequest } from "next/server.js";
import { requireViewerAdmin } from "../../../../../../lib/see/auth.server.ts";
import { createSeeDeps, type SeeDeps } from "../../../../../../lib/see/backend.server.ts";
import { readJson, seeErrorResponse, seeJson } from "../../../../../../lib/see/http.server.ts";
import { publicationAction } from "../../../../../../lib/see/service.server.ts";

type Params = Readonly<{ id: string }>;

/**
 * publish / unpublish / set-mode / new-pin / rotate-link. A newly set PIN is returned in THIS
 * response only (to be shown and copied once); afterwards only its hash exists.
 */
export async function handleSeePublication(request: NextRequest, params: Params, depsFactory: () => SeeDeps = createSeeDeps) {
  const guard = await requireViewerAdmin(request);
  if (guard.ok === false) return guard.response;
  try {
    const result = await publicationAction(depsFactory(), guard.actor, params.id, await readJson(request));
    return seeJson({ project: result.view, ...(result.pin ? { pin: result.pin } : {}), ...(result.warning ? { warning: result.warning } : {}) });
  } catch (error) {
    return seeErrorResponse(error);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<Params> }) {
  return handleSeePublication(request, await context.params);
}
