import { NextResponse, type NextRequest } from "next/server.js";
import { authenticate, authorizeProject } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { SupabaseProjectRepository } from "../../../../lib/db/projectRepository.supabase.ts";
import type { RemoteProjectRepository } from "../../../../domain/remotePersistence.ts";

function defaultRepositoryFactory(): RemoteProjectRepository {
  return new SupabaseProjectRepository(createSupabaseServerClient());
}

export async function handleProjectsDelete(
  request: NextRequest,
  repositoryFactory: () => RemoteProjectRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  const signedIn = await authenticate(request);
  if (signedIn.ok === false) return signedIn.response;
  let id = "";
  try { id = String((await request.json() as { id?: unknown }).id ?? ""); }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  if (!id) return NextResponse.json({ error: "Chybí id projektu." }, { status: 400 });
  const access = await authorizeProject(request, id, "delete");
  if (access.ok === false) return access.response;
  try {
    await repositoryFactory().delete(id);
    return NextResponse.json({ deleted: true });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Projekt se nepodařilo smazat z databáze." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleProjectsDelete(request);
}
