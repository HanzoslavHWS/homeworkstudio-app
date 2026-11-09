import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabasePrintSurfaceProjectRepository } from "../../../../../lib/db/printSurfaceProjectRepository.supabase.ts";
import type { PrintSurfaceProjectRepository } from "../../../../../domain/printSurfaceProject.ts";

function defaultRepositoryFactory(): PrintSurfaceProjectRepository {
  return new SupabasePrintSurfaceProjectRepository(createSupabaseServerClient());
}

export async function handlePrintSurfaceProjectsList(
  request: NextRequest,
  repositoryFactory: () => PrintSurfaceProjectRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "printSurfaces.use");
  if (authDenied) return authDenied;
  try {
    const projects = await repositoryFactory().list();
    return NextResponse.json({ projects });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Projekty tiskových ploch se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handlePrintSurfaceProjectsList(request);
}
