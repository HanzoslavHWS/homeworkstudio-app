import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabaseEmailHistoryRepository } from "../../../../../lib/db/emailHistoryRepository.supabase.ts";
import { parseEmailHistorySaveInput, type EmailHistoryRepository, type EmailHistorySaveInput } from "../../../../../domain/emailHistory.ts";

function defaultRepositoryFactory(): EmailHistoryRepository {
  return new SupabaseEmailHistoryRepository(createSupabaseServerClient());
}

type UpdateBody = Readonly<{ id?: string; entry?: Partial<EmailHistorySaveInput> }>;

export async function handleEmailHistoryUpdate(
  request: NextRequest,
  repositoryFactory: () => EmailHistoryRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro úpravu historie e-mailů je vyžadováno přihlášení." }, { status: 401 });
  let body: UpdateBody;
  try { body = await request.json() as UpdateBody; }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  if (!body.id) return NextResponse.json({ error: "Chybí id záznamu historie." }, { status: 400 });

  const input = parseEmailHistorySaveInput(body.entry);
  if (!input) return NextResponse.json({ error: "Neplatný záznam historie." }, { status: 400 });

  try {
    const entry = await repositoryFactory().update(body.id, input);
    return NextResponse.json({ entry });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Aktualizace historie e-mailů selhala." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleEmailHistoryUpdate(request);
}
