import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabaseTechnicalRasterProjectRepository } from "../../../../../lib/db/technicalRasterProjectRepository.supabase.ts";
import type {
  TechnicalRasterProject,
  TechnicalRasterProjectCreateInput,
  TechnicalRasterProjectRepository,
} from "../../../../../domain/technicalRaster.ts";

function defaultRepositoryFactory(): TechnicalRasterProjectRepository {
  return new SupabaseTechnicalRasterProjectRepository(createSupabaseServerClient());
}

type SaveBody = Readonly<{ create?: TechnicalRasterProjectCreateInput; project?: TechnicalRasterProject }>;

/** Same "id present -> update, else create" convention as handlePrintSurfaceProjectSave. */
export async function handleTechnicalRasterProjectSave(
  request: NextRequest,
  repositoryFactory: () => TechnicalRasterProjectRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro ukládání projektů technických rastrů je vyžadováno přihlášení." }, { status: 401 });
  }
  let body: SaveBody;
  try {
    body = (await request.json()) as SaveBody;
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }

  try {
    const repository = repositoryFactory();

    if (body.create) {
      const name = body.create.name?.trim();
      if (!name) return NextResponse.json({ error: "Zadejte název projektu." }, { status: 400 });
      const project = await repository.create({ ...body.create, name });
      return NextResponse.json({ project });
    }

    if (body.project?.id) {
      const project = await repository.save(body.project);
      return NextResponse.json({ project });
    }

    return NextResponse.json({ error: "Chybí platná data projektu." }, { status: 400 });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    console.error("TechnicalRasterProjectSave failed:", error);
    return NextResponse.json({ error: "Projekt technického rastru se nepodařilo uložit do databáze." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleTechnicalRasterProjectSave(request);
}
