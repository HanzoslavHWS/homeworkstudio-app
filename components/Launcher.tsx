import Link from "next/link";
import { launcherApps, type LauncherApp } from "../data/launcherApps";

function LauncherCardContent({ app }: { app: LauncherApp }) {
  return (
    <>
      <div className="launcherCardLogo">
        <img src={app.logo} alt={app.title} />
      </div>
      <div className="launcherCardBody">
        <strong className="launcherCardTitle">
          {app.title}
          {app.version ? ` ${app.version}` : ""}
        </strong>
        {app.status === "coming-soon" ? (
          <span className="launcherBadge">Připravujeme</span>
        ) : (
          <span className="launcherCardCta">{app.cta ?? "Vstoupit"}</span>
        )}
      </div>
    </>
  );
}

export function Launcher() {
  return (
    <main className="launcherPage">
      <header className="launcherHeader">
        <h1>HOMEWORKSTUDIO</h1>
        <p>Vyberte aplikaci</p>
      </header>
      <div className="launcherGrid">
        {launcherApps.map((app) =>
          app.enabled && app.status === "ready" ? (
            <Link key={app.id} href={app.route} className="launcherCard launcherCardActive">
              <LauncherCardContent app={app} />
            </Link>
          ) : (
            <div key={app.id} className="launcherCard launcherCardDisabled" aria-disabled="true">
              <LauncherCardContent app={app} />
            </div>
          ),
        )}
      </div>
    </main>
  );
}
