import { NextResponse, type NextRequest } from "next/server";
import {
  AUTH_COOKIE_NAME,
  sessionCookieOptions,
} from "../../../../lib/auth/session";

export async function POST(request: NextRequest) {
  const response = NextResponse.redirect(new URL("/login", request.url), 303);
  response.cookies.set(AUTH_COOKIE_NAME, "", {
    ...sessionCookieOptions(),
    maxAge: 0,
  });
  return response;
}
