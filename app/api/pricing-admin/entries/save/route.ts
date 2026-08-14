import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { saveManyPricingEntriesAdmin } from "../../../../../lib/db/pricingAdmin.supabase.ts";
import type { PricingEntryEdit, PricingEntrySaveSummary } from "../../../../../domain/pricingAdmin.ts";

function defaultSaveEntries(edits: readonly PricingEntryEdit[]): Promise<PricingEntrySaveSummary> {
  return saveManyPricingEntriesAdmin(createSupabaseServerClient(), edits);
}

type SaveBody = Readonly<{ edits?: readonly PricingEntryEdit[] }>;

/**
 * Section 14/15: single "save/update pricing entry" and "bulk save pricing entries" share this
 * one endpoint — a single-cell save is just a one-element edits array, same idempotent
 * per-cell upsert path either way. Never returns a bare 200 pretending everything saved when
 * part of the batch failed — the response always carries the per-cell results so the UI can
 * show a true "12/15 uloženo, 3 selhaly" state rather than a blanket "Uloženo".
 */
export async function handlePricingAdminEntriesSave(
  request: NextRequest,
  saveEntries: (edits: readonly PricingEntryEdit[]) => Promise<PricingEntrySaveSummary> = defaultSaveEntries,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro ukládání cen je vyžadováno přihlášení." }, { status: 401 });
  let body: SaveBody;
  try { body = await request.json() as SaveBody; }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  if (!Array.isArray(body.edits) || body.edits.length === 0) {
    return NextResponse.json({ error: "Chybí položky k uložení (edits)." }, { status: 400 });
  }
  try {
    const summary = await saveEntries(body.edits);
    return NextResponse.json(summary);
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Uložení cen selhalo (databázová chyba)." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handlePricingAdminEntriesSave(request);
}
