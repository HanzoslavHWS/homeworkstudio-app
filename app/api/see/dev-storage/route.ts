import { NextResponse, type NextRequest } from "next/server.js";
import { requireViewerEditor } from "../../../../lib/see/auth.server.ts";
import { createSeeDeps, isLocalSeeBackend, type SeeDeps } from "../../../../lib/see/backend.server.ts";
import { verifyTicket } from "../../../../lib/see/security.server.ts";
import { LocalDiskSeeObjectStorage } from "../../../../lib/see/storage.server.ts";

/**
 * LOCAL DEV ONLY — stands in for R2's presigned PUT when SEE_BACKEND=local (never in production:
 * answers 404 there). Requires a valid signed upload ticket AND the portal session. The session is
 * checked HERE because this path is excluded from proxy.ts: Next's proxy buffers request bodies only
 * up to 10 MB, which would truncate large local GLB uploads (production uploads go straight to R2).
 */
export async function handleSeeDevStoragePut(request: NextRequest, depsFactory: () => SeeDeps = createSeeDeps, environment: Readonly<Record<string, string | undefined>> = process.env) {
  if (!isLocalSeeBackend(environment)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const guard = await requireViewerEditor(request);
  if (guard.ok === false) return guard.response;
  const deps = depsFactory();
  if (!(deps.storage instanceof LocalDiskSeeObjectStorage)) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const ticket = verifyTicket(request.nextUrl.searchParams.get("t"), deps.secret, deps.now().getTime());
  if (!ticket || ticket.op !== "put") return NextResponse.json({ error: "Upload ticket vypršel." }, { status: 403 });
  if (request.headers.get("content-type") !== ticket.mime) return NextResponse.json({ error: "Content-Type neodpovídá." }, { status: 400 });
  const file = await deps.repository.getFile(ticket.fileId);
  if (!file || file.storageKey !== ticket.key || file.status !== "pending") return NextResponse.json({ error: "Upload není očekávaný." }, { status: 409 });
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > Math.max(deps.limits.maxModelBytes, deps.limits.maxDocumentBytes)) return NextResponse.json({ error: "Soubor je příliš velký." }, { status: 413 });
  await deps.storage.writeObject(ticket.key, body);
  return new NextResponse(null, { status: 200 });
}

export async function PUT(request: NextRequest) {
  return handleSeeDevStoragePut(request);
}
