import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabaseTechnicalRasterProjectRepository } from "../../../../../lib/db/technicalRasterProjectRepository.supabase.ts";
import { createSupabaseEventIdResolver, isEventForeignKeyViolation, UNKNOWN_EVENT_MESSAGE, type EventIdResolver } from "../../../../../lib/db/eventIdValidation.server.ts";
import type {
  TechnicalRasterProject,
  TechnicalRasterProjectCreateInput,
  TechnicalRasterProjectRepository,
} from "../../../../../domain/technicalRaster.ts";

function defaultRepositoryFactory(): TechnicalRasterProjectRepository {
  return new SupabaseTechnicalRasterProjectRepository(createSupabaseServerClient());
}

function defaultEventIdResolverFactory(): EventIdResolver {
  return createSupabaseEventIdResolver(createSupabaseServerClient());
}

type SaveBody = Readonly<{ create?: TechnicalRasterProjectCreateInput; project?: TechnicalRasterProject }>;

/**
 * Same "id present -> update, else create" convention as handlePrintSurfaceProjectSave.
 *
 * Corrective batch — event-ID consistency audit, sections 6/8/9: root cause of the real production
 * failure (`Key (event_id)=(for-beauty-autumn-2026) is not present in table "events"`) was a stale
 * legacy per-edition id reaching this route unvalidated — fixed at its source in
 * data/organizations.ts/data/fairs.ts, but this route ALSO now resolves/validates `eventId`
 * (`resolveEventIdFactory`, defaulting to a real DB-backed check — see
 * lib/db/eventIdValidation.server.ts) BEFORE ever attempting the insert/update, so an unresolvable
 * event reference fails fast with a clear Czech message instead of a raw FK violation surfacing as
 * a generic "database unavailable"-flavored error. `isEventForeignKeyViolation` is a second,
 * defense-in-depth classifier in the catch block for the unlikely case a request reaches the DB
 * despite the pre-check (e.g. a future caller that forgets to go through this same path).
 */
export async function handleTechnicalRasterProjectSave(
  request: NextRequest,
  repositoryFactory: () => TechnicalRasterProjectRepository = defaultRepositoryFactory,
  resolveEventIdFactory: () => EventIdResolver = defaultEventIdResolverFactory,
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
    const resolveEventId = resolveEventIdFactory();

    if (body.create) {
      const name = body.create.name?.trim();
      if (!name) return NextResponse.json({ error: "Zadejte název projektu." }, { status: 400 });
      const eventResolution = await resolveEventId(body.create.eventId);
      // .ok === false (never !eventResolution.ok) — see lib/db/eventIdValidation.server.ts's own
      // usage note: this repo's tsconfig runs strict:false, under which plain truthiness negation
      // fails to narrow this discriminated union correctly.
      if (eventResolution.ok === false) return NextResponse.json({ error: eventResolution.message }, { status: 400 });
      const project = await repository.create({ ...body.create, name, eventId: eventResolution.eventId });
      return NextResponse.json({ project });
    }

    if (body.project?.id) {
      const eventResolution = await resolveEventId(body.project.eventId);
      // .ok === false (never !eventResolution.ok) — see lib/db/eventIdValidation.server.ts's own
      // usage note: this repo's tsconfig runs strict:false, under which plain truthiness negation
      // fails to narrow this discriminated union correctly.
      if (eventResolution.ok === false) return NextResponse.json({ error: eventResolution.message }, { status: 400 });
      const project = await repository.save({ ...body.project, eventId: eventResolution.eventId });
      return NextResponse.json({ project });
    }

    return NextResponse.json({ error: "Chybí platná data projektu." }, { status: 400 });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    if (isEventForeignKeyViolation(error)) {
      console.error("TechnicalRasterProjectSave failed (unresolved event reference):", error);
      return NextResponse.json({ error: UNKNOWN_EVENT_MESSAGE }, { status: 400 });
    }
    console.error("TechnicalRasterProjectSave failed:", error);
    return NextResponse.json({ error: "Projekt technického rastru se nepodařilo uložit do databáze." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleTechnicalRasterProjectSave(request);
}
