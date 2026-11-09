import type { NextRequest } from "next/server.js";
import { NextResponse } from "next/server.js";
import { AUTH_COOKIE_NAME, verifySessionToken } from "./lib/auth/session.ts";

/**
 * First gate only (V1-AUTH-01): a validly signed, unexpired session cookie, otherwise /login (pages)
 * or 401 (API). It does NOT authorize — every API route and page checks the user, the role and the
 * session row itself (lib/auth/requestAuth.ts). The sign-in pages, the link callback and their APIs
 * stay reachable without a session (no redirect loop).
 */
const PUBLIC_PATHS = new Set([
  "/login",
  "/login/zapomenute-heslo",
  "/login/nove-heslo",
  "/auth/callback",
  "/auth/confirm",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/session",
  "/api/auth/callback",
  "/api/auth/password/forgot",
  "/api/auth/password/set",
]);

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next();

  if (await verifySessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value, process.env.APP_SESSION_SECRET)) return NextResponse.next();

  if (pathname.startsWith("/api/")) return NextResponse.json({ error: "Pro tuto akci je vyžadováno přihlášení.", code: "unauthenticated" }, { status: 401 });

  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|_next/webpack-hmr|favicon.ico).*)"],
};
