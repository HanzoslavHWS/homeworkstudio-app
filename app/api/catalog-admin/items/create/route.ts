import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { createCatalogItemAdmin } from "../../../../../lib/db/catalogItemsAdmin.supabase.ts";
import {
  InvalidCatalogItemAdminCreateInputError,
  parseCatalogItemAdminCreateInput,
  type CatalogItemAdmin,
  type CatalogItemAdminCreateInput,
} from "../../../../../domain/catalogItemsAdmin.ts";
import { DuplicateInternalCodeError } from "../../../../../domain/catalogReadiness.ts";

type CreateBody = Readonly<{ create?: unknown }>;

function defaultCreate(input: CatalogItemAdminCreateInput): Promise<CatalogItemAdmin> {
  return createCatalogItemAdmin(createSupabaseServerClient(), input);
}

export async function handleCatalogAdminItemsCreate(
  request: NextRequest,
  create: (input: CatalogItemAdminCreateInput) => Promise<CatalogItemAdmin> = defaultCreate,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro vytvoření katalogové položky je vyžadováno přihlášení." }, { status: 401 });
  }

  let body: CreateBody;
  try {
    body = (await request.json()) as CreateBody;
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }

  let input: CatalogItemAdminCreateInput;
  try {
    input = parseCatalogItemAdminCreateInput(body.create);
  } catch (parseError) {
    if (parseError instanceof InvalidCatalogItemAdminCreateInputError) {
      return NextResponse.json({ error: parseError.message }, { status: 400 });
    }
    return NextResponse.json({ error: "Neplatná data pro vytvoření položky." }, { status: 400 });
  }

  try {
    const created = await create(input);
    return NextResponse.json({ catalogItem: created });
  } catch (error) {
    if (error instanceof DuplicateInternalCodeError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Katalogovou položku se nepodařilo vytvořit v databázi." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleCatalogAdminItemsCreate(request);
}
