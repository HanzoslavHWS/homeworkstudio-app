import { APP_ROLE_LABELS_CS, canOpenSection, type AppRole, type WorkspaceSection } from "../domain/accessControl";
import type { CurrentUser } from "../lib/auth/pageAuth.server";
import { UserMenu } from "./auth/UserMenu";

type NavigableSection = Exclude<WorkspaceSection, "project">;

type AppSidebarProps = {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onStartNewProject: () => void;
  activeSection?: WorkspaceSection;
  onNavigate?: (section: NavigableSection) => void;
  /** Úkoly badge: overdue + today's open tasks (domain/tasks.ts computeTaskCounts().attention). 0/undefined hides it. */
  taskBadge?: number;
  /** Nápověda a podpora badge (V1-SUPPORT-01): new reports for app admins, reports waiting for the user's reply. */
  supportBadge?: Readonly<{ count: number; label: string }>;
  /** Signed-in user (V1-AUTH-01): only sections the role may open are offered — the server checks again on every request. */
  user?: CurrentUser;
};

/** Operational modules; all admin screens are reached through the one "Administrace" entry (domain/adminNavigation.ts). */
const NAV_ITEMS: readonly Readonly<{ section: NavigableSection; icon: string; label: string; title: string }>[] = [
  { section: "projects", icon: "▽", label: "Projekty", title: "Projekty" },
  { section: "tasks", icon: "☑", label: "Úkoly", title: "Úkoly" },
  { section: "customerCatalog", icon: "▤", label: "Katalog", title: "Katalog — zákaznický výstup (PDF)" },
  { section: "emails", icon: "✉", label: "E-maily", title: "E-maily" },
  { section: "printSurfaces", icon: "▧", label: "Tiskové plochy", title: "Tiskové plochy" },
  { section: "technicalRasters", icon: "▥", label: "Technické rastry", title: "Technické rastry" },
  { section: "settlementChecks", icon: "⇄", label: "Kontrola vyúčtování", title: "Kontrola vyúčtování realizaček" },
  { section: "support", icon: "?", label: "Nápověda a podpora", title: "Nápověda a podpora — návody, FAQ a hlášení chyb" },
  { section: "admin", icon: "⚙", label: "Administrace", title: "Administrace — katalog, ceníky, veletrhy, realizační firmy, uživatelé" },
];

export function AppSidebar({
  collapsed,
  onToggleCollapsed,
  onStartNewProject,
  activeSection = "project",
  onNavigate,
  taskBadge,
  supportBadge,
  user,
}: AppSidebarProps) {
  const role: AppRole | undefined = user?.role;
  const allowed = (section: WorkspaceSection) => role !== undefined && canOpenSection(role, section);
  return (
    <aside className={collapsed ? "sidebar collapsed" : "sidebar"}>
      <button
        type="button"
        className="sidebarToggle"
        onClick={onToggleCollapsed}
        aria-label={collapsed ? "Rozbalit hlavní navigaci" : "Sbalit hlavní navigaci"}
        aria-expanded={!collapsed}
      >
        {collapsed ? "›" : "‹"}
      </button>

      <a href="https://homeworkstudio.cz" className="logo" title="Homework Studio">
        <span className="logoCompact">HW</span>
        <span className="logoMain">HOMEWORK</span>
        <span className="logoSub">STUDIO</span>
      </a>

      <nav className="nav">
        {allowed("project") && (
          <button type="button" className={activeSection === "project" ? "navItem active" : "navItem"} onClick={onStartNewProject} title="Nový projekt">
            <span className="navIcon">＋</span>
            <span className="navLabel">Nový projekt</span>
          </button>
        )}
        {NAV_ITEMS.filter((item) => allowed(item.section)).map((item) => {
          const badge = item.section === "tasks" ? taskBadge : item.section === "support" ? supportBadge?.count : undefined;
          const badgeLabel = item.section === "support" ? supportBadge?.label : `${badge} úkolů po termínu nebo na dnes`;
          return (
            <button
              key={item.section}
              type="button"
              className={activeSection === item.section ? "navItem active" : "navItem"}
              title={badge ? `${item.label} — ${badgeLabel}` : item.title}
              onClick={() => onNavigate?.(item.section)}
            >
              <span className="navIcon">{item.icon}</span>
              <span className="navLabel">{item.label}</span>
              {badge ? <span className="navBadge" aria-label={badgeLabel}>{badge}</span> : null}
            </button>
          );
        })}
      </nav>

      <div className="sidebarBottom">
        {/* Identity + session keep-alive; „Odhlásit“ stays in the top bar (StepHeader). */}
        {user && <UserMenu user={user} roleLabel={APP_ROLE_LABELS_CS[user.role]} compact={collapsed} showLogout={false} />}
        <div className="appVersion">
          HOMEWORK BOOTH
          <span>Generator v0.1</span>
        </div>
      </div>
    </aside>
  );
}
