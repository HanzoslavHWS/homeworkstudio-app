import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabaseEmailTemplateRepository } from "../../../../../lib/db/emailTemplateRepository.supabase.ts";
import { EmailTemplateProtectedError, type EmailTemplateCreateInput, type EmailTemplateRepository } from "../../../../../domain/emailTemplate.ts";

function defaultRepositoryFactory(): EmailTemplateRepository {
  return new SupabaseEmailTemplateRepository(createSupabaseServerClient());
}

type SaveBody = Readonly<{ id?: string; template?: Partial<EmailTemplateCreateInput> }>;

/** No `id` -> create (always scope: "user"). `id` present -> update, rejected with 400 if the target is scope: "system". */
export async function handleEmailTemplatesSave(
  request: NextRequest,
  repositoryFactory: () => EmailTemplateRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro ukládání vzorů e-mailů je vyžadováno přihlášení." }, { status: 401 });
  let body: SaveBody;
  try { body = await request.json() as SaveBody; }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  const name = body.template?.name?.trim();
  if (!name) return NextResponse.json({ error: "Zadejte název vzoru." }, { status: 400 });

  const edit: EmailTemplateCreateInput = {
    name,
    freeText: body.template?.freeText,
    aiInstruction: body.template?.aiInstruction,
    languageCode: body.template?.languageCode,
    toneId: body.template?.toneId,
  };

  try {
    const repository = repositoryFactory();
    const template = body.id ? await repository.update(body.id, edit) : await repository.create(edit);
    return NextResponse.json({ template });
  } catch (error) {
    if (error instanceof EmailTemplateProtectedError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Vzor e-mailu se nepodařilo uložit do databáze." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleEmailTemplatesSave(request);
}
