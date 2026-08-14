type AppSidebarProps = {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onStartNewProject: () => void;
  activeSection?: "project" | "projects" | "booths" | "components" | "events" | "priceLists" | "pricingAdmin";
  onNavigate?: (section: "projects" | "booths" | "components" | "events" | "priceLists" | "pricingAdmin") => void;
};

export function AppSidebar({
  collapsed,
  onToggleCollapsed,
  onStartNewProject,
  activeSection = "project",
  onNavigate,
}: AppSidebarProps) {
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
        <button type="button" className={activeSection === "project" ? "navItem active" : "navItem"} onClick={onStartNewProject} title="Nový projekt">
          <span className="navIcon">＋</span>
          <span className="navLabel">Nový projekt</span>
        </button>
        <button type="button" className={activeSection === "projects" ? "navItem active" : "navItem"} title="Projekty" onClick={() => onNavigate?.("projects")}>
          <span className="navIcon">▽</span>
          <span className="navLabel">Projekty</span>
        </button>
        <button type="button" className={activeSection === "booths" ? "navItem active" : "navItem"} title="Knihovna stánků" onClick={() => onNavigate?.("booths")}>
          <span className="navIcon">◇</span>
          <span className="navLabel">Knihovna stánků</span>
        </button>
        <button type="button" className={activeSection === "components" ? "navItem active" : "navItem"} title="Komponenty" onClick={() => onNavigate?.("components")}>
          <span className="navIcon">▦</span>
          <span className="navLabel">Komponenty</span>
        </button>
        <button type="button" className={activeSection === "events" ? "navItem active" : "navItem"} title="Výstavy / eventy" onClick={() => onNavigate?.("events")}>
          <span className="navIcon">◎</span>
          <span className="navLabel">Výstavy / eventy</span>
        </button>
        <button type="button" className={activeSection === "priceLists" ? "navItem active" : "navItem"} title="Ceníky" onClick={() => onNavigate?.("priceLists")}>
          <span className="navIcon">₠</span>
          <span className="navLabel">Ceníky</span>
        </button>
        <button type="button" className={activeSection === "pricingAdmin" ? "navItem active" : "navItem"} title="Správa cen" onClick={() => onNavigate?.("pricingAdmin")}>
          <span className="navIcon">⚙</span>
          <span className="navLabel">Správa cen</span>
        </button>
      </nav>

      <div className="sidebarBottom">
        <div className="appVersion">
          HOMEWORK BOOTH
          <span>Generator v0.1</span>
        </div>
      </div>
    </aside>
  );
}
