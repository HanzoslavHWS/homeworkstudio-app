import { NextResponse, type NextRequest } from "next/server";
import { passwordsMatch, safeReturnPath } from "../../../../lib/auth/password";
import {
  AUTH_COOKIE_NAME,
  createSessionToken,
  isSessionSecretConfigured,
  sessionCookieOptions,
} from "../../../../lib/auth/session";

export async function POST(request: NextRequest) {
  const formData = await request.formData();
  const password = formData.get("password");
  const configuredPassword = process.env.APP_LOGIN_PASSWORD;
  const sessionSecret = process.env.APP_SESSION_SECRET;
  const returnPath = safeReturnPath(formData.get("next"));

  if (!configuredPassword || !isSessionSecretConfigured(sessionSecret)) {
    return NextResponse.redirect(new URL("/login?error=config", request.url), 303);
  }

  if (
    typeof password !== "string" ||
    !passwordsMatch(password, configuredPassword)
  ) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("error", "invalid");
    loginUrl.searchParams.set("next", returnPath);
    return NextResponse.redirect(loginUrl, 303);
  }

  const response = NextResponse.redirect(new URL(returnPath, request.url), 303);
  response.cookies.set(
    AUTH_COOKIE_NAME,
    await createSessionToken(sessionSecret),
    sessionCookieOptions(),
  );
  return response;
}
