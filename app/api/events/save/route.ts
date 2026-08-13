import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { SupabaseEventRepository } from "../../../../lib/db/eventRepository.supabase.ts";
import type { RemoteEventRepository } from "../../../../domain/remotePersistence.ts";
import { ConcurrencyConflictError } from "../../../../lib/db/concurrency.ts";
import { normalizeExhibition, type Exhibition } from "../../../../domain/organizations.ts";

function defaultRepositoryFactory(): RemoteEventRepository {
  return new SupabaseEventRepository(createSupabaseServerClient());
}

type SaveBody = Readonly<{ event?: Partial<Exhibition> & Pick<Exhibition, "id">; expectedRevision?: number | null }>;

export async function handleEventsSave(
  request: NextRequest,
  repositoryFactory: () => RemoteEventRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro ukládání eventů je vyžadováno přihlášení." }, { status: 401 });
  let body: SaveBody;
  try { body = await request.json() as SaveBody; }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  if (!body.event || typeof body.event.id !== "string" || !body.event.id) {
    return NextResponse.json({ error: "Chybí platný event." }, { status: 400 });
  }
  try {
    const normalized = normalizeExhibition(body.event);
    const saved = await repositoryFactory().saveWithRevision(normalized, body.expectedRevision ?? null);
    return NextResponse.json({ event: saved });
  } catch (error) {
    if (error instanceof ConcurrencyConflictError) return NextResponse.json({ error: "Data byla mezitím změněna jinde. Obnovte stránku před uložením." }, { status: 409 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Event se nepodařilo uložit do databáze." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleEventsSave(request);
}
