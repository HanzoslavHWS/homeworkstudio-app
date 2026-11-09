"use client";

import { useEffect, useState } from "react";
import type { CurrentUser } from "../../lib/auth/pageAuth.server";
import type { ExternalProjectView } from "../../domain/externalProjectView";
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
          <h1>Přidělené projekty</h1>
        </div>
        <UserMenu user={user} roleLabel="Externí" />
      </header>
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
    </main>
  );
}
