import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabaseTechnicalRasterProjectRepository } from "../../../../../lib/db/technicalRasterProjectRepository.supabase.ts";
import type { TechnicalRasterProjectRepository } from "../../../../../domain/technicalRaster.ts";

function defaultRepositoryFactory(): TechnicalRasterProjectRepository {
  return new SupabaseTechnicalRasterProjectRepository(createSupabaseServerClient());
}

export async function handleTechnicalRasterProjectGet(
  request: NextRequest,
  repositoryFactory: () => TechnicalRasterProjectRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "technicalRasters.use");
  if (authDenied) return authDenied;
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Chybí id projektu." }, { status: 400 });
  try {
    const project = await repositoryFactory().get(id);
    if (!project) return NextResponse.json({ error: "Projekt nebyl nalezen." }, { status: 404 });
    return NextResponse.json({ project });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    console.error("TechnicalRasterProjectGet failed:", error);
    return NextResponse.json({ error: "Projekt technického rastru se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handleTechnicalRasterProjectGet(request);
}
