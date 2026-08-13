import type { NextRequest } from "next/server.js";
import { AUTH_COOKIE_NAME, verifySessionToken } from "../auth/session.ts";

export async function isAssetRequestAuthorized(
  request: NextRequest,
  environment: Readonly<{ APP_SESSION_SECRET?: string }> = { APP_SESSION_SECRET: process.env.APP_SESSION_SECRET },
): Promise<boolean> {
  return verifySessionToken(
    request.cookies.get(AUTH_COOKIE_NAME)?.value,
    environment.APP_SESSION_SECRET,
  );
}
