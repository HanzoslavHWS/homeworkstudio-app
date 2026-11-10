/**
 * V1-AUTH-01 — roles and permissions of ABF, the ONE matrix every check uses (API routes, pages,
 * navigation). Pure: no I/O. The server resolves the signed-in user's ABF role from the account's
 * ABF membership (app_memberships, V1-AUTH-02 — never from the client) and asks `can(role,
 * permission)`; an account without an ABF membership has no role and no ABF access at all.
 * Project-scoped access additionally needs an assignment (`projectAccess`). Hiding a menu item is
 * only navigation — the API checks the same permission again. Shared account administration is a
 * separate permission (domain/hwsApps.ts canManageAccounts), not part of this matrix.
 *
 *   SPRÁVCE (admin)    everything, incl. users, roles, project assignments and global administration
 *   BĚŽNÝ (user)       operational modules + assigned (or self-created) projects; reads the operational
 *                      registers it needs (catalog, sale/purchase prices, events, firms); no user/role
 *                      management and no global administration (catalog/price/event/firm editing)
 *   EXTERNÍ (external) only views explicitly assigned projects and their allowed outputs; no editing,
 *                      no global catalog, no internal purchase prices, no other data
 */

export const APP_ROLES = ["admin", "user", "external"] as const;
export type AppRole = (typeof APP_ROLES)[number];

export const APP_ROLE_LABELS_CS: Readonly<Record<AppRole, string>> = { admin: "Správce", user: "Běžný", external: "Externí" };

export function isAppRole(value: unknown): value is AppRole {
  return typeof value === "string" && (APP_ROLES as readonly string[]).includes(value);
}

