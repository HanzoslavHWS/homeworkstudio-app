/**
 * Společná administrace (V1-ADMIN-01): one entry "Administrace" with areas and tabs over the
 * EXISTING admin screens, plus the address-bar routing of the workspace (/abf#/…), so a reload or
 * the browser's back button opens the same section. Pure: no React, no I/O. Visibility follows the
 * permission matrix (domain/accessControl.ts); the API checks the same permissions again.
 */
import { can, type AppRole, type Permission, type WorkspaceSection } from "./accessControl.ts";

export const ADMIN_AREAS = [
  {
    id: "catalog",
    label: "Katalog",
    slug: "katalog",
    permission: "catalog.manage",
    tabs: [
      { id: "items", label: "Položky", slug: "polozky" },
      { id: "booths", label: "Knihovna stánků", slug: "stanky" },
      { id: "categories", label: "Kategorie", slug: "kategorie" },
      { id: "variants", label: "Vzorníky", slug: "vzorniky" },
      { id: "import", label: "Import Excelu", slug: "import" },
    ],
  },
  {
    id: "prices",
    label: "Ceníky",
    slug: "ceniky",
    permission: "prices.sale.write",
    tabs: [
      { id: "versions", label: "Verzované ceníky", slug: "verze" },
      { id: "lists", label: "Starší ceníky veletrhů", slug: "starsi" },
      { id: "base", label: "Správa základních cen", slug: "sprava-cen" },
    ],
  },
  { id: "events", label: "Veletrhy", slug: "veletrhy", permission: "events.manage", tabs: [] },
  { id: "companies", label: "Realizační firmy", slug: "firmy", permission: "realizationCompanies.manage", tabs: [] },
  { id: "users", label: "Uživatelé", slug: "uzivatele", permission: "users.manage", tabs: [] },
] as const satisfies readonly Readonly<{ id: string; label: string; slug: string; permission: Permission; tabs: readonly Readonly<{ id: string; label: string; slug: string }>[] }>[];

export type AdminAreaId = (typeof ADMIN_AREAS)[number]["id"];
export type AdminRoute = Readonly<{ area: AdminAreaId; tab?: string; itemId?: string }>;

const areaById = (id: AdminAreaId) => ADMIN_AREAS.find((area) => area.id === id)!;

export function adminAreasFor(role: AppRole | undefined): readonly (typeof ADMIN_AREAS)[number][] {
  return ADMIN_AREAS.filter((area) => can(role, area.permission));
}

export function canOpenAdmin(role: AppRole | undefined): boolean {
  return adminAreasFor(role).length > 0;
}

/** A complete route: an area with tabs always names its tab (the first one by default). */
export function normalizeAdminRoute(route: AdminRoute): AdminRoute {
  const area = areaById(route.area);
  const tabs = area.tabs as readonly { id: string }[];
  if (!tabs.length) return { area: route.area };
  const tab = tabs.some((candidate) => candidate.id === route.tab) ? route.tab! : tabs[0]!.id;
  return { area: route.area, tab, ...(route.area === "catalog" && tab === "items" && route.itemId ? { itemId: route.itemId } : {}) };
}

/** First area (and tab) the role may open — where "Administrace" lands. */
export function defaultAdminRoute(role: AppRole | undefined): AdminRoute | undefined {
  const first = adminAreasFor(role)[0];
  return first ? normalizeAdminRoute({ area: first.id }) : undefined;
}

/**
 * The former sidebar sections of the admin screens — kept as navigation targets (cross-links such
 * as „Otevřít ceník“ from a catalog card) and redirected to their place in the administration.
 */
export const LEGACY_ADMIN_SECTIONS: Readonly<Partial<Record<WorkspaceSection, AdminRoute>>> = {
  components: { area: "catalog", tab: "items" },
  booths: { area: "catalog", tab: "booths" },
  priceVersions: { area: "prices", tab: "versions" },
  priceLists: { area: "prices", tab: "lists" },
  pricingAdmin: { area: "prices", tab: "base" },
  events: { area: "events" },
  realizationCompanies: { area: "companies" },
  users: { area: "users" },
};

/** Operational sections in the address bar (the project editor is the bare /abf). */
const SECTION_SLUGS: Readonly<Partial<Record<WorkspaceSection, string>>> = {
  projects: "projekty",
  tasks: "ukoly",
  customerCatalog: "katalog",
  emails: "emaily",
  printSurfaces: "tiskove-plochy",
  technicalRasters: "technicke-rastry",
  settlementChecks: "kontrola-vyuctovani",
};

export type WorkspaceLocation = Readonly<{ section: "project" }> | Readonly<{ section: Exclude<WorkspaceSection, "project">; admin?: undefined }> | Readonly<{ section: "admin"; admin: AdminRoute }>;

export function workspaceHash(location: WorkspaceLocation): string {
  if (location.section === "project") return "";
  if (location.section === "admin") {
    const route = normalizeAdminRoute(location.admin);
    const area = areaById(route.area);
    const tab = (area.tabs as readonly { id: string; slug: string }[]).find((candidate) => candidate.id === route.tab);
    return `#/administrace/${area.slug}${tab ? `/${tab.slug}` : ""}${route.itemId ? `/${encodeURIComponent(route.itemId)}` : ""}`;
  }
  const legacy = LEGACY_ADMIN_SECTIONS[location.section];
  if (legacy) return workspaceHash({ section: "admin", admin: legacy });
  const slug = SECTION_SLUGS[location.section];
  return slug ? `#/${slug}` : "";
}

/** Address bar → workspace location; unknown paths fall back to the project editor. */
export function parseWorkspaceHash(hash: string): WorkspaceLocation {
  const parts = hash.replace(/^#\/?/u, "").split("/").filter(Boolean).map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (!parts.length) return { section: "project" };
  if (parts[0] === "administrace") {
    const area = ADMIN_AREAS.find((candidate) => candidate.slug === parts[1]) ?? ADMIN_AREAS[0];
    const tab = (area.tabs as readonly { id: string; slug: string }[]).find((candidate) => candidate.slug === parts[2]);
    return { section: "admin", admin: normalizeAdminRoute({ area: area.id, ...(tab ? { tab: tab.id } : {}), ...(parts[3] ? { itemId: parts[3] } : {}) }) };
  }
  const section = (Object.entries(SECTION_SLUGS) as [WorkspaceSection, string][]).find(([, slug]) => slug === parts[0])?.[0];
  return section && section !== "project" ? { section } : { section: "project" };
}
