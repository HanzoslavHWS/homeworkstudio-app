import type { NextRequest } from "next/server.js";
import { AUTH_COOKIE_NAME, verifySessionToken } from "./session.ts";

/**
 * Session check shared by every authenticated API route (assets, projects, events, ...).
 * Kept as a thin, generically-named wrapper so new routes don't have to import something
 * named "isAssetRequestAuthorized" — the underlying check has never been asset-specific.
 */
export async function isSessionRequestAuthorized(
  request: NextRequest,
  environment: Readonly<{ APP_SESSION_SECRET?: string }> = { APP_SESSION_SECRET: process.env.APP_SESSION_SECRET },
): Promise<boolean> {
  return verifySessionToken(request.cookies.get(AUTH_COOKIE_NAME)?.value, environment.APP_SESSION_SECRET);
}
