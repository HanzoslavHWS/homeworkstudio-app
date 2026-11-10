"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { APP_ROLE_LABELS_CS, APP_ROLES, type AppRole } from "../../domain/accessControl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { PageHeader } from "@/components/ui/workspace";

/**
 * Administrace → Uživatelé (V1-AUTH-01): účty, role, stav, pozvánky a přiřazení projektů.
 * Vše jde přes /api/admin/users/* (jen Správce — server to ověřuje u každého volání). Výsledek se
 * hlásí až podle odpovědi serveru; nic se neodesílá e-mailem — odkaz pozvánky / nového hesla se
 * zobrazí správci k předání.
 */
type AuthInfo = { invitedAt: string | null; confirmedAt: string | null; lastSignInAt: string | null } | undefined;
type AdminUser = { id: string; email: string; displayName: string | null; role: AppRole; isActive: boolean; updatedAt: string; deactivatedAt: string | null; projectIds: string[]; auth?: AuthInfo };
type AssignableProject = { id: string; name: string; eventId: string | null; boothNumber: string; updatedAt: string };
type Draft = { displayName: string; role: AppRole; isActive: boolean };

const ROLE_HINTS: Readonly<Record<AppRole, string>> = {
  admin: "Vše včetně uživatelů, rolí, přiřazení projektů a globální administrace (katalog, ceníky, veletrhy, firmy).",
  user: "Provozní moduly a přidělené (nebo vlastní) projekty; čte katalog, ceny, veletrhy a firmy. Bez správy uživatelů a globální administrace.",
  external: "Jen prohlížení výslovně přidělených projektů a jejich výstupů. Bez úprav, katalogu, nákupních cen a dalších dat.",
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Požadavek selhal (HTTP ${response.status}).`);
  return body;
}

const formatDate = (value: string | null | undefined) => (value ? new Date(value).toLocaleString("cs-CZ", { dateStyle: "short", timeStyle: "short" }) : "—");

function inviteState(user: AdminUser): string {
  if (!user.auth) return "stav účtu Supabase Auth nezjištěn";
  if (user.auth.lastSignInAt) return `poslední přihlášení ${formatDate(user.auth.lastSignInAt)}`;
  if (user.auth.invitedAt) return `pozvánka z ${formatDate(user.auth.invitedAt)} čeká na přijetí`;
  return "zatím se nepřihlásil";
}

export function UsersAdminPage({ currentUserId }: Readonly<{ currentUserId?: string }>) {
  const [users, setUsers] = useState<readonly AdminUser[]>([]);
  const [projects, setProjects] = useState<readonly AssignableProject[]>([]);
  const [loadError, setLoadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<string | "new" | undefined>();
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<Draft | undefined>();
  const [assigned, setAssigned] = useState<readonly string[]>([]);
  const [projectQuery, setProjectQuery] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [link, setLink] = useState<{ url: string; note: string } | undefined>();
  const [newUser, setNewUser] = useState<{ email: string; displayName: string; role: AppRole }>({ email: "", displayName: "", role: "user" });

  const selected = typeof selectedId === "string" && selectedId !== "new" ? users.find((user) => user.id === selectedId) : undefined;

  const reload = useCallback(async (keepId?: string) => {
    setLoading(true);
    try {
      const body = await api<{ users: AdminUser[]; projects: AssignableProject[] }>("/api/admin/users");
      setUsers(body.users);
      setProjects(body.projects);
      setLoadError("");
      if (keepId) {
        const user = body.users.find((item) => item.id === keepId);
        if (user) {
          setDraft({ displayName: user.displayName ?? "", role: user.role, isActive: user.isActive });
          setAssigned(user.projectIds);
        }
      }
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
    setDraft({ displayName: user.displayName ?? "", role: user.role, isActive: user.isActive });
    setAssigned(user.projectIds);
    setError("");
    setNotice("");
    setLink(undefined);
  }

  function startNew() {
    setSelectedId("new");
    setNewUser({ email: "", displayName: "", role: "user" });
    setError("");
    setNotice("");
    setLink(undefined);
  }

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return users.filter((user) => !needle || user.email.includes(needle) || (user.displayName ?? "").toLowerCase().includes(needle));
  }, [users, query]);

  const activeAdmins = users.filter((user) => user.role === "admin" && user.isActive).length;
  const isSelf = selected?.id === currentUserId;
  const dirty = Boolean(selected && draft && (draft.displayName !== (selected.displayName ?? "") || draft.role !== selected.role || draft.isActive !== selected.isActive));
  const assignmentDirty = Boolean(selected && [...assigned].sort().join("|") !== [...selected.projectIds].sort().join("|"));

  async function run(label: string, action: () => Promise<void>) {
    setBusy(label);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Akce se nezdařila.");
    } finally {
      setBusy("");
    }
  }

  const create = () => run("create", async () => {
    const body = await api<{ user: AdminUser; link: string; linkNote: string }>("/api/admin/users", { method: "POST", body: JSON.stringify(newUser) });
    setLink({ url: body.link, note: body.linkNote });
    setNotice(`Účet ${body.user.email} byl založen (${APP_ROLE_LABELS_CS[body.user.role]}). E-mail se neodeslal — předejte odkaz níže.`);
    await reload(body.user.id);
    setSelectedId(body.user.id);
  });

  const save = () => run("save", async () => {
    if (!selected || !draft) return;
    const body = await api<{ user: AdminUser }>("/api/admin/users/update", { method: "POST", body: JSON.stringify({ userId: selected.id, expectedUpdatedAt: selected.updatedAt, displayName: draft.displayName, role: draft.role, isActive: draft.isActive }) });
    setNotice(`Uloženo: ${APP_ROLE_LABELS_CS[body.user.role]}, ${body.user.isActive ? "aktivní" : "deaktivovaný (všechna přihlášení ukončena)"}.`);
    await reload(selected.id);
  });

  const saveProjects = () => run("projects", async () => {
    if (!selected) return;
    const body = await api<{ projectIds: string[] }>("/api/admin/users/projects", { method: "POST", body: JSON.stringify({ userId: selected.id, projectIds: assigned }) });
    setNotice(`Přiřazení uloženo: ${body.projectIds.length} ${body.projectIds.length === 1 ? "projekt" : "projektů"}. Odebrané projekty jsou nepřístupné okamžitě.`);
    await reload(selected.id);
  });

  const newLink = () => run("link", async () => {
    if (!selected) return;
    const body = await api<{ link: string; kind: string; linkNote: string }>("/api/admin/users/link", { method: "POST", body: JSON.stringify({ userId: selected.id }) });
    setLink({ url: body.link, note: body.linkNote });
    setNotice(body.kind === "invite" ? "Nový odkaz pozvánky je připraven (e-mail se neodeslal)." : "Odkaz pro nastavení nového hesla je připraven (e-mail se neodeslal).");
  });

  const visibleProjects = projects.filter((project) => {
    const needle = projectQuery.trim().toLowerCase();
    return !needle || project.name.toLowerCase().includes(needle) || project.boothNumber.toLowerCase().includes(needle) || (project.eventId ?? "").toLowerCase().includes(needle);
  });

  return (
    <div className="adminPage">
      <PageHeader title="Uživatelé" actions={<Button variant="default" onClick={startNew}>+ Nový uživatel</Button>} />
      <p className="mb-4 max-w-5xl text-sm text-muted-foreground">Účty zakládá jen správce; veřejná registrace není. Role a stav účtu platí okamžitě i pro už přihlášené uživatele. Poslední aktivní správce nejde deaktivovat ani převést na jinou roli. Pozvánky a nová hesla se předávají odkazem — aplikace sama nic neposílá.</p>
      {loadError && <p className="mb-3 text-sm font-medium text-destructive" role="alert">{loadError}</p>}
      <div className="adminFilters">
        <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat podle e-mailu nebo jména…" />
        <span className="fieldHint">{loading ? "Načítám…" : `${users.length} účtů · aktivní správci: ${activeAdmins}`}</span>
      </div>
      <div className="adminSplit">
        <div className="adminList">
          {!loading && filtered.length === 0 && <p className="workspaceEmpty">Žádní uživatelé.</p>}
          {filtered.map((user) => (
            <button key={user.id} className={user.id === selectedId ? "active" : ""} onClick={() => select(user)}>
              <strong>{user.displayName || user.email}{user.isActive ? "" : " (deaktivovaný)"}</strong>
              <span>{APP_ROLE_LABELS_CS[user.role]} · {user.email}</span>
            </button>
          ))}
        </div>

        {selectedId === "new" && (
          <section className="adminDetail">
            <h2>Nový uživatel</h2>
            <div className="eventForm">
              <label><span>E-mail *</span><Input type="email" value={newUser.email} onChange={(event) => setNewUser({ ...newUser, email: event.target.value })} autoComplete="off" /></label>
              <label><span>Jméno</span><Input value={newUser.displayName} onChange={(event) => setNewUser({ ...newUser, displayName: event.target.value })} /></label>
              <label><span>Role *</span>
                <NativeSelect value={newUser.role} onChange={(event) => setNewUser({ ...newUser, role: event.target.value as AppRole })}>
                  {APP_ROLES.map((role) => <option key={role} value={role}>{APP_ROLE_LABELS_CS[role]}</option>)}
                </NativeSelect>
              </label>
              <p className="fieldHint">{ROLE_HINTS[newUser.role]}</p>
              {error && <p className="mb-3 text-sm font-medium text-destructive" role="alert">{error}</p>}
              {notice && <p className="fieldHint" role="status">{notice}</p>}
              <div><Button variant="default" type="button" onClick={create} disabled={busy !== "" || !newUser.email.trim()}>{busy === "create" ? "Zakládám…" : "Založit účet a vytvořit pozvánku"}</Button></div>
            </div>
          </section>
        )}

        {selected && draft && (
          <section className="adminDetail">
            <div className="eventSaveBar">
              <span className={dirty ? "dirty" : "saved"}>
                {busy === "save" ? "Ukládám…" : dirty ? "Neuložené změny" : "Uloženo"}
                {error && <small className="uploadError">{error}</small>}
                {notice && <small>{notice}</small>}
              </span>
              <Button variant="default" type="button" onClick={save} disabled={busy !== "" || !dirty}>Uložit změny</Button>
            </div>
            <div className="eventForm">
              <div className="twoColumns grid-cols-1 sm:grid-cols-2">
                <label><span>E-mail</span><Input value={selected.email} readOnly disabled /></label>
                <label><span>Stav pozvánky / přihlášení</span><Input value={inviteState(selected)} readOnly disabled /></label>
              </div>
              <label><span>Jméno</span><Input value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} /></label>
              <label><span>Role</span>
                <NativeSelect value={draft.role} disabled={isSelf} onChange={(event) => setDraft({ ...draft, role: event.target.value as AppRole })}>
                  {APP_ROLES.map((role) => <option key={role} value={role}>{APP_ROLE_LABELS_CS[role]}</option>)}
                </NativeSelect>
              </label>
              <p className="fieldHint">{isSelf ? "Vlastní roli a stav účtu může změnit jen jiný správce." : ROLE_HINTS[draft.role]}</p>
              <label className="checkLabel"><input type="checkbox" checked={draft.isActive} disabled={isSelf} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} /> Aktivní účet (deaktivace okamžitě ukončí všechna přihlášení)</label>
              {selected.deactivatedAt && <p className="fieldHint">Deaktivováno {formatDate(selected.deactivatedAt)}.</p>}

              <section className="deadlineEditor">
                <div><strong>Odkaz pozvánky / nového hesla</strong><Button variant="outline" size="sm" type="button" onClick={newLink} disabled={busy !== "" || !selected.isActive}>{busy === "link" ? "Připravuji…" : "Vytvořit odkaz"}</Button></div>
                {link ? (
                  <div className="userLinkBox">
                    <Input value={link.url} readOnly onFocus={(event) => event.currentTarget.select()} aria-label="Jednorázový odkaz" />
                    <Button variant="outline" size="sm" type="button" onClick={() => void navigator.clipboard?.writeText(link.url).then(() => setNotice("Odkaz zkopírován do schránky."), () => setError("Odkaz se nepodařilo zkopírovat — označte ho a zkopírujte ručně."))}>Kopírovat</Button>
                    <p className="fieldHint">{link.note}</p>
                  </div>
                ) : (
                  <p className="fieldHint">Jednorázový odkaz, kterým si uživatel nastaví heslo. Nic se neodesílá e-mailem.</p>
                )}
              </section>

              <section className="deadlineEditor">
                <div>
                  <strong>Přiřazené projekty ({assigned.length})</strong>
                  <Button variant="outline" size="sm" type="button" onClick={saveProjects} disabled={busy !== "" || !assignmentDirty}>{busy === "projects" ? "Ukládám…" : "Uložit přiřazení"}</Button>
                </div>
                {selected.role === "admin" ? (
                  <p className="fieldHint">Správce vidí všechny projekty — přiřazení se u něj neuplatňuje.</p>
                ) : (
                  <>
                    <p className="fieldHint">{selected.role === "external" ? "Externí účet uvidí jen tyto projekty a jejich výstupy (exporty, vizualizace, půdorysy) — jen pro čtení." : "Běžný účet pracuje jen s těmito projekty (a s projekty, které sám založí)."}</p>
                    <Input value={projectQuery} onChange={(event) => setProjectQuery(event.target.value)} placeholder="Filtrovat projekty…" />
                    {projects.length === 0 && <p className="fieldHint">V databázi zatím nejsou žádné projekty.</p>}
                    <div className="userProjectList">
                      {visibleProjects.map((project) => (
                        <label key={project.id} className="checkLabel">
                          <input type="checkbox" checked={assigned.includes(project.id)} onChange={(event) => setAssigned(event.target.checked ? [...assigned, project.id] : assigned.filter((id) => id !== project.id))} />
                          {project.name}{project.boothNumber ? ` · stánek ${project.boothNumber}` : ""}{project.eventId ? ` · ${project.eventId}` : ""}
                        </label>
                      ))}
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
