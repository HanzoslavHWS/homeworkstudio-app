import { NextResponse, type NextRequest } from "next/server.js";
import { AUTH_COOKIE_NAME, verifySessionToken } from "../auth/session.ts";

/**
 * HWS SEE identity adapter — the ONLY place the module asks "who is this?".
 *
 * Today's production login (app/api/auth/login) is one shared password that yields a server-signed
 * HMAC session cookie (lib/auth/session.ts). The session is verified on the server for every SEE
 * editor request, but it carries NO personal identity. So the adapter returns an honest shared
 * actor ("Současný portálový účet") instead of inventing people; created_by/updated_by store its
 * id `portal:shared`.
 *
 * Future unified login: replace `resolveActor` with a lookup of the real account and its
 * membership in the application `hws-see` (entitlement SEE_ENTITLEMENT, roles editor/admin). Every
 * route already goes through requireViewerEditor / requireViewerAdmin, so nothing else changes.
 */

export const SEE_APP_KEY = "hws-see";
export const SEE_ENTITLEMENT = "hws_see";
export const SEE_ROLES = ["editor", "admin"] as const;
export type SeeRole = (typeof SEE_ROLES)[number];

export type SeeActor = Readonly<{
  id: string;
  label: string;
  kind: "shared-portal-session";
  entitlements: readonly string[];
  roles: readonly SeeRole[];
}>;

export const SHARED_PORTAL_ACTOR: SeeActor = {
  id: "portal:shared",
  label: "Současný portálový účet",
  kind: "shared-portal-session",
  // The shared portal session has always been allowed to use every enabled launcher application;
  // HWS SEE keeps that rule instead of inventing a per-person permission that does not exist yet.
  entitlements: [SEE_ENTITLEMENT],
  roles: ["editor", "admin"],
};

type SessionEnvironment = Readonly<{ APP_SESSION_SECRET?: string }>;

async function resolveActor(sessionCookie: string | undefined, environment: SessionEnvironment): Promise<SeeActor | null> {
  return (await verifySessionToken(sessionCookie, environment.APP_SESSION_SECRET)) ? SHARED_PORTAL_ACTOR : null;
}

export async function currentUser(request: NextRequest, environment: SessionEnvironment = { APP_SESSION_SECRET: process.env.APP_SESSION_SECRET }): Promise<SeeActor | null> {
  return resolveActor(request.cookies.get(AUTH_COOKIE_NAME)?.value, environment);
}

/** For server components (pages): same rule as currentUser, reading next/headers cookies. */
export async function currentUserFromCookieValue(sessionCookie: string | undefined): Promise<SeeActor | null> {
  return resolveActor(sessionCookie, { APP_SESSION_SECRET: process.env.APP_SESSION_SECRET });
}

export function hasSeeRole(actor: SeeActor | null, role: SeeRole): actor is SeeActor {
  return Boolean(actor && actor.entitlements.includes(SEE_ENTITLEMENT) && actor.roles.includes(role));
}

type Guard = Readonly<{ ok: true; actor: SeeActor }> | Readonly<{ ok: false; response: NextResponse }>;

async function requireRole(request: NextRequest, role: SeeRole, environment?: SessionEnvironment): Promise<Guard> {
  const actor = await currentUser(request, environment);
  if (!actor) return { ok: false, response: NextResponse.json({ error: "Pro HWS SEE je vyžadováno přihlášení do portálu." }, { status: 401 }) };
  if (!hasSeeRole(actor, role)) return { ok: false, response: NextResponse.json({ error: "Tento účet nemá oprávnění k HWS SEE." }, { status: 403 }) };
  return { ok: true, actor };
}

export function requireViewerEditor(request: NextRequest, environment?: SessionEnvironment): Promise<Guard> {
  return requireRole(request, "editor", environment);
}

export function requireViewerAdmin(request: NextRequest, environment?: SessionEnvironment): Promise<Guard> {
  return requireRole(request, "admin", environment);
}
