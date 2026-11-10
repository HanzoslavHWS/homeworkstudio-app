"use client";

import { useEffect, useState } from "react";
import type { CurrentUser } from "../../lib/auth/pageAuth.server";
import type { ExternalProjectView } from "../../domain/externalProjectView";
import { normalizeSupportRoute, parseWorkspaceHash, workspaceHash } from "../../domain/adminNavigation";
import { ReportDialog } from "../support/ReportDialog";
import { SupportCenter } from "../support/SupportCenter";
import { useSupportSummary } from "../support/useSupportSummary";
import { UserMenu } from "./UserMenu";

const FOLDER_LABELS: Readonly<Record<string, string>> = { exports: "Export", visualizations: "Vizualizace", floorplans: "Půdorys" };

/**
 * Úvodní stránka EXTERNÍHO účtu (V1-AUTH-01): jen výslovně přidělené projekty a jejich povolené
 * výstupy ke stažení. Data i odkazy ke stažení vydává server až po kontrole přiřazení
 * (/api/projects/list, /api/assets/download) — tato stránka nic neskrývá, jen zobrazuje.
 */
export function ExternalProjectsPage({ user }: Readonly<{ user: CurrentUser }>) {
  const [projects, setProjects] = useState<readonly ExternalProjectView[] | undefined>();
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState("");
  // Nápověda a podpora (V1-SUPPORT-01): only articles marked for externals and the user's own reports — the API decides
  const [supportRoute, setSupportRoute] = useState<string | null>(null);
  const [reportOpen, setReportOpen] = useState(false);
  const [supportReloadKey, setSupportReloadKey] = useState(0);
  const { summary, refresh } = useSupportSummary("abf", true);

  useEffect(() => {
    const apply = () => {
      const location = parseWorkspaceHash(window.location.hash);
      setSupportRoute(location.section === "support" ? location.support : null);
    };
    apply();
    window.addEventListener("popstate", apply);
    return () => window.removeEventListener("popstate", apply);
  }, []);

  function showSupport(route: string | null) {
    const next = route === null ? null : normalizeSupportRoute(route);
    setSupportRoute(next);
    const hash = next === null ? "" : workspaceHash({ section: "support", support: next });
    if (hash !== window.location.hash) window.history.pushState(null, "", `${window.location.pathname}${window.location.search}${hash}`);
  }

  useEffect(() => {
    void (async () => {
      try {
        const response = await fetch("/api/projects/list", { credentials: "same-origin", headers: { Accept: "application/json" } });
        const body = (await response.json().catch(() => ({}))) as { projects?: ExternalProjectView[]; error?: string };
        if (!response.ok) throw new Error(body.error ?? "Projekty se nepodařilo načíst.");
        setProjects(body.projects ?? []);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Projekty se nepodařilo načíst.");
      }
    })();
  }, []);

  async function download(storageKey: string, fileName: string) {
    setDownloading(storageKey);
    setError("");
    try {
      const response = await fetch("/api/assets/download", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storageKey, fileName }) });
      const body = (await response.json().catch(() => ({}))) as { downloadUrl?: string; error?: string };
      if (!response.ok || !body.downloadUrl) throw new Error(body.error ?? "Soubor se nepodařilo stáhnout.");
      window.open(body.downloadUrl, "_blank", "noopener");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Soubor se nepodařilo stáhnout.");
    } finally {
      setDownloading("");
    }
  }

  return (
    <main className="externalPage">
      <header className="externalHeader">
        <div>
          <span className="eyebrow">HOMEWORK STUDIO</span>
          <h1>{supportRoute === null ? "Přidělené projekty" : "Nápověda a podpora"}</h1>
        </div>
        <div className="externalHeaderActions">
          <button type="button" className="secondaryButton" onClick={() => showSupport(supportRoute === null ? "navody" : null)}>
            {supportRoute === null ? "Nápověda a podpora" : "Přidělené projekty"}
            {supportRoute === null && summary?.waitingForMe ? <span className="navBadge" aria-label={`${summary.waitingForMe} hlášení čeká na vaše doplnění`}>{summary.waitingForMe}</span> : null}
          </button>
          <button type="button" className="secondaryButton" onClick={() => setReportOpen(true)}>Nahlásit chybu</button>
          <UserMenu user={user} roleLabel="Externí" />
        </div>
      </header>
      <ReportDialog open={reportOpen} onOpenChange={setReportOpen} appKey="abf" area={supportRoute === null ? "abf.projects" : "abf.support"} author={user.displayName || user.email} onCreated={() => { setSupportReloadKey((key) => key + 1); refresh(); }} />
      {supportRoute !== null ? (
        <SupportCenter appKey="abf" role="external" route={supportRoute} onNavigate={showSupport} onReport={() => setReportOpen(true)} reloadKey={supportReloadKey} counts={{ newTickets: 0, waitingForMe: summary?.waitingForMe ?? 0 }} onChanged={refresh} />
      ) : (<>
      {error && <p className="uploadError" role="alert">{error}</p>}
      {projects === undefined && !error && <p className="fieldHint">Načítám…</p>}
      {projects?.length === 0 && <p className="fieldHint">Zatím vám nebyl přidělen žádný projekt. Obraťte se na správce.</p>}
      <div className="externalList">
        {projects?.map((project) => (
          <section key={project.id} className="externalCard">
            <h2>{project.name || "Projekt bez názvu"}</h2>
            <p className="fieldHint">{[project.boothNumber && `Stánek ${project.boothNumber}`, project.modifiedAt && `upraveno ${new Date(project.modifiedAt).toLocaleDateString("cs-CZ")}`].filter(Boolean).join(" · ")}</p>
            {project.outputs.length === 0 ? (
              <p className="fieldHint">Zatím bez výstupů ke stažení.</p>
            ) : (
              <ul>
                {project.outputs.map((output) => (
                  <li key={output.storageKey}>
                    <span>{FOLDER_LABELS[output.folder] ?? output.folder}: {output.fileName}</span>
                    <button type="button" className="secondaryButton" disabled={downloading === output.storageKey} onClick={() => void download(output.storageKey, output.fileName)}>
                      {downloading === output.storageKey ? "Připravuji…" : "Stáhnout"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
      </>)}
    </main>
  );
}
