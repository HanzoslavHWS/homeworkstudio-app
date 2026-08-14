import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { SupabasePriceListRepository } from "../../../../lib/db/priceListRepository.supabase.ts";
import type { PriceListRepository } from "../../../../domain/priceListRepository.ts";
import { normalizePriceList, type PriceList } from "../../../../domain/organizations.ts";

function defaultRepositoryFactory(): PriceListRepository {
  return new SupabasePriceListRepository(createSupabaseServerClient());
}

type SaveBody = Readonly<{ priceList?: Partial<PriceList> & Pick<PriceList, "id"> }>;

export async function handlePriceListsSave(
  request: NextRequest,
  repositoryFactory: () => PriceListRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro ukládání ceníků je vyžadováno přihlášení." }, { status: 401 });
  let body: SaveBody;
  try { body = await request.json() as SaveBody; }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  if (!body.priceList || typeof body.priceList.id !== "string" || !body.priceList.id) {
    return NextResponse.json({ error: "Chybí platný ceník." }, { status: 400 });
  }
  try {
    const normalized = normalizePriceList(body.priceList);
    const saved = await repositoryFactory().save(normalized);
    return NextResponse.json({ priceList: saved });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Ceník se nepodařilo uložit do databáze." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handlePriceListsSave(request);
}
