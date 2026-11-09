import { NextResponse, type NextRequest } from "next/server.js";
import { denyUnless } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { SupabaseEventRepository } from "../../../../lib/db/eventRepository.supabase.ts";
import type { RemoteEventRepository } from "../../../../domain/remotePersistence.ts";

function defaultRepositoryFactory(): RemoteEventRepository {
  return new SupabaseEventRepository(createSupabaseServerClient());
}

export async function handleEventsList(
  request: NextRequest,
  repositoryFactory: () => RemoteEventRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  const authDenied = await denyUnless(request, "events.read");
  if (authDenied) return authDenied;
  try {
    const events = await repositoryFactory().list();
    return NextResponse.json({ events });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Eventy se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handleEventsList(request);
}
