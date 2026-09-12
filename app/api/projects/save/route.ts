import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { SupabaseProjectRepository } from "../../../../lib/db/projectRepository.supabase.ts";
import type { RemoteProjectRepository } from "../../../../domain/remotePersistence.ts";
import { ConcurrencyConflictError } from "../../../../lib/db/concurrency.ts";
import { normalizeProjectRecord, type ProjectRecord } from "../../../../domain/project.ts";
import { createSupabaseEventIdResolver, isEventForeignKeyViolation, UNKNOWN_EVENT_MESSAGE, type EventIdResolver } from "../../../../lib/db/eventIdValidation.server.ts";

function defaultRepositoryFactory(): RemoteProjectRepository {
  return new SupabaseProjectRepository(createSupabaseServerClient());
}

function defaultEventIdResolverFactory(): EventIdResolver {
  return createSupabaseEventIdResolver(createSupabaseServerClient());
}

type SaveBody = Readonly<{ project?: Partial<ProjectRecord> & Pick<ProjectRecord, "id">; expectedRevision?: number | null }>;

/**
 * Corrective batch — event-ID consistency audit, section 5: the SAME event-id resolver/validator
 * the technical-raster save route uses (see lib/db/eventIdValidation.server.ts and its own doc) —
 * every project-creation/persistence path shares one canonicalization layer, never a one-off fix
 * for a single module.
 */
export async function handleProjectsSave(
  request: NextRequest,
  repositoryFactory: () => RemoteProjectRepository = defaultRepositoryFactory,
  resolveEventIdFactory: () => EventIdResolver = defaultEventIdResolverFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro ukládání projektů je vyžadováno přihlášení." }, { status: 401 });
  let body: SaveBody;
  try { body = await request.json() as SaveBody; }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  if (!body.project || typeof body.project.id !== "string" || !body.project.id) {
    return NextResponse.json({ error: "Chybí platný projekt." }, { status: 400 });
  }
  try {
    // Never trust the client payload blindly — the same migration/normalization the app
    // runs on every localStorage read also runs here before anything is persisted.
    const normalized = normalizeProjectRecord(body.project);
    const eventResolution = await resolveEventIdFactory()(normalized.fairId);
    // `.ok === false` (never `!eventResolution.ok`) — this repo's tsconfig runs with
    // `strict: false`, under which plain truthiness negation fails to narrow this discriminated
    // union correctly (verified directly; an exact literal comparison narrows fine either way).
    if (eventResolution.ok === false) return NextResponse.json({ error: eventResolution.message }, { status: 400 });
    const saved = await repositoryFactory().saveWithRevision({ ...normalized, fairId: eventResolution.eventId ?? "" }, body.expectedRevision ?? null);
    return NextResponse.json({ project: saved });
  } catch (error) {
    if (error instanceof ConcurrencyConflictError) return NextResponse.json({ error: "Data byla mezitím změněna jinde. Obnovte stránku před uložením." }, { status: 409 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    if (isEventForeignKeyViolation(error)) {
      console.error("ProjectsSave failed (unresolved event reference):", error);
      return NextResponse.json({ error: UNKNOWN_EVENT_MESSAGE }, { status: 400 });
    }
    return NextResponse.json({ error: "Projekt se nepodařilo uložit do databáze." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleProjectsSave(request);
}
