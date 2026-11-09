import { cookies } from "next/headers";
import { AUTH_COOKIE_NAME } from "./session.ts";
import { resolveSessionToken, type AuthState } from "./requestAuth.ts";

/** Auth state of the current page request (Server Components) — the same resolver as the API routes. */
export async function getPageAuth(): Promise<AuthState> {
  const cookieStore = await cookies();
  return resolveSessionToken(cookieStore.get(AUTH_COOKIE_NAME)?.value);
}

/** What the browser may know about the signed-in user (no session id, no tokens). */
export type CurrentUser = Readonly<{ id: string; email: string; displayName: string | null; role: "admin" | "user" | "external" }>;
