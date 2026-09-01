import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabaseEmailTemplateRepository } from "../../../../../lib/db/emailTemplateRepository.supabase.ts";
import type { EmailTemplateRepository } from "../../../../../domain/emailTemplate.ts";

function defaultRepositoryFactory(): EmailTemplateRepository {
  return new SupabaseEmailTemplateRepository(createSupabaseServerClient());
}

export async function handleEmailTemplatesList(
  request: NextRequest,
  repositoryFactory: () => EmailTemplateRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro přístup ke vzorům e-mailů je vyžadováno přihlášení." }, { status: 401 });
  try {
    const templates = await repositoryFactory().list();
    return NextResponse.json({ templates });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Vzory e-mailů se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handleEmailTemplatesList(request);
}
