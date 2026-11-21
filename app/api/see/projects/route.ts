import type { NextRequest } from "next/server.js";
import { requireViewerEditor } from "../../../../lib/see/auth.server.ts";
import { createSeeDeps, type SeeDeps } from "../../../../lib/see/backend.server.ts";
import { readJson, seeErrorResponse, seeJson } from "../../../../lib/see/http.server.ts";
import { createProject, listProjects, parseListQuery } from "../../../../lib/see/service.server.ts";

export async function handleSeeProjectList(request: NextRequest, depsFactory: () => SeeDeps = createSeeDeps) {
  const guard = await requireViewerEditor(request);
  if (guard.ok === false) return guard.response;
  try {
    const deps = depsFactory();
    return seeJson({ ...(await listProjects(deps, parseListQuery(request.nextUrl.searchParams))), backend: deps.backend });
  } catch (error) {
    return seeErrorResponse(error);
  }
}

export async function handleSeeProjectCreate(request: NextRequest, depsFactory: () => SeeDeps = createSeeDeps) {
  const guard = await requireViewerEditor(request);
  if (guard.ok === false) return guard.response;
  try {
    return seeJson({ project: await createProject(depsFactory(), guard.actor, await readJson(request)) }, 201);
  } catch (error) {
    return seeErrorResponse(error);
  }
}

export async function GET(request: NextRequest) {
  return handleSeeProjectList(request);
}

export async function POST(request: NextRequest) {
  return handleSeeProjectCreate(request);
}
