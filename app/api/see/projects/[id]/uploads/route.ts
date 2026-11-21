import type { NextRequest } from "next/server.js";
import { requireViewerEditor } from "../../../../../../lib/see/auth.server.ts";
import { createSeeDeps, type SeeDeps } from "../../../../../../lib/see/backend.server.ts";
import { readJson, seeErrorResponse, seeJson } from "../../../../../../lib/see/http.server.ts";
import { prepareUpload } from "../../../../../../lib/see/service.server.ts";

type Params = Readonly<{ id: string }>;

/** Validates type/size/permission and returns a short-lived presigned PUT for one new file. */
export async function handleSeeUploadPrepare(request: NextRequest, params: Params, depsFactory: () => SeeDeps = createSeeDeps) {
  const guard = await requireViewerEditor(request);
  if (guard.ok === false) return guard.response;
  try {
    return seeJson(await prepareUpload(depsFactory(), guard.actor, params.id, await readJson(request)), 201);
  } catch (error) {
    return seeErrorResponse(error);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<Params> }) {
  return handleSeeUploadPrepare(request, await context.params);
}
