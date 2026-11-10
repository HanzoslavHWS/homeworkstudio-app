"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { APP_ROLE_LABELS_CS, type AppRole } from "../../domain/accessControl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader, StatusBadge } from "@/components/ui/workspace";

/**
 * ABF → Administrace → Uživatelé a přiřazení (V1-AUTH-01, V1-AUTH-02): účty s přístupem do ABF, jejich
 * role a stav (jen ke čtení) a přiřazení zakázek. Zakládání účtů, pozvánky, role a přístupy do aplikací
 * jsou ve společné Správě uživatelů HomeworkStudio — tady se nenabízejí. Vše jde přes
 * /api/admin/users/* (jen Správce ABF — server to ověřuje u každého volání).
 */
type AdminUser = { id: string; email: string; displayName: string | null; role: AppRole; isActive: boolean; updatedAt: string; deactivatedAt: string | null; projectIds: string[] };
type AssignableProject = { id: string; name: string; eventId: string | null; boothNumber: string; updatedAt: string };

const ROLE_HINTS: Readonly<Record<AppRole, string>> = {
  admin: "Vše v ABF včetně přiřazení zakázek a globální administrace (katalog, ceníky, veletrhy, firmy).",
  user: "Provozní moduly a přidělené (nebo vlastní) zakázky; čte katalog, ceny, veletrhy a firmy.",
  external: "Jen prohlížení výslovně přidělených zakázek a jejich výstupů.",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Požadavek selhal (HTTP ${response.status}).`);
  return body;
}

const formatDate = (value: string | null | undefined) => (value ? new Date(value).toLocaleString("cs-CZ", { dateStyle: "short", timeStyle: "short" }) : "—");

export function UsersAdminPage({ currentUserId }: Readonly<{ currentUserId?: string }>) {
  const [users, setUsers] = useState<readonly AdminUser[]>([]);
  const [projects, setProjects] = useState<readonly AssignableProject[]>([]);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [query, setQuery] = useState("");
  const [assigned, setAssigned] = useState<readonly string[]>([]);
  const [projectQuery, setProjectQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const selected = selectedId ? users.find((user) => user.id === selectedId) : undefined;

  const reload = useCallback(async (keepId?: string) => {
    setLoading(true);
    try {
      const body = await api<{ users: AdminUser[]; projects: AssignableProject[] }>("/api/admin/users");
      setUsers(body.users);
      setProjects(body.projects);
      setLoadError("");
      const kept = keepId ? body.users.find((item) => item.id === keepId) : undefined;
      if (kept) setAssigned(kept.projectIds);
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Seznam uživatelů se nepodařilo načíst.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  function select(user: AdminUser) {
    setSelectedId(user.id);
    setAssigned(user.projectIds);
    setError("");
    setNotice("");
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return users.filter((user) => !needle || user.email.includes(needle) || (user.displayName ?? "").toLowerCase().includes(needle));
  }, [users, query]);

  const activeAdmins = users.filter((user) => user.role === "admin" && user.isActive).length;
  const assignmentDirty = Boolean(selected && [...assigned].sort().join("|") !== [...selected.projectIds].sort().join("|"));
  // A deactivated account keeps its assignments (history), but gets no new ones.
  const canAdd = Boolean(selected?.isActive);

  async function saveProjects() {
    if (!selected) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await api<{ projectIds: string[] }>("/api/admin/users/projects", { method: "POST", body: JSON.stringify({ userId: selected.id, projectIds: assigned }) });
      setNotice(`Přiřazení uloženo: ${body.projectIds.length} ${body.projectIds.length === 1 ? "zakázka" : "zakázek"}. Odebrané zakázky jsou nepřístupné okamžitě.`);
      await reload(selected.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Přiřazení se nepodařilo uložit.");
    } finally {
      setBusy(false);
    }
  }

  const visibleProjects = projects.filter((project) => {
    const needle = projectQuery.trim().toLowerCase();
    return !needle || project.name.toLowerCase().includes(needle) || project.boothNumber.toLowerCase().includes(needle) || (project.eventId ?? "").toLowerCase().includes(needle);
  });

  return (
    <div className="adminPage">
      <PageHeader title="Uživatelé a přiřazení" description="Účty s přístupem do ABF Generatoru" />
      <p className="mb-4 max-w-5xl text-sm text-muted-foreground">
        Účty, pozvánky, role a přístupy do aplikací spravuje správce HomeworkStudia ve{" "}
        <a className="font-semibold text-foreground underline underline-offset-4" href="/sprava-uzivatelu">Správě uživatelů</a>. Zde se přiřazují zakázky.
        Účet se v seznamu objeví, jakmile mu správce povolí ABF; po odebrání přístupu zmizí, jeho zakázky, autorství a historie zůstávají.
      </p>
      {loadError && <p className="mb-3 text-sm font-medium text-destructive" role="alert">{loadError}</p>}
      <div className="adminFilters">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat podle e-mailu nebo jména…" aria-label="Hledat uživatele" />
        <span className="fieldHint">{loading ? "Načítám…" : `${users.length} účtů s přístupem do ABF · aktivní správci ABF: ${activeAdmins}`}</span>
      </div>
      <div className="adminSplit">
        <div className="adminList">
          {!loading && filtered.length === 0 && <p className="workspaceEmpty">Žádní uživatelé.</p>}
          {filtered.map((user) => (
            <button key={user.id} className={user.id === selectedId ? "active" : ""} onClick={() => select(user)}>
              <strong>{user.displayName || user.email}{user.isActive ? "" : " (deaktivovaný)"}{user.id === currentUserId ? " (vy)" : ""}</strong>
              <span>{APP_ROLE_LABELS_CS[user.role]} · {user.email}</span>
            </button>
          ))}
        </div>

        {selected && (
          <section className="adminDetail">
            <div className="eventForm min-w-0 grid-cols-[minmax(0,1fr)]">
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="text-lg font-semibold">{selected.displayName || selected.email}</h2>
                <StatusBadge tone={selected.role === "admin" ? "info" : "neutral"}>{APP_ROLE_LABELS_CS[selected.role]}</StatusBadge>
                <StatusBadge tone={selected.isActive ? "success" : "muted"} symbol={selected.isActive ? "●" : "○"}>{selected.isActive ? "Aktivní" : "Deaktivovaný"}</StatusBadge>
              </div>
              <p className="text-sm text-muted-foreground">{selected.email}{selected.deactivatedAt ? ` · deaktivováno ${formatDate(selected.deactivatedAt)}` : ""}</p>
              <p className="fieldHint">{ROLE_HINTS[selected.role]} Roli a stav účtu mění správce HomeworkStudia.</p>

              <section className="deadlineEditor">
                <div>
                  <strong>Přiřazené zakázky ({assigned.length})</strong>
                  <Button variant="outline" size="sm" type="button" onClick={() => void saveProjects()} disabled={busy || !assignmentDirty}>{busy ? "Ukládám…" : "Uložit přiřazení"}</Button>
                </div>
                {error && <p className="text-sm font-medium text-destructive" role="alert">{error}</p>}
                {notice && <p className="fieldHint" role="status">{notice}</p>}
                {selected.role === "admin" ? (
                  <p className="fieldHint">Správce ABF vidí všechny zakázky — přiřazení se u něj neuplatňuje.</p>
                ) : (
                  <>
                    <p className="fieldHint">
                      {!canAdd ? "Účet je deaktivovaný — nové zakázky mu nelze přiřadit, stávající lze odebrat." : selected.role === "external" ? "Externí účet uvidí jen tyto zakázky a jejich výstupy (exporty, vizualizace, půdorysy) — jen pro čtení." : "Běžný účet pracuje jen s těmito zakázkami (a se zakázkami, které sám založí)."}
                    </p>
                    <Input value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder="Filtrovat zakázky…" aria-label="Filtrovat zakázky" />
                    {projects.length === 0 && <p className="fieldHint">V databázi zatím nejsou žádné zakázky.</p>}
                    <div className="userProjectList">
                      {visibleProjects.map((project) => {
                        const checked = assigned.includes(project.id);
                        return (
                          <label key={project.id} className="checkLabel">
                            <input type="checkbox" checked={checked} disabled={!checked && !canAdd} onChange={(event) => setAssigned(event.target.checked ? [...assigned, project.id] : assigned.filter((id) => id !== project.id))} />
                            {project.name}{project.boothNumber ? ` · stánek ${project.boothNumber}` : ""}{project.eventId ? ` · ${project.eventId}` : ""}
                          </label>
                        );
                      })}
                    </div>
                  </>
                )}
              </section>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}
