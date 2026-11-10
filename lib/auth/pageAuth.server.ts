import { cookies } from "next/headers";
import type { AppRole } from "../../domain/accessControl.ts";
import type { AppMemberships } from "../../domain/hwsApps.ts";
import type { AuthUser } from "./authStore.server.ts";
import { AUTH_COOKIE_NAME } from "./session.ts";
import { resolveSessionToken, type AuthState } from "./requestAuth.ts";

/** Auth state of the current page request (Server Components) — the same resolver as the API routes. */
export async function getPageAuth(): Promise<AuthState> {
  const cookieStore = await cookies();
  return resolveSessionToken(cookieStore.get(AUTH_COOKIE_NAME)?.value);
}

/**
 * What the browser may know about the signed-in account (no session id, no tokens): identity, the
 * ABF role (absent without ABF access), every application membership and the shared-admin flag.
 * Display only — every request is decided by the server again.
 */
export type CurrentUser = Readonly<{ id: string; email: string; displayName: string | null; role?: AppRole; isHwsAdmin: boolean; apps: AppMemberships }>;

export function currentUserOf(user: AuthUser): CurrentUser {
  return { id: user.id, email: user.email, displayName: user.displayName, ...(user.role ? { role: user.role } : {}), isHwsAdmin: user.isHwsAdmin, apps: user.apps };
}
