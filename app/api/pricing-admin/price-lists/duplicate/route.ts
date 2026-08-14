import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import {
  duplicatePriceListAdmin,
  DuplicatePriceListCodeError,
  PriceListNotFoundError,
  type DuplicatePriceListResult,
} from "../../../../../lib/db/pricingAdmin.supabase.ts";
import { SupabaseEventRepository } from "../../../../../lib/db/eventRepository.supabase.ts";
import type { DuplicatePriceListDraft } from "../../../../../domain/pricingAdmin.ts";

function defaultDuplicate(sourcePriceListId: string, draft: DuplicatePriceListDraft): Promise<DuplicatePriceListResult> {
  return duplicatePriceListAdmin(createSupabaseServerClient(), sourcePriceListId, draft);
}

/**
 * Best-effort: adds the new price list's id to its event's priceListIds so the duplicate is
 * actually reachable by resolveEventPriceListForCurrency() right away — otherwise the feature
 * would produce a price list a project can never resolve to. A failure here (event missing,
 * concurrent edit conflict) is reported back but never rolls back the already-created price
 * list/entries — the admin can link it manually in Výstavy/eventy afterward.
 */
async function defaultLinkEventToPriceList(eventId: string, priceListId: string): Promise<string | undefined> {
  const repository = new SupabaseEventRepository(createSupabaseServerClient());
  const event = await repository.getWithRevision(eventId);
  if (!event) return `Ceník byl vytvořen, ale event "${eventId}" nebyl nalezen — přiřaďte ceník ručně ve Výstavách/eventech.`;
  if (event.priceListIds.includes(priceListId)) return undefined;
  try {
    await repository.saveWithRevision({ ...event, priceListIds: [...event.priceListIds, priceListId] }, event.revision);
    return undefined;
  } catch {
    return "Ceník byl vytvořen, ale automatické přiřazení k eventu selhalo — přiřaďte ceník ručně ve Výstavách/eventech.";
  }
}

type DuplicateBody = Readonly<{ sourcePriceListId?: string; priceList?: Partial<DuplicatePriceListDraft> }>;

export async function handlePricingAdminDuplicatePriceList(
  request: NextRequest,
  duplicate: (sourcePriceListId: string, draft: DuplicatePriceListDraft) => Promise<DuplicatePriceListResult> = defaultDuplicate,
  linkEventToPriceList: (eventId: string, priceListId: string) => Promise<string | undefined> = defaultLinkEventToPriceList,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro duplikaci ceníku je vyžadováno přihlášení." }, { status: 401 });
  let body: DuplicateBody;
  try { body = await request.json() as DuplicateBody; }
  catch { return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 }); }
  const draft = body.priceList;
  if (!body.sourcePriceListId || !draft?.name?.trim() || !draft?.code?.trim() || !draft?.currency || !draft?.year) {
    return NextResponse.json({ error: "Chybí povinná pole nového ceníku (název, kód, měna, rok)." }, { status: 400 });
  }
  const normalizedDraft: DuplicatePriceListDraft = {
    name: draft.name.trim(),
    code: draft.code.trim(),
    year: draft.year,
    edition: draft.edition,
    eventId: draft.eventId,
    currency: draft.currency,
    realizationCompanyId: draft.realizationCompanyId,
    validFrom: draft.validFrom,
    validTo: draft.validTo,
    active: draft.active ?? true,
  };
  try {
    const result = await duplicate(body.sourcePriceListId, normalizedDraft);
    let linkWarning: string | undefined;
    if (normalizedDraft.eventId) linkWarning = await linkEventToPriceList(normalizedDraft.eventId, result.priceList.id);
    return NextResponse.json({ ...result, linkWarning });
  } catch (error) {
    if (error instanceof DuplicatePriceListCodeError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof PriceListNotFoundError) return NextResponse.json({ error: error.message }, { status: 404 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Duplikace ceníku selhala (databázová chyba)." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handlePricingAdminDuplicatePriceList(request);
}
