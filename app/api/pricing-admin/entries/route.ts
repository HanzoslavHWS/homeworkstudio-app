import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { readPricingEntriesAdmin } from "../../../../lib/db/pricingAdmin.supabase.ts";
import type { PricingEntryAdmin } from "../../../../domain/pricingAdmin.ts";

function parseIds(value: string | null): readonly string[] {
  return value ? value.split(",").map((id) => id.trim()).filter(Boolean) : [];
}

function defaultReadEntries(filter: Readonly<{ catalogItemIds: readonly string[]; priceListIds: readonly string[] }>): Promise<readonly PricingEntryAdmin[]> {
  return readPricingEntriesAdmin(createSupabaseServerClient(), filter);
}

export async function handlePricingAdminEntriesList(
  request: NextRequest,
  readEntries: (filter: Readonly<{ catalogItemIds: readonly string[]; priceListIds: readonly string[] }>) => Promise<readonly PricingEntryAdmin[]> = defaultReadEntries,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro přístup ke správě cen je vyžadováno přihlášení." }, { status: 401 });
  const catalogItemIds = parseIds(request.nextUrl.searchParams.get("catalogItemIds"));
  const priceListIds = parseIds(request.nextUrl.searchParams.get("priceListIds"));
  if (catalogItemIds.length === 0 && priceListIds.length === 0) {
    return NextResponse.json({ error: "Chybí parametr catalogItemIds nebo priceListIds." }, { status: 400 });
  }
  try {
    const entries = await readEntries({ catalogItemIds, priceListIds });
    return NextResponse.json({ entries });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Ceny se nepodařilo načíst z databáze." }, { status: 502 });
  }
}

export async function GET(request: NextRequest) {
  return handlePricingAdminEntriesList(request);
}
