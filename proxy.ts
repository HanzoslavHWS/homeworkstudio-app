import type { NextRequest } from "next/server.js";
import { NextResponse } from "next/server.js";
import {
  AUTH_COOKIE_NAME,
  verifySessionToken,
} from "./lib/auth/session.ts";
import { embedFrameAncestorsForSlug } from "./lib/see/embedPolicy.server.ts";
import { embedSlug, seePublicRouteKind, seeResponseHeaders } from "./lib/see/proxyRules.ts";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login"]);

async function withSeeHeaders(response: NextResponse, pathname: string): Promise<NextResponse> {
  const slug = embedSlug(pathname);
  const frameAncestors = slug ? await embedFrameAncestorsForSlug(slug) : undefined;
  const headers = seeResponseHeaders(pathname, { SEE_EMBED_FRAME_ANCESTORS: process.env.SEE_EMBED_FRAME_ANCESTORS }, frameAncestors);
  if (headers) Object.entries(headers).forEach(([name, value]) => response.headers.set(name, value));
  return response;
}

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }
  // HWS SEE: only the explicit share-link routes are public (lib/see/proxyRules.ts); their
  // handlers still enforce publication state and the PIN on the server.
  if (seePublicRouteKind(pathname)) {
    return withSeeHeaders(NextResponse.next(), pathname);
  }

  const validSession = await verifySessionToken(
    request.cookies.get(AUTH_COOKIE_NAME)?.value,
    process.env.APP_SESSION_SECRET,
  );
  if (validSession) {
    return withSeeHeaders(NextResponse.next(), pathname);
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  // api/see/dev-storage: local-development upload target of HWS SEE; it checks the session itself
  // (the proxy would truncate request bodies over 10 MB). It answers 404 outside SEE_BACKEND=local.
  matcher: ["/((?!_next/static|_next/image|_next/webpack-hmr|favicon.ico|api/see/dev-storage).*)"],
};
