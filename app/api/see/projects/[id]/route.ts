import type { NextRequest } from "next/server.js";
import { requireViewerEditor } from "../../../../../lib/see/auth.server.ts";
import { createSeeDeps, type SeeDeps } from "../../../../../lib/see/backend.server.ts";
import { readJson, seeErrorResponse, seeJson } from "../../../../../lib/see/http.server.ts";
import { getEditorProject, saveEditorState } from "../../../../../lib/see/service.server.ts";

type Params = Readonly<{ id: string }>;

export async function handleSeeProjectGet(request: NextRequest, params: Params, depsFactory: () => SeeDeps = createSeeDeps) {
  const guard = await requireViewerEditor(request);
  if (guard.ok === false) return guard.response;
  try {
    return seeJson({ project: await getEditorProject(depsFactory(), params.id) });
  } catch (error) {
    return seeErrorResponse(error);
  }
}

export async function handleSeeProjectSave(request: NextRequest, params: Params, depsFactory: () => SeeDeps = createSeeDeps) {
  const guard = await requireViewerEditor(request);
  if (guard.ok === false) return guard.response;
  try {
    return seeJson({ project: await saveEditorState(depsFactory(), guard.actor, params.id, await readJson(request)) });
  } catch (error) {
    return seeErrorResponse(error);
  }
}

export async function GET(request: NextRequest, context: { params: Promise<Params> }) {
  return handleSeeProjectGet(request, await context.params);
}

export async function PUT(request: NextRequest, context: { params: Promise<Params> }) {
  return handleSeeProjectSave(request, await context.params);
}
