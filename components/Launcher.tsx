import Link from "next/link";
import { launcherApps, type LauncherApp } from "../data/launcherApps";
import { APP_ROLE_LABELS_CS } from "../domain/accessControl";
import type { CurrentUser } from "../lib/auth/pageAuth.server";
import { UserMenu } from "./auth/UserMenu";

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

export function Launcher({ user }: Readonly<{ user?: CurrentUser }>) {
  return (
    <main className="launcherPage">
      {user && <UserMenu user={user} roleLabel={APP_ROLE_LABELS_CS[user.role]} variant="dark" />}
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
