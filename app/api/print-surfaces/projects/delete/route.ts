import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabasePrintSurfaceProjectRepository } from "../../../../../lib/db/printSurfaceProjectRepository.supabase.ts";
import type { PrintSurfaceProjectRepository } from "../../../../../domain/printSurfaceProject.ts";

function defaultRepositoryFactory(): PrintSurfaceProjectRepository {
  return new SupabasePrintSurfaceProjectRepository(createSupabaseServerClient());
}

type DeleteBody = Readonly<{ id?: string }>;

export async function handlePrintSurfaceProjectDelete(
  request: NextRequest,
  repositoryFactory: () => PrintSurfaceProjectRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "printSurfaces.use");
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
    return NextResponse.json({ error: "Smazání projektu tiskových ploch selhalo." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handlePrintSurfaceProjectDelete(request);
}
