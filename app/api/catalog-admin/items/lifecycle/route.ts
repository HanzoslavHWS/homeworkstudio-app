import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { bulkLifecycleCatalogItemsAdmin } from "../../../../../lib/db/catalogItemsAdmin.supabase.ts";
import { ConcurrencyConflictError } from "../../../../../lib/db/concurrency.ts";
import {
  InvalidCatalogItemAdminEditError,
  parseBulkLifecycleRequest,
  type BulkLifecycleOutcome,
  type BulkLifecycleRequest,
  type CatalogItemAdmin,
} from "../../../../../domain/catalogItemsAdmin.ts";

type BulkResult = Readonly<{ outcomes: readonly BulkLifecycleOutcome[]; items: readonly CatalogItemAdmin[] }>;

function defaultBulk(request: BulkLifecycleRequest): Promise<BulkResult> {
  return bulkLifecycleCatalogItemsAdmin(createSupabaseServerClient(), request);
}

/** Hromadná archivace / obnova označených položek. Never deletes anything. */
export async function handleCatalogAdminItemsLifecycle(
  request: NextRequest,
  bulk: (request: BulkLifecycleRequest) => Promise<BulkResult> = defaultBulk,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) return NextResponse.json({ error: "Pro archivaci je vyžadováno přihlášení." }, { status: 401 });
  let parsed: BulkLifecycleRequest;
  try {
    parsed = parseBulkLifecycleRequest(await request.json());
  } catch (error) {
    return NextResponse.json({ error: error instanceof InvalidCatalogItemAdminEditError ? error.message : "Neplatný JSON požadavek." }, { status: 400 });
  }
  try {
    return NextResponse.json(await bulk(parsed));
  } catch (error) {
    if (error instanceof ConcurrencyConflictError) return NextResponse.json({ error: "Data byla mezitím změněna jinde. Obnovte stránku." }, { status: 409 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Hromadnou akci se nepodařilo provést." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleCatalogAdminItemsLifecycle(request);
}
