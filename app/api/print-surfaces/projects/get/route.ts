import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabasePrintSurfaceProjectRepository } from "../../../../../lib/db/printSurfaceProjectRepository.supabase.ts";
import type { PrintSurfaceProjectRepository } from "../../../../../domain/printSurfaceProject.ts";

function defaultRepositoryFactory(): PrintSurfaceProjectRepository {
  return new SupabasePrintSurfaceProjectRepository(createSupabaseServerClient());
}

export async function handlePrintSurfaceProjectGet(
  request: NextRequest,
  repositoryFactory: () => PrintSurfaceProjectRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "printSurfaces.use");
  if (authDenied) return authDenied;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Chybí id projektu." }, { status: 400 });
  try {
    const project = await repositoryFactory().get(id);
    if (!project) return NextResponse.json({ error: "Projekt nebyl nalezen." }, { status: 404 });
    return NextResponse.json({ project });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Projekt tiskových ploch se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handlePrintSurfaceProjectGet(request);
}
