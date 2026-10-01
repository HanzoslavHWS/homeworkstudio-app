import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../lib/db/supabase.server.ts";
import { readKodyRowsFromBuffer } from "../../../../lib/import/kodyReader.server.ts";
import { applyAbfImport, previewAbfImport } from "../../../../lib/db/catalogAbfImport.supabase.ts";
import { CatalogSchemaNotMigratedError } from "../../../../lib/db/catalogItemsAdmin.supabase.ts";
import { KodyFormatError, type KodyRow } from "../../../../domain/catalogAbfImport.ts";
import { fingerprintBytes } from "../../../../domain/importBatch.ts";

const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export type AbfImportHandlers = Readonly<{
  readRows: (buffer: Buffer) => Promise<readonly KodyRow[]>;
  preview: (rows: readonly KodyRow[], sourceFile: string, links: Readonly<Record<string, string>>) => Promise<unknown>;
  apply: (rows: readonly KodyRow[], sourceFile: string, fingerprint: string, links: Readonly<Record<string, string>>) => Promise<unknown>;
}>;

const defaultHandlers: AbfImportHandlers = {
  readRows: readKodyRowsFromBuffer,
  preview: (rows, sourceFile, links) => previewAbfImport(createSupabaseServerClient(), rows, sourceFile, links),
  apply: (rows, sourceFile, fingerprint, links) => applyAbfImport(createSupabaseServerClient(), rows, sourceFile, fingerprint, links),
};

function parseLinkConfirmations(raw: FormDataEntryValue | null): Readonly<Record<string, string>> {
  if (typeof raw !== "string" || !raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string" && Boolean(entry[1])),
  );
}

/**
 * KODY.xlsm import. mode=preview (default) never writes; mode=apply re-plans server-side against
 * the current catalog and writes only create/update rows (see lib/db/catalogAbfImport.supabase.ts).
 */
export async function handleAbfImport(request: NextRequest, handlers: AbfImportHandlers = defaultHandlers): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro import katalogu je vyžadováno přihlášení." }, { status: 401 });
  }
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return NextResponse.json({ error: "Neplatný požadavek — očekáván nahraný soubor." }, { status: 400 });
  }
  const file = formData.get("file");
  if (!(file instanceof File)) return NextResponse.json({ error: "Chybí soubor k importu." }, { status: 400 });
  if (file.size === 0) return NextResponse.json({ error: "Soubor je prázdný." }, { status: 400 });
  if (file.size > MAX_UPLOAD_BYTES) return NextResponse.json({ error: "Soubor je příliš velký." }, { status: 413 });
  const mode = formData.get("mode") === "apply" ? "apply" : "preview";
  let links: Readonly<Record<string, string>>;
  try {
    links = parseLinkConfirmations(formData.get("linkConfirmations"));
  } catch {
    return NextResponse.json({ error: "Neplatné potvrzení propojení." }, { status: 400 });
  }

  let buffer: Buffer;
  let rows: readonly KodyRow[];
  try {
    buffer = Buffer.from(await file.arrayBuffer());
    rows = await handlers.readRows(buffer);
  } catch (error) {
    if (error instanceof KodyFormatError) return NextResponse.json({ error: error.message }, { status: 422 });
    return NextResponse.json({ error: "Soubor se nepodařilo zpracovat jako XLSX/XLSM." }, { status: 422 });
  }

  try {
    if (mode === "preview") return NextResponse.json({ preview: await handlers.preview(rows, file.name, links) });
    return NextResponse.json({ result: await handlers.apply(rows, file.name, fingerprintBytes(new Uint8Array(buffer)), links) });
  } catch (error) {
    if (error instanceof CatalogSchemaNotMigratedError) return NextResponse.json({ error: error.message }, { status: 409 });
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Import se nepodařilo provést v databázi." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleAbfImport(request);
}
