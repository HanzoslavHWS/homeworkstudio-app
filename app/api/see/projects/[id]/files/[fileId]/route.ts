import type { NextRequest } from "next/server.js";
import { requireViewerEditor } from "../../../../../../../lib/see/auth.server.ts";
import { createSeeDeps, type SeeDeps } from "../../../../../../../lib/see/backend.server.ts";
import { seeErrorResponse, seeJson } from "../../../../../../../lib/see/http.server.ts";
import { editorFileUrl } from "../../../../../../../lib/see/service.server.ts";

type Params = Readonly<{ id: string; fileId: string }>;

/** Working preview: a short-lived URL for one file of the project (logged-in editors only). */
export async function handleSeeEditorFile(request: NextRequest, params: Params, depsFactory: () => SeeDeps = createSeeDeps) {
  const guard = await requireViewerEditor(request);
  if (guard.ok === false) return guard.response;
  try {
    return seeJson(await editorFileUrl(depsFactory(), params.id, params.fileId, request.nextUrl.searchParams.get("download") === "1"));
  } catch (error) {
    return seeErrorResponse(error);
  }
}

export async function GET(request: NextRequest, context: { params: Promise<Params> }) {
  return handleSeeEditorFile(request, await context.params);
}
