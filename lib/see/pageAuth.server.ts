import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { AUTH_COOKIE_NAME } from "../auth/session";
import { currentUserFromCookieValue, hasSeeRole, type SeeActor } from "./auth.server";

/** Editor pages: the proxy already requires the portal session; this is the page-level second check. */
export async function requireSeePageActor(nextPath: string): Promise<SeeActor> {
  const cookieStore = await cookies();
  const actor = await currentUserFromCookieValue(cookieStore.get(AUTH_COOKIE_NAME)?.value);
  if (!hasSeeRole(actor, "editor")) redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  return actor;
}
