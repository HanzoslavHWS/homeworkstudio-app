import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabasePrintSurfaceExportRepository } from "../../../../../lib/db/printSurfaceExportRepository.supabase.ts";
import { PRINT_SURFACE_EXPORT_TYPES, type PrintSurfaceExportCreateInput, type PrintSurfaceExportRepository } from "../../../../../domain/printSurfaceExport.ts";

function defaultRepositoryFactory(): PrintSurfaceExportRepository {
  return new SupabasePrintSurfaceExportRepository(createSupabaseServerClient());
}

export async function handlePrintSurfaceExportCreate(
  request: NextRequest,
  repositoryFactory: () => PrintSurfaceExportRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro vytvoření exportu je vyžadováno přihlášení." }, { status: 401 });
  }
  let body: Partial<PrintSurfaceExportCreateInput>;
  try {
    body = (await request.json()) as Partial<PrintSurfaceExportCreateInput>;
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
  if (!body.projectId) return NextResponse.json({ error: "Chybí id projektu." }, { status: 400 });
  if (!body.exportType || !(PRINT_SURFACE_EXPORT_TYPES as readonly string[]).includes(body.exportType)) {
    return NextResponse.json({ error: "Neplatný typ exportu." }, { status: 400 });
  }
  try {
    const record = await repositoryFactory().create({ projectId: body.projectId, exportType: body.exportType, createdBy: body.createdBy, fileStorageKey: body.fileStorageKey });
    return NextResponse.json({ export: record });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Vytvoření záznamu exportu selhalo." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handlePrintSurfaceExportCreate(request);
}
