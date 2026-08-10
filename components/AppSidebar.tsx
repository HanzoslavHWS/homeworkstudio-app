type AppSidebarProps = {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onStartNewProject: () => void;
};

export function AppSidebar({
  collapsed,
  onToggleCollapsed,
  onStartNewProject,
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
        <button type="button" className="navItem active" onClick={onStartNewProject} title="Nový projekt">
          <span className="navIcon">＋</span>
          <span className="navLabel">Nový projekt</span>
        </button>
        <button type="button" className="navItem" title="Projekty">
          <span className="navIcon">▽</span>
          <span className="navLabel">Projekty</span>
        </button>
        <button type="button" className="navItem" title="Knihovna stánků">
          <span className="navIcon">◇</span>
          <span className="navLabel">Knihovna stánků</span>
        </button>
        <button type="button" className="navItem" title="Komponenty">
          <span className="navIcon">▦</span>
          <span className="navLabel">Komponenty</span>
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
