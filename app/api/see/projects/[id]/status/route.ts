import type { NextRequest } from "next/server.js";
import { requireViewerAdmin } from "../../../../../../lib/see/auth.server.ts";
import { createSeeDeps, type SeeDeps } from "../../../../../../lib/see/backend.server.ts";
import { readJson, seeErrorResponse, seeJson } from "../../../../../../lib/see/http.server.ts";
import { changeProjectStatus } from "../../../../../../lib/see/service.server.ts";

type Params = Readonly<{ id: string }>;

/** Pozastavit / Obnovit / Archivovat / Smazat (soft). Non-active immediately blocks public access. */
export async function handleSeeProjectStatus(request: NextRequest, params: Params, depsFactory: () => SeeDeps = createSeeDeps) {
  const guard = await requireViewerAdmin(request);
  if (guard.ok === false) return guard.response;
  try {
    return seeJson(await changeProjectStatus(depsFactory(), guard.actor, params.id, await readJson(request)));
  } catch (error) {
    return seeErrorResponse(error);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<Params> }) {
  return handleSeeProjectStatus(request, await context.params);
}
