import { NextResponse, type NextRequest } from "next/server.js";
import { authenticate, visibleProjectIds } from "../../../../lib/auth/requestAuth.ts";
import { externalProjectView } from "../../../../domain/externalProjectView.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { SupabaseProjectRepository } from "../../../../lib/db/projectRepository.supabase.ts";
import type { RemoteProjectRepository } from "../../../../domain/remotePersistence.ts";

function defaultRepositoryFactory(): RemoteProjectRepository {
  return new SupabaseProjectRepository(createSupabaseServerClient());
}

export async function handleProjectsList(
  request: NextRequest,
  repositoryFactory: () => RemoteProjectRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  const signedIn = await authenticate(request);
  if (signedIn.ok === false) return signedIn.response;
  const { user } = signedIn.auth;
  try {
    // Admin: every project. Others: only assigned ones; an external user gets the read-only view
    // (identification + allowed outputs), never the full document.
    const [projects, visible] = await Promise.all([repositoryFactory().list(), visibleProjectIds(user)]);
    const allowed = visible ? projects.filter((project) => visible.has(project.id)) : projects;
    if (user.role === "external") return NextResponse.json({ projects: allowed.map((project) => externalProjectView(project as unknown as Readonly<Record<string, unknown>> & { id: string })) });
    return NextResponse.json({ projects: allowed });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Projekty se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handleProjectsList(request);
}
