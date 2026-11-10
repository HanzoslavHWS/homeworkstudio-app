import Link from "next/link";
import { launcherPresentation } from "../data/launcherApps";
import { launcherEntries, type LauncherEntry } from "../domain/hwsApps";
import type { CurrentUser } from "../lib/auth/pageAuth.server";
import { UserMenu } from "./auth/UserMenu";

function LauncherCardContent({ entry }: { entry: LauncherEntry }) {
  const presentation = launcherPresentation[entry.app.key];
  return (
    <>
      <div className="launcherCardLogo">
        <img src={presentation.logo} alt={entry.app.name} />
      </div>
      <div className="launcherCardBody">
        <strong className="launcherCardTitle">
          {entry.app.name}
          {presentation.version ? ` ${presentation.version}` : ""}
        </strong>
        {entry.opens ? (
          <span className="launcherCardCta">{presentation.cta ?? "Vstoupit"}</span>
        ) : (
          <span className="launcherBadge">Připravujeme</span>
        )}
      </div>
    </>
  );
}

/**
 * Rozcestník HomeworkStudio (V1-AUTH-02): only the applications this account has a membership in.
 * A permitted application that is still being prepared shows "Připravujeme" and opens nothing. The
 * shared administration is offered to its administrators only — the page itself checks again.
 */
export function Launcher({ user }: Readonly<{ user: CurrentUser }>) {
  const entries = launcherEntries({ isActive: true, isHwsAdmin: user.isHwsAdmin, apps: user.apps });
  return (
    <main className="launcherPage">
      <div className="launcherTopBar">
        {user.isHwsAdmin && (
          <Link href="/sprava-uzivatelu" className="launcherAdminLink">Správa uživatelů</Link>
        )}
        <UserMenu user={user} roleLabel={user.isHwsAdmin ? "Správce HomeworkStudia" : "Účet HomeworkStudio"} variant="dark" />
      </div>
      <header className="launcherHeader">
        <h1>HOMEWORKSTUDIO</h1>
        <p>{entries.length ? "Vyberte aplikaci" : "Zatím nemáte přístup do žádné aplikace"}</p>
      </header>
      {entries.length === 0 ? (
        <p className="launcherEmpty" role="status">
          Váš účet je aktivní, ale správce HomeworkStudia vám zatím nepovolil žádnou aplikaci. Obraťte se na něj{user.isHwsAdmin ? " — nebo si přístup nastavte ve Správě uživatelů" : ""}. Odhlásit se můžete vpravo nahoře.
        </p>
      ) : (
        <div className="launcherGrid">
          {entries.map((entry) =>
            entry.opens ? (
              <Link key={entry.app.key} href={entry.app.url!} className="launcherCard launcherCardActive">
                <LauncherCardContent entry={entry} />
              </Link>
            ) : (
              <div key={entry.app.key} className="launcherCard launcherCardDisabled" aria-disabled="true">
                <LauncherCardContent entry={entry} />
              </div>
            ),
          )}
        </div>
      )}
    </main>
  );
}
