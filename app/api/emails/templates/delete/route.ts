import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabaseEmailTemplateRepository } from "../../../../../lib/db/emailTemplateRepository.supabase.ts";
import { EmailTemplateProtectedError, type EmailTemplateRepository } from "../../../../../domain/emailTemplate.ts";

function defaultRepositoryFactory(): EmailTemplateRepository {
  return new SupabaseEmailTemplateRepository(createSupabaseServerClient());
}

type DeleteBody = Readonly<{ id?: string }>;

export async function handleEmailTemplatesDelete(
  request: NextRequest,
  repositoryFactory: () => EmailTemplateRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro mazání vzorů e-mailů je vyžadováno přihlášení." }, { status: 401 });
  let body: DeleteBody;
  try { body = await request.json() as DeleteBody; }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  if (!body.id) return NextResponse.json({ error: "Chybí id vzoru." }, { status: 400 });

  try {
    await repositoryFactory().delete(body.id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof EmailTemplateProtectedError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Vzor e-mailu se nepodařilo smazat." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleEmailTemplatesDelete(request);
}
