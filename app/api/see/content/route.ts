import { NextResponse, type NextRequest } from "next/server.js";
import { buildContentDispositionHeader } from "../../../../domain/assets.ts";
import { createSeeDeps, type SeeDeps } from "../../../../lib/see/backend.server.ts";
import { seeErrorResponse } from "../../../../lib/see/http.server.ts";
import { openContent } from "../../../../lib/see/service.server.ts";

/**
 * PUBLIC by capability: streams one object for a valid, short-lived signed ticket (local dev, or
 * SEE_FILE_DELIVERY=stream). Public tickets are re-checked against the live publication state on
 * every request (lib/see/service.server.ts openContent).
 */
export async function handleSeeContent(request: NextRequest, depsFactory: () => SeeDeps = createSeeDeps) {
  try {
    const content = await openContent(depsFactory(), request.nextUrl.searchParams.get("t"));
    if (!content) {
      return NextResponse.json({ error: "Odkaz na soubor vypršel nebo již neplatí." }, { status: 403, headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
    }
    const headers: Record<string, string> = {
      "Content-Type": content.payload.mime,
      "Cache-Control": "private, no-store, max-age=0",
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
      // Uploaded bytes are never treated as an active document of the portal origin.
      "Content-Security-Policy": "default-src 'none'; sandbox; frame-ancestors 'none'",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Content-Disposition": buildContentDispositionHeader(content.payload.name ?? "soubor", content.payload.attachment ? "attachment" : "inline"),
    };
    if (content.contentLength !== undefined) headers["Content-Length"] = String(content.contentLength);
    return new NextResponse(content.body, { status: 200, headers });
  } catch (error) {
    return seeErrorResponse(error, true);
  }
}

export async function GET(request: NextRequest) {
  return handleSeeContent(request);
}