/** Global (not project-scoped) permissions. Project access is decided by projectAccess(). */
export const PERMISSIONS = [
  // user accounts, roles, project assignments
  "users.manage",
  // 3D projects (zakázky) — scope decided by projectAccess(); these only say what the role may do at all
  "projects.create",
  "projects.viewAll",
  // catalog
  "catalog.read",
  "catalog.manage",
  // Excel import of the catalog template (Administrace → Katalog komponent → Import Excel) — admin only
  "catalog.import",
  "customerCatalog.use",
  // prices (V1-DATA-05 split: sale and purchase are separate)
  "prices.sale.read",
  "prices.sale.write",
  "prices.purchase.read",
  "prices.purchase.write",
  // events and realization firms
  "events.read",
  "events.manage",
  "realizationCompanies.read",
  "realizationCompanies.manage",
  // operational modules
  "tasks.use",
  "emails.use",
  "printSurfaces.use",
  "printSurfaces.catalogSync",
  "technicalRasters.use",
  "settlement.use",
  "ai.use",
  "files.temporary",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

const OPERATIONAL: readonly Permission[] = [
  "projects.create",
  "catalog.read",
  "customerCatalog.use",
  "prices.sale.read",
  "prices.purchase.read",
  "events.read",
  "realizationCompanies.read",
  "tasks.use",
  "emails.use",
  "printSurfaces.use",
  "technicalRasters.use",
  "settlement.use",
  "ai.use",
  "files.temporary",
];

export const ROLE_PERMISSIONS: Readonly<Record<AppRole, ReadonlySet<Permission>>> = {
  admin: new Set(PERMISSIONS),
  user: new Set(OPERATIONAL),
  external: new Set<Permission>(),
};

export function can(role: AppRole | undefined, permission: Permission): boolean {
  return role !== undefined && ROLE_PERMISSIONS[role].has(permission);
}

export function permissionsOf(role: AppRole | undefined): readonly Permission[] {
  return role === undefined ? [] : PERMISSIONS.filter((permission) => ROLE_PERMISSIONS[role].has(permission));
}

// ---------------------------------------------------------------------------------------------
// Project scope
// ---------------------------------------------------------------------------------------------
export type ProjectAction = "read" | "write" | "delete";

/**
 * Access to ONE 3D project. `isMember` = an explicit assignment in project_members. A project that
 * does not exist yet (first save / first upload of a new project) may be created by anyone with
 * projects.create; the creator is assigned automatically.
 */
export function projectAccess(role: AppRole | undefined, action: ProjectAction, context: Readonly<{ isMember: boolean; exists: boolean }>): boolean {
  // No ABF role (no membership): a remaining project assignment never opens the project (V1-AUTH-02).
  if (role === undefined) return false;
  if (role === "admin") return true;
  if (!context.exists) return action !== "read" && can(role, "projects.create");
  if (!context.isMember) return false;
  if (role === "external") return action === "read";
  return true;
}

// ---------------------------------------------------------------------------------------------
// Files (R2 storage keys) — the key prefix names the owning module (domain/assets.ts CATEGORY_RULES)
// ---------------------------------------------------------------------------------------------
export type FileAction = "read" | "write";
export type FileScope =
  | Readonly<{ kind: "project"; projectId: string; folder: string }>
  | Readonly<{ kind: "global"; permission: Permission }>
  | Readonly<{ kind: "invalid" }>;

/** Project folders an EXTERNAL user may download from an assigned project (the outputs). */
export const EXTERNAL_PROJECT_OUTPUT_FOLDERS: readonly string[] = ["exports", "visualizations", "floorplans"];

/** What protects a storage key, for reading or writing. */
export function fileScope(storageKey: string, action: FileAction): FileScope {
  const [root, owner, folder] = storageKey.split("/");
  if (!root || !owner) return { kind: "invalid" };
  switch (root) {
    case "projects":
      return folder ? { kind: "project", projectId: owner, folder } : { kind: "invalid" };
    case "catalog":
      return { kind: "global", permission: action === "read" ? "catalog.read" : "catalog.manage" };
    case "events":
      return { kind: "global", permission: action === "read" ? "events.read" : "events.manage" };
    case "print-surfaces":
      return { kind: "global", permission: "printSurfaces.use" };
    case "technical-rasters":
      return { kind: "global", permission: "technicalRasters.use" };
    case "temporary":
      return { kind: "global", permission: "files.temporary" };
    default:
      return { kind: "invalid" };
  }
}

/** Project-file rule on top of projectAccess: externals read only the output folders. */
export function projectFileAccess(role: AppRole | undefined, action: FileAction, folder: string, context: Readonly<{ isMember: boolean; exists: boolean }>): boolean {
  if (!projectAccess(role, action === "read" ? "read" : "write", context)) return false;
  return role !== "external" || EXTERNAL_PROJECT_OUTPUT_FOLDERS.includes(folder);
}

// ---------------------------------------------------------------------------------------------
// Navigation (UX only — the server enforces the same permissions)
// ---------------------------------------------------------------------------------------------
export type WorkspaceSection = "project" | "projects" | "tasks" | "booths" | "components" | "customerCatalog" | "events" | "priceLists" | "pricingAdmin" | "emails" | "printSurfaces" | "technicalRasters" | "settlementChecks" | "realizationCompanies" | "priceVersions" | "users" | "admin";

export const SECTION_PERMISSION: Readonly<Record<WorkspaceSection, Permission>> = {
  project: "projects.create",
  projects: "projects.create",
  tasks: "tasks.use",
  booths: "catalog.manage",
  components: "catalog.manage",
  customerCatalog: "customerCatalog.use",
  events: "events.manage",
  priceLists: "prices.sale.write",
  pricingAdmin: "prices.sale.write",
  priceVersions: "prices.sale.write",
  emails: "emails.use",
  printSurfaces: "printSurfaces.use",
  technicalRasters: "technicalRasters.use",
  settlementChecks: "settlement.use",
  realizationCompanies: "realizationCompanies.manage",
  users: "users.manage",
  // the shared administration: opened when the role may manage at least one area (domain/adminNavigation.ts)
  admin: "users.manage",
};

/** Permissions that open an area of the shared administration (Katalog, Ceníky, Veletrhy, Firmy, Uživatelé). */
export const ADMIN_PERMISSIONS: readonly Permission[] = ["catalog.manage", "prices.sale.write", "events.manage", "realizationCompanies.manage", "users.manage"];

export function canOpenSection(role: AppRole | undefined, section: WorkspaceSection): boolean {
  if (section === "admin") return ADMIN_PERMISSIONS.some((permission) => can(role, permission));
  return can(role, SECTION_PERMISSION[section]);
}

// ---------------------------------------------------------------------------------------------
// Return URL after login — internal paths only, never another origin
// ---------------------------------------------------------------------------------------------
const AUTH_PATHS = ["/login", "/auth", "/api/"];

export function safeReturnPath(value: unknown): string {
  if (typeof value !== "string") return "/";
  const trimmed = value.trim();
  // Only an absolute path on this origin: "/x". Refuse "//host", "/\host", schemes, control chars.
  if (!trimmed.startsWith("/") || trimmed.startsWith("//") || trimmed.startsWith("/\\") || /[\u0000-\u001f\u007f\\]/u.test(trimmed) || trimmed.length > 1000) return "/";
  let url: URL;
  try {
    url = new URL(trimmed, "http://internal.invalid");
  } catch {
    return "/";
  }
  if (url.origin !== "http://internal.invalid") return "/";
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (AUTH_PATHS.some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))) return "/";
  return path;
}
