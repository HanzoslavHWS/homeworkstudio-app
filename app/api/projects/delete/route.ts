import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../lib/auth/requestAuth.ts";
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
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro mazání projektů je vyžadováno přihlášení." }, { status: 401 });
  let id = "";
  try { id = String((await request.json() as { id?: unknown }).id ?? ""); }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  if (!id) return NextResponse.json({ error: "Chybí id projektu." }, { status: 400 });
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
