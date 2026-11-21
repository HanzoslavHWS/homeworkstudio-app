"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { SEE_PROJECT_STATUS_LABELS_CS, type SeeProjectSummary } from "../../domain/seeProject";
import { changeSeeProjectStatus, copyText, formatDateTime, listSeeProjects, seePublicationAction } from "../../lib/see/client";
import { SeeNotice, type SeeNoticeValue } from "./SeeNotice";

const PAGE_SIZE = 20;

export function seeShareUrl(slug: string): string {
  return `${window.location.origin}/see/p/${slug}`;
}

/** Projekty: searchable, filterable, paginated overview with the lifecycle actions. */
export function SeeProjects() {
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState("active-like");
  const [publication, setPublication] = useState("all");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<readonly SeeProjectSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [notice, setNoticeValue] = useState<SeeNoticeValue | undefined>();
  const setNotice = useCallback((text: string | undefined, kind: SeeNoticeValue["kind"] = "ok") => setNoticeValue(text ? { kind, text } : undefined), []);
  const closeNotice = useCallback(() => setNoticeValue(undefined), []);
  const [pinNotice, setPinNotice] = useState<{ projectName: string; pin: string } | undefined>();

  const load = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const params = new URLSearchParams({ page: String(page), limit: String(PAGE_SIZE), publication });
      if (query.trim()) params.set("q", query.trim());
      if (status !== "active-like") params.set("status", status);
      const result = await listSeeProjects(params);
      setItems(result.items);
      setTotal(result.total);
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Projekty se nepodařilo načíst.");
    } finally {
      setLoading(false);
    }
  }, [page, publication, query, status]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => clearTimeout(timer);
  }, [load]);

  /** The action may return a server warning (e.g. incomplete re-keying) — shown instead of a plain ✓. */
  const run = async (label: string, action: () => Promise<unknown>) => {
    setNotice(undefined);
    setError(undefined);
    try {
      const result = await action();
      const warning = (result as { warning?: unknown } | undefined)?.warning;
      if (typeof warning === "string") setNotice(`${label} ${warning}`, "warn");
      else setNotice(label);
      await load();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Akce se nezdařila.");
    }
  };

  const statusAction = (summary: SeeProjectSummary, action: string, label: string, confirmText?: string) => {
    if (confirmText && !window.confirm(confirmText)) return;
    void run(label, () => changeSeeProjectStatus(summary.project.id, action));
  };

  const togglePublication = (summary: SeeProjectSummary) => {
    const published = summary.publication?.status === "published";
    if (published && !window.confirm(`Zrušit publikaci „${summary.project.name}“? Odkaz i embed okamžitě přestanou fungovat.`)) return;
    void run(published ? "Publikace zrušena." : "Projekt publikován.", async () => {
      const result = await seePublicationAction(summary.project.id, { action: published ? "unpublish" : "publish" });
      if (result.pin) setPinNotice({ projectName: summary.project.name, pin: result.pin });
      return result;
    });
  };

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="seeProjects">
      <div className="seePageHead">
        <h1>Projekty</h1>
        <Link href="/see/new" className="seeButton seeButtonPrimary">Nový projekt</Link>
      </div>
      <div className="seeFilters">
        <input type="search" placeholder="Hledat název nebo popis…" value={query} onChange={(event) => { setQuery(event.target.value); setPage(1); }} aria-label="Hledat" />
        <select value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }} aria-label="Stav projektu">
          <option value="active-like">Aktivní, pozastavené i archivované</option>
          <option value="active">Jen aktivní</option>
          <option value="paused">Jen pozastavené</option>
          <option value="archived">Jen archivované</option>
        </select>
        <select value={publication} onChange={(event) => { setPublication(event.target.value); setPage(1); }} aria-label="Publikace">
          <option value="all">Publikované i návrhy</option>
          <option value="published">Jen publikované</option>
          <option value="draft">Jen návrhy</option>
        </select>
      </div>
      <SeeNotice notice={notice ?? (error ? { kind: "error", text: error } : undefined)} onClose={() => { closeNotice(); setError(undefined); }} />
      {pinNotice && (
        <div className="seeBanner seeBannerWarn">
          Nový PIN pro „{pinNotice.projectName}“: <strong className="seePin">{pinNotice.pin}</strong> — zobrazuje se jen teď, uložen je pouze jeho otisk.
          <button type="button" className="seeLinkButton" onClick={() => void copyText(pinNotice.pin)}>Zkopírovat PIN</button>
          <button type="button" className="seeLinkButton" onClick={() => setPinNotice(undefined)}>Zavřít</button>
        </div>
      )}

      <div className="seeTableWrap">
        <table className="seeTable">
          <thead>
            <tr>
              <th>Projekt</th>
              <th>Stav</th>
              <th>Modely / přílohy</th>
              <th>Vytvořil</th>
              <th>Upravil</th>
              <th>Publikováno</th>
              <th>Otevření</th>
              <th>Akce</th>
            </tr>
          </thead>
          <tbody>
            {loading && items.length === 0 && <tr><td colSpan={8} className="seeMuted">Načítám…</td></tr>}
            {!loading && items.length === 0 && <tr><td colSpan={8} className="seeMuted">Žádné projekty. Založte první přes „Nový projekt“.</td></tr>}
            {items.map((summary) => {
              const { project } = summary;
              const published = summary.publication?.status === "published";
              return (
                <tr key={project.id}>
                  <td data-label="Projekt">
                    <Link href={`/see/projects/${project.id}`} className="seeProjectName">{project.name}</Link>
                    {project.description && <div className="seeMuted seeClamp">{project.description}</div>}
                  </td>
                  <td data-label="Stav">
                    <span className={`seeChip seeChip-${published ? (project.status === "active" ? "published" : "blocked") : "draft"}`} title={published && project.status !== "active" ? "Odkaz je zablokovaný, dokud projekt neobnovíte" : undefined}>
                      {published ? (project.status === "active" ? "Publikováno" : "Publikováno – odkaz blokován") : summary.publication ? "Publikace zrušena" : "Návrh"}
                    </span>
                    {published && <span className="seeChip">{summary.publication!.mode === "pin" ? "PIN" : "Veřejné"}</span>}
                    <span className={`seeChip seeChip-${project.status}`}>{SEE_PROJECT_STATUS_LABELS_CS[project.status]}</span>
                  </td>
                  <td data-label="Modely / přílohy">{summary.sceneCount} / {summary.documentCount}</td>
                  <td data-label="Vytvořil">{project.createdBy?.label ?? "—"}<div className="seeMuted">{formatDateTime(project.createdAt)}</div></td>
                  <td data-label="Upravil">{project.updatedBy?.label ?? "—"}<div className="seeMuted">{formatDateTime(project.updatedAt)}</div></td>
                  <td data-label="Publikováno">{formatDateTime(summary.publication?.publishedAt)}</td>
                  <td data-label="Otevření">
                    {summary.publication?.viewCount ?? 0}
                    {summary.publication?.lastViewedAt && <div className="seeMuted">naposledy {formatDateTime(summary.publication.lastViewedAt)}</div>}
                  </td>
                  <td data-label="Akce">
                    <div className="seeRowActions">
                      <Link href={`/see/projects/${project.id}`} className="seeSmallButton">Otevřít editor</Link>
                      {published && project.status === "active" && <a href={`/see/p/${summary.publication!.shareSlug}`} target="_blank" rel="noreferrer" className="seeSmallButton">Náhled</a>}
                      {project.status === "active" && <button type="button" className="seeSmallButton" onClick={() => togglePublication(summary)}>{published ? "Zrušit publikaci" : "Publikovat"}</button>}
                      {published && <button type="button" className="seeSmallButton" onClick={() => void copyText(seeShareUrl(summary.publication!.shareSlug)).then((ok) => (ok ? setNotice("Odkaz zkopírován.") : setNotice("Odkaz se nepodařilo zkopírovat — označte jej ručně v editoru.", "error")))}>Kopírovat odkaz</button>}
                      {project.status === "active" && <button type="button" className="seeSmallButton" onClick={() => statusAction(summary, "pause", "Projekt pozastaven — veřejný odkaz je zablokovaný.")}>Pozastavit</button>}
                      {project.status === "paused" && <button type="button" className="seeSmallButton" onClick={() => statusAction(summary, "resume", "Projekt obnoven. Chráněné prezentace vyžadují znovu PIN.", "Obnovit projekt? Publikovaný odkaz začne znovu fungovat.")}>Obnovit</button>}
                      {(project.status === "active" || project.status === "paused") && <button type="button" className="seeSmallButton" onClick={() => statusAction(summary, "archive", "Projekt archivován.", `Archivovat „${project.name}“? Veřejný odkaz přestane fungovat.`)}>Archivovat</button>}
                      {project.status === "archived" && <button type="button" className="seeSmallButton" onClick={() => statusAction(summary, "restore", "Projekt obnoven z archivu.", "Obnovit projekt z archivu? Publikovaný odkaz začne znovu fungovat.")}>Obnovit z archivu</button>}
                      <button type="button" className="seeSmallButton seeDanger" onClick={() => statusAction(summary, "delete", "Projekt smazán.", `Opravdu smazat „${project.name}“? Projekt zmizí z přehledu a jeho odkaz přestane platit.`)}>Smazat</button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div className="seePager">
        <button type="button" className="seeSmallButton" disabled={page <= 1} onClick={() => setPage((value) => value - 1)}>Předchozí</button>
        <span className="seeMuted">Strana {page} z {pages} · {total} projektů</span>
        <button type="button" className="seeSmallButton" disabled={page >= pages} onClick={() => setPage((value) => value + 1)}>Další</button>
      </div>
    </div>
  );
}
