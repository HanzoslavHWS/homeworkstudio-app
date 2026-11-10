/**
 * V1-AUTH-02 — shared HomeworkStudio accounts and per-application access. Pure: no I/O.
 *
 * Three levels:
 *   ACCOUNT        one person = one account (app_users): identity, name, e-mail, active state
 *   HWS ADMIN      may manage the shared accounts and their access (app_users.is_hws_admin) —
 *                  says nothing about the data of any application
 *   MEMBERSHIP     access to ONE application with a role valid for that application
 *                  (app_memberships, one row per account × application)
 *
 * No membership = no access. A deactivated account is blocked everywhere; removing a membership
 * blocks only that application. The ABF admin role does not make anyone an HWS admin and the HWS
 * admin flag does not open any application.
 *
 * The registry here mirrors the hws_apps table (stable keys; the database refuses a role an
 * application does not define). A "coming soon" application never opens an address.
 */
import { APP_ROLE_LABELS_CS, APP_ROLES } from "./accessControl.ts";

export const HWS_APP_KEYS = ["abf", "hws-easy"] as const;
export type HwsAppKey = (typeof HWS_APP_KEYS)[number];
export type HwsAppStatus = "available" | "coming_soon";

export type HwsAppDefinition = Readonly<{
  key: HwsAppKey;
  name: string;
  /** Address inside this deployment; null while the application does not exist. */
  url: string | null;
  status: HwsAppStatus;
  roles: readonly string[];
  roleLabels: Readonly<Record<string, string>>;
  /** Role pre-selected when the application is ticked in an invitation. */
  defaultRole: string;
}>;

export const HWS_APPS: readonly HwsAppDefinition[] = [
  { key: "abf", name: "ABF Generator", url: "/abf", status: "available", roles: APP_ROLES, roleLabels: APP_ROLE_LABELS_CS, defaultRole: "user" },
  // HWS Easy is a prepared launcher card only — no application exists yet, so it opens nothing.
  { key: "hws-easy", name: "HWS Easy", url: null, status: "coming_soon", roles: ["user"], roleLabels: { user: "Uživatel" }, defaultRole: "user" },
];

export function hwsApp(key: string): HwsAppDefinition | undefined {
  return HWS_APPS.find((app) => app.key === key);
}

export function isHwsAppKey(value: unknown): value is HwsAppKey {
  return typeof value === "string" && (HWS_APP_KEYS as readonly string[]).includes(value);
}

export function isValidAppRole(appKey: string, role: unknown): boolean {
  const app = hwsApp(appKey);
  return Boolean(app && typeof role === "string" && app.roles.includes(role));
}

export function appRoleLabel(appKey: string, role: string): string {
  return hwsApp(appKey)?.roleLabels[role] ?? role;
}

/** Memberships of one account: application key → role. */
export type AppMemberships = Readonly<Partial<Record<HwsAppKey, string>>>;

export type AccountAccess = Readonly<{ isActive: boolean; isHwsAdmin: boolean; apps: AppMemberships }>;

/** May this account use the application at all (active account + membership)? */
export function hasAppAccess(account: AccountAccess, appKey: HwsAppKey): boolean {
  return account.isActive && account.apps[appKey] !== undefined;
}

/** Shared account administration — its own permission, independent of any application role. */
export function canManageAccounts(account: AccountAccess | undefined): boolean {
  return Boolean(account?.isActive && account.isHwsAdmin);
}

export type LauncherEntry = Readonly<{ app: HwsAppDefinition; role: string; opens: boolean }>;

/**
 * What the launcher shows: only applications the account has a membership in. A permitted
 * application that is still being prepared is listed as "Připravujeme" and never opens.
 */
export function launcherEntries(account: AccountAccess): readonly LauncherEntry[] {
  if (!account.isActive) return [];
  return HWS_APPS.flatMap((app) => {
    const role = account.apps[app.key];
    return role === undefined ? [] : [{ app, role, opens: app.status === "available" && app.url !== null }];
  });
}

export type RequestedAccess = Readonly<{ appKey: HwsAppKey; role: string }>;

/**
 * Validates the access part of an invitation / edit: every ticked application must exist and get a
 * role valid for it; an application can appear once. Unticked applications are simply absent (their
 * role is never used).
 */
export function parseRequestedAccess(value: unknown): Readonly<{ ok: true; access: readonly RequestedAccess[] }> | Readonly<{ ok: false; error: string }> {
  if (!Array.isArray(value)) return { ok: false, error: "Chybí seznam přístupů." };
  const seen = new Set<string>();
  const access: RequestedAccess[] = [];
  for (const entry of value) {
    const appKey = (entry as { appKey?: unknown } | null)?.appKey;
    const role = (entry as { role?: unknown } | null)?.role;
    if (!isHwsAppKey(appKey)) return { ok: false, error: "Neznámá aplikace." };
    if (seen.has(appKey)) return { ok: false, error: `Aplikace ${hwsApp(appKey)!.name} je v seznamu dvakrát.` };
    if (!isValidAppRole(appKey, role)) return { ok: false, error: `Role pro ${hwsApp(appKey)!.name} není platná.` };
    seen.add(appKey);
    access.push({ appKey, role: role as string });
  }
  return { ok: true, access };
}

/** State of an account invitation, as stored in account_invitations.status. */
export const INVITATION_STATUSES = ["access_pending", "ready", "sent", "send_failed"] as const;
export type InvitationStatus = (typeof INVITATION_STATUSES)[number];

export const INVITATION_STATUS_LABELS_CS: Readonly<Record<InvitationStatus, string>> = {
  access_pending: "Nedokončená — přístupy se neuložily",
  ready: "Připravená — odkaz k ručnímu předání",
  sent: "Odeslaná e-mailem",
  send_failed: "Odeslání selhalo — lze zopakovat",
};

/** The invitation counts as successful only once the requested access is stored. */
export function invitationSucceeded(status: InvitationStatus): boolean {
  return status !== "access_pending";
}
