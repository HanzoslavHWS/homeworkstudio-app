import type { NextRequest } from "next/server.js";
import { isSessionRequestAuthorized } from "./requestAuth.ts";

/**
 * Permissions of the price modules (V1-DATA-05). Sale and purchase prices are separate permissions
 * and separate API routes, so a route serving sale prices can never be granted access to purchase
 * prices by accident.
 *
 * Today the app has ONE shared login and no user accounts, so a valid session maps to every
 * permission below. When user accounts and roles arrive, only sessionPermissions() changes; every
 * route already asks for the specific permission it needs.
 */
export const PERMISSIONS = ["prices.sale.read", "prices.sale.write", "prices.purchase.read", "prices.purchase.write"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export function sessionPermissions(sessionValid: boolean): ReadonlySet<Permission> {
  return new Set(sessionValid ? PERMISSIONS : []);
}

export type PermissionCheck = (request: NextRequest, permission: Permission) => Promise<boolean>;

export const requestHasPermission: PermissionCheck = async (request, permission) => sessionPermissions(await isSessionRequestAuthorized(request)).has(permission);
