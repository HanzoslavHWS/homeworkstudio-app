import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import {
  CustomerCatalogPresetNotFoundError,
  CustomerCatalogPresetsNotMigratedError,
  SupabaseCustomerCatalogPresetRepository,
} from "../../../../lib/db/customerCatalogPresetRepository.supabase.ts";
import {
  InvalidCustomerCatalogPresetError,
  parseCustomerCatalogPresetInput,
  type CustomerCatalogPresetInput,
  type CustomerCatalogPresetRepository,
} from "../../../../domain/customerCatalog.ts";

function defaultRepository(): CustomerCatalogPresetRepository {
  return new SupabaseCustomerCatalogPresetRepository(createSupabaseServerClient());
}

const UNAUTHORIZED = "Pro katalog je vyžadováno přihlášení.";

function errorResponse(error: unknown, fallbackMessage: string): NextResponse {
  if (error instanceof CustomerCatalogPresetsNotMigratedError) return NextResponse.json({ error: error.message }, { status: 409 });
  if (error instanceof CustomerCatalogPresetNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
  if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
  return NextResponse.json({ error: fallbackMessage }, { status: 502 });
}

export async function handleCustomerCatalogPresetsList(
  request: NextRequest,
  getRepository: () => CustomerCatalogPresetRepository = defaultRepository,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: UNAUTHORIZED }, { status: 401 });
  try {
    return NextResponse.json({ presets: await getRepository().list() });
  } catch (error) {
    return errorResponse(error, "Uložené konfigurace katalogu se nepodařilo načíst z databáze.");
  }
}

export async function handleCustomerCatalogPresetsSave(
  request: NextRequest,
  getRepository: () => CustomerCatalogPresetRepository = defaultRepository,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: UNAUTHORIZED }, { status: 401 });
  let input: CustomerCatalogPresetInput;
  try {
    input = parseCustomerCatalogPresetInput(await request.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof InvalidCustomerCatalogPresetError ? error.message : "Neplatný JSON požadavek." }, { status: 400 });
  }
  try {
    return NextResponse.json({ preset: await getRepository().save(input) });
  } catch (error) {
    return errorResponse(error, "Konfiguraci katalogu se nepodařilo uložit do databáze.");
  }
}

export async function handleCustomerCatalogPresetsDelete(
  request: NextRequest,
  getRepository: () => CustomerCatalogPresetRepository = defaultRepository,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: UNAUTHORIZED }, { status: 401 });
  const id = request.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Chybí id konfigurace." }, { status: 400 });
  try {
    await getRepository().delete(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return errorResponse(error, "Konfiguraci katalogu se nepodařilo smazat.");
  }
}

export async function GET(request: NextRequest) {
  return handleCustomerCatalogPresetsList(request);
}

export async function POST(request: NextRequest) {
  return handleCustomerCatalogPresetsSave(request);
}

export async function DELETE(request: NextRequest) {
  return handleCustomerCatalogPresetsDelete(request);
}
