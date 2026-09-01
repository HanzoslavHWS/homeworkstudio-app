import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabaseEmailHistoryRepository } from "../../../../../lib/db/emailHistoryRepository.supabase.ts";
import type { EmailHistoryRepository } from "../../../../../domain/emailHistory.ts";

function defaultRepositoryFactory(): EmailHistoryRepository {
  return new SupabaseEmailHistoryRepository(createSupabaseServerClient());
}

export async function handleEmailHistoryList(
  request: NextRequest,
  repositoryFactory: () => EmailHistoryRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro přístup k historii e-mailů je vyžadováno přihlášení." }, { status: 401 });
  try {
    const entries = await repositoryFactory().list();
    return NextResponse.json({ entries });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Historii e-mailů se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handleEmailHistoryList(request);
}
