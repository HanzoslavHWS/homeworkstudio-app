type AppSidebarProps = {
  onStartNewProject: () => void;
};

export function AppSidebar({ onStartNewProject }: AppSidebarProps) {
  return (
    <aside className="sidebar">
      <a href="https://homeworkstudio.cz" className="logo">
        <span className="logoMain">HOMEWORK</span>
        <span className="logoSub">STUDIO</span>
      </a>

      <nav className="nav">
        <button type="button" className="navItem active" onClick={onStartNewProject}>
          <span className="navIcon">＋</span>
          Nový projekt
        </button>
        <button type="button" className="navItem">
          <span className="navIcon">▽</span>
          Projekty
        </button>
        <button type="button" className="navItem">
          <span className="navIcon">◇</span>
          Knihovna stánků
        </button>
        <button type="button" className="navItem">
          <span className="navIcon">▦</span>
          Komponenty
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
