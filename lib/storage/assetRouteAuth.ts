import type { NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "../auth/requestAuth.ts";

export async function isAssetRequestAuthorized(
  request: NextRequest,
  environment: Readonly<{ APP_SESSION_SECRET?: string }> = { APP_SESSION_SECRET: process.env.APP_SESSION_SECRET },
): Promise<boolean> {
  return isSessionRequestAuthorized(request, environment);
}
