import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabaseTechnicalRasterProjectRepository } from "../../../../../lib/db/technicalRasterProjectRepository.supabase.ts";
import type { TechnicalRasterProjectRepository } from "../../../../../domain/technicalRaster.ts";

function defaultRepositoryFactory(): TechnicalRasterProjectRepository {
  return new SupabaseTechnicalRasterProjectRepository(createSupabaseServerClient());
}

export async function handleTechnicalRasterProjectsList(
  request: NextRequest,
  repositoryFactory: () => TechnicalRasterProjectRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "technicalRasters.use");
  if (authDenied) return authDenied;
  try {
    const projects = await repositoryFactory().list();
    return NextResponse.json({ projects });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    console.error("TechnicalRasterProjectsList failed:", error);
    return NextResponse.json({ error: "Projekty technických rastrů se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handleTechnicalRasterProjectsList(request);
}
