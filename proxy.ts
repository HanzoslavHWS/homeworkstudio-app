import type { NextRequest } from "next/server.js";
import { NextResponse } from "next/server.js";
import {
  AUTH_COOKIE_NAME,
  verifySessionToken,
} from "./lib/auth/session.ts";

const PUBLIC_PATHS = new Set(["/login", "/api/auth/login"]);

export async function proxy(request: NextRequest) {
  const pathname = request.nextUrl.pathname;
  if (PUBLIC_PATHS.has(pathname)) {
    return NextResponse.next();
  }

  const validSession = await verifySessionToken(
    request.cookies.get(AUTH_COOKIE_NAME)?.value,
    process.env.APP_SESSION_SECRET,
  );
  if (validSession) {
    return NextResponse.next();
  }

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", `${pathname}${request.nextUrl.search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|_next/webpack-hmr|favicon.ico).*)"],
};
