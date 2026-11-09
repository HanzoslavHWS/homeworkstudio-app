import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabaseTechnicalRasterProjectRepository } from "../../../../../lib/db/technicalRasterProjectRepository.supabase.ts";
import type { TechnicalRasterProjectRepository } from "../../../../../domain/technicalRaster.ts";

function defaultRepositoryFactory(): TechnicalRasterProjectRepository {
  return new SupabaseTechnicalRasterProjectRepository(createSupabaseServerClient());
}

type DeleteBody = Readonly<{ id?: string }>;

export async function handleTechnicalRasterProjectDelete(
  request: NextRequest,
  repositoryFactory: () => TechnicalRasterProjectRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "technicalRasters.use");
  if (authDenied) return authDenied;
  let body: DeleteBody;
  try {
    body = (await request.json()) as DeleteBody;
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "Chybí id projektu." }, { status: 400 });
  try {
    await repositoryFactory().delete(body.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    console.error("TechnicalRasterProjectDelete failed:", error);
    return NextResponse.json({ error: "Smazání projektu technického rastru selhalo." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleTechnicalRasterProjectDelete(request);
}
