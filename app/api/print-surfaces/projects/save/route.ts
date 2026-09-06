import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabasePrintSurfaceProjectRepository } from "../../../../../lib/db/printSurfaceProjectRepository.supabase.ts";
import type {
  PrintSurfaceProject,
  PrintSurfaceProjectCreateInput,
  PrintSurfaceProjectRepository,
} from "../../../../../domain/printSurfaceProject.ts";

function defaultRepositoryFactory(): PrintSurfaceProjectRepository {
  return new SupabasePrintSurfaceProjectRepository(createSupabaseServerClient());
}

type SaveBody = Readonly<{ create?: PrintSurfaceProjectCreateInput; project?: PrintSurfaceProject }>;

/** No `create`/`project.id` distinction ambiguity: `create` always makes a brand new project; `project` (with its existing id) always updates it — the same "id present -> update" convention as handleEmailTemplatesSave, just split into two explicit body keys since create/update need different-shaped inputs here. */
export async function handlePrintSurfaceProjectSave(
  request: NextRequest,
  repositoryFactory: () => PrintSurfaceProjectRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro ukládání projektů tiskových ploch je vyžadováno přihlášení." }, { status: 401 });
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
      const companyName = body.create.companyName?.trim();
      if (!name) return NextResponse.json({ error: "Zadejte název projektu." }, { status: 400 });
      const project = await repository.create({ ...body.create, name, companyName: companyName ?? "" });
      return NextResponse.json({ project });
    }

    if (body.project?.id) {
      const project = await repository.save(body.project);
      return NextResponse.json({ project });
    }

    return NextResponse.json({ error: "Chybí platná data projektu." }, { status: 400 });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Projekt tiskových ploch se nepodařilo uložit do databáze." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handlePrintSurfaceProjectSave(request);
}
