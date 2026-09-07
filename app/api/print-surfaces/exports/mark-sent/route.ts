import { NextResponse, type NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../../../../../lib/auth/requestAuth.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../../../../../lib/db/supabase.server.ts";
import { SupabasePrintSurfaceExportRepository } from "../../../../../lib/db/printSurfaceExportRepository.supabase.ts";
import type { PrintSurfaceExportMarkSentInput, PrintSurfaceExportRepository } from "../../../../../domain/printSurfaceExport.ts";

function defaultRepositoryFactory(): PrintSurfaceExportRepository {
  return new SupabasePrintSurfaceExportRepository(createSupabaseServerClient());
}

/**
 * Spec section 10/14: the ONLY server-side write that stamps sentAt/sentBy on an export record —
 * always a distinct, later, explicitly user-confirmed action ("Potvrdit jako odesláno" in
 * PrintSurfaceExportPanel.tsx, gated behind the email handoff flow), never bundled into
 * exports/create. This app has no real Outlook/SMTP send integration (EmailsPage.tsx's "Otevřít v
 * Outlooku" is a `mailto:` handoff to the user's own mail client) — calling this endpoint is a
 * record of "the user confirmed they actually sent it", not proof of a server-verified send.
 */
export async function handlePrintSurfaceExportMarkSent(
  request: NextRequest,
  repositoryFactory: () => PrintSurfaceExportRepository = defaultRepositoryFactory,
): Promise<NextResponse> {
  if (!(await isSessionRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro označení exportu jako odeslaného je vyžadováno přihlášení." }, { status: 401 });
  }
  let body: Partial<PrintSurfaceExportMarkSentInput> & { id?: string };
  try {
    body = (await request.json()) as Partial<PrintSurfaceExportMarkSentInput> & { id?: string };
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
  if (!body.id) return NextResponse.json({ error: "Chybí id exportu." }, { status: 400 });
  try {
    const record = await repositoryFactory().markSent(body.id, { recipient: body.recipient, language: body.language, sentBy: body.sentBy });
    return NextResponse.json({ export: record });
  } catch (error) {
    if (error instanceof SupabaseConfigurationError) return NextResponse.json({ error: error.message }, { status: 503 });
    return NextResponse.json({ error: "Označení exportu jako odeslaného selhalo." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handlePrintSurfaceExportMarkSent(request);
}
