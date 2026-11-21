import type { NextRequest } from "next/server.js";
import { requireViewerEditor } from "../../../../../../../lib/see/auth.server.ts";
import { createSeeDeps, type SeeDeps } from "../../../../../../../lib/see/backend.server.ts";
import { readJson, seeErrorResponse, seeJson } from "../../../../../../../lib/see/http.server.ts";
import { completeUpload } from "../../../../../../../lib/see/service.server.ts";

type Params = Readonly<{ id: string }>;

/** Server-side verification of an uploaded object (size + magic bytes) before it becomes usable. */
export async function handleSeeUploadComplete(request: NextRequest, params: Params, depsFactory: () => SeeDeps = createSeeDeps) {
  const guard = await requireViewerEditor(request);
  if (guard.ok === false) return guard.response;
  try {
    return seeJson({ project: await completeUpload(depsFactory(), guard.actor, params.id, await readJson(request)) });
  } catch (error) {
    return seeErrorResponse(error);
  }
}

export async function POST(request: NextRequest, context: { params: Promise<Params> }) {
  return handleSeeUploadComplete(request, await context.params);
}
