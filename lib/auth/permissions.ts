import type { NextRequest, NextResponse } from "next/server.js";
import type { Permission } from "../../domain/accessControl.ts";
import { authorize } from "./requestAuth.ts";

/**
 * Permission check as an injectable dependency (price modules, V1-DATA-05). The matrix itself lives
 * in domain/accessControl.ts; the default check is the shared authorize() of lib/auth/requestAuth.ts.
 * Returns true when allowed, otherwise the response to send (401 / 403 / 503) — or plain false from
 * a test double, which the caller answers with 401.
 */
export type { Permission };
export type PermissionCheck = (request: NextRequest, permission: Permission) => Promise<boolean | NextResponse>;

export const requestHasPermission: PermissionCheck = async (request, permission) => {
  const decision = await authorize(request, permission);
  return decision.ok === false ? decision.response : true;
};
