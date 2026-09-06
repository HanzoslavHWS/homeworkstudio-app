import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabasePrintSurfaceExportRepository } from "../../../../../lib/db/printSurfaceExportRepository.supabase.ts";
import type { PrintSurfaceExportRepository } from "../../../../../domain/printSurfaceExport.ts";

function defaultRepositoryFactory(): PrintSurfaceExportRepository {
  return new SupabasePrintSurfaceExportRepository(createSupabaseServerClient());
}

export async function handlePrintSurfaceExportsList(
  request: NextRequest,
  repositoryFactory: () => PrintSurfaceExportRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro přístup k historii exportů je vyžadováno přihlášení." }, { status: 401 });
  }
  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "Chybí id projektu." }, { status: 400 });
  try {
    const exports = await repositoryFactory().list(projectId);
    return NextResponse.json({ exports });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Historii exportů se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handlePrintSurfaceExportsList(request);
}
