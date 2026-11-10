"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ActionBar, ConfirmDialog, EmptyState, Field, LoadingState, Notice, PageHeader, StatusBadge } from "@/components/ui/workspace";
import { HWS_APPS, INVITATION_STATUS_LABELS_CS, appRoleLabel, type AppMemberships, type HwsAppKey, type InvitationStatus } from "../../domain/hwsApps";
import type { CurrentUser } from "../../lib/auth/pageAuth.server";
import { UserMenu } from "../auth/UserMenu";

/**
 * Správa uživatelů HomeworkStudio (V1-AUTH-02): one account per person, access and role per
 * application, invitations and (de)activation. Everything goes through /api/hws/accounts/* (shared
 * administrators only — the server checks every call). Results are reported from the server's answer;
 * "odesláno" is shown only when the e-mail really left.
 */
type Invitation = { id: string; status: InvitationStatus; delivery: "manual" | "email"; lastError: string | null; createdAt: string };
type Account = { id: string; email: string; displayName: string | null; isActive: boolean; isHwsAdmin: boolean; apps: AppMemberships; updatedAt: string; deactivatedAt: string | null; invitation: Invitation | null; activated: boolean; lastSignInAt: string | null };
type Mailer = { configured: true } | { configured: false; reason: string };
type AccessDraft = Partial<Record<HwsAppKey, { enabled: boolean; role: string }>>;
type LinkResult = { link?: string; linkNote?: string; notice: string; emailSent: boolean };

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin", ...init, headers: { Accept: "application/json", ...(init?.body ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!response.ok) throw Object.assign(new Error(body.error ?? `Požadavek selhal (HTTP ${response.status}).`), { code: body.code, body });
  return body;
}

const formatDate = (value: string | null | undefined) => (value ? new Date(value).toLocaleString("cs-CZ", { dateStyle: "short", timeStyle: "short" }) : "—");

function accessDraftOf(apps: AppMemberships): AccessDraft {
  return Object.fromEntries(HWS_APPS.map((app) => [app.key, { enabled: apps[app.key] !== undefined, role: apps[app.key] ?? app.defaultRole }])) as AccessDraft;
}
const accessPayload = (draft: AccessDraft) => HWS_APPS.flatMap((app) => (draft[app.key]?.enabled ? [{ appKey: app.key, role: draft[app.key]!.role }] : []));
const sameAccess = (a: AccessDraft, apps: AppMemberships) => JSON.stringify(accessPayload(a)) === JSON.stringify(accessPayload(accessDraftOf(apps)));

function accountState(account: Account): { label: string; tone: "success" | "warning" | "muted"; symbol: string } {
  if (!account.isActive) return { label: "Deaktivovaný", tone: "muted", symbol: "○" };
  if (!account.activated) return { label: "Čeká na aktivaci", tone: "warning", symbol: "◐" };
  return { label: "Aktivní", tone: "success", symbol: "●" };
}

/** Applications with a role per ticked application; an unticked application's role is never sent. */
/** Changes are functional updates of the latest draft, so quick consecutive edits never overwrite each other. */
function AccessEditor({ idPrefix, draft, onChange, disabled }: { idPrefix: string; draft: AccessDraft; onChange: (update: (current: AccessDraft) => AccessDraft) => void; disabled?: boolean }) {
  return (
    <fieldset className="@container grid min-w-0 gap-3" disabled={disabled}>
      <legend className="mb-1 text-[13px] font-semibold text-muted-foreground">Přístup do aplikací</legend>
      {HWS_APPS.map((app) => {
        const entry = draft[app.key] ?? { enabled: false, role: app.defaultRole };
        const checkId = `${idPrefix}-${app.key}`;
        return (
          <div key={app.key} className="grid min-w-0 items-center gap-2 rounded-lg border p-3 @md:grid-cols-[minmax(0,1fr)_minmax(0,200px)]">
            <div className="flex min-w-0 items-center gap-2">
              <Checkbox id={checkId} checked={entry.enabled} onCheckedChange={(checked) => onChange((current) => ({ ...current, [app.key]: { ...(current[app.key] ?? entry), enabled: checked === true } }))} />
              <Label htmlFor={checkId} className="font-medium">
                {app.name}
                {app.status === "coming_soon" && <span className="ml-2 text-xs font-normal text-muted-foreground">(Připravujeme)</span>}
              </Label>
            </div>
            <NativeSelect
              aria-label={`Role v aplikaci ${app.name}`}
              value={entry.role}
              disabled={!entry.enabled || disabled}
              onChange={(event) => { const role = event.target.value; onChange((current) => ({ ...current, [app.key]: { ...(current[app.key] ?? entry), role } })); }}
            >
              {app.roles.map((role) => <option key={role} value={role}>{app.roleLabels[role] ?? role}</option>)}
            </NativeSelect>
          </div>
        );
      })}
    </fieldset>
  );
}

function LinkBox({ result, onCopied, onCopyFailed }: { result: LinkResult; onCopied: () => void; onCopyFailed: () => void }) {
  return (
    <div className="grid gap-2 rounded-lg border bg-muted/40 p-3">
      <p className="text-sm font-medium" role="status">{result.notice}</p>
      {result.link && (
        <>
          <div className="flex flex-wrap gap-2">
            <Input className="min-w-0 flex-[1_1_12rem]" value={result.link} readOnly aria-label="Jednorázový odkaz" onFocus={(event) => event.currentTarget.select()} />
            <Button type="button" variant="outline" onClick={() => void navigator.clipboard?.writeText(result.link!).then(onCopied, onCopyFailed)}>Kopírovat</Button>
          </div>
          {result.linkNote && <p className="text-xs text-muted-foreground">{result.linkNote}</p>}
        </>
      )}
    </div>
  );
}

export function AccountsAdminPage({ currentUser }: Readonly<{ currentUser: CurrentUser }>) {
  const [accounts, setAccounts] = useState<readonly Account[]>([]);
  const [mailer, setMailer] = useState<Mailer | undefined>();
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [stateFilter, setStateFilter] = useState<"" | "active" | "pending" | "inactive">("");
  const [notice, setNotice] = useState("");

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const body = await api<{ accounts: Account[]; mailer: Mailer }>("/api/hws/accounts");
      setAccounts(body.accounts);
      setMailer(body.mailer);
      setLoadError("");
      return body.accounts;
    } catch (cause) {
      setLoadError(cause instanceof Error ? cause.message : "Seznam uživatelů se nepodařilo načíst.");
      return undefined;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return accounts.filter((account) => {
      if (needle && !account.email.includes(needle) && !(account.displayName ?? "").toLowerCase().includes(needle)) return false;
      if (stateFilter === "active") return account.isActive && account.activated;
      if (stateFilter === "pending") return account.isActive && !account.activated;
      if (stateFilter === "inactive") return !account.isActive;
      return true;
    });
  }, [accounts, query, stateFilter]);

  // ---- invitation ---------------------------------------------------------------------------
  const [inviteOpen, setInviteOpen] = useState(false);
  const [invite, setInvite] = useState({ email: "", displayName: "", delivery: "manual" as "manual" | "email" });
  const [inviteAccess, setInviteAccess] = useState<AccessDraft>(accessDraftOf({}));
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [inviteResult, setInviteResult] = useState<LinkResult | undefined>();
  const [existingId, setExistingId] = useState<string | undefined>();

  function openInvite() {
    setInvite({ email: "", displayName: "", delivery: "manual" });
    setInviteAccess(accessDraftOf({}));
    setInviteError("");
    setInviteResult(undefined);
    setExistingId(undefined);
    setInviteOpen(true);
  }

  async function submitInvite() {
    setInviteBusy(true);
    setInviteError("");
    setExistingId(undefined);
    try {
      const body = await api<{ account: Account; link?: string; linkNote?: string; notice: string; emailSent: boolean; resumed: boolean }>("/api/hws/accounts/invite", { method: "POST", body: JSON.stringify({ ...invite, access: accessPayload(inviteAccess) }) });
      setInviteResult({ link: body.link, linkNote: body.linkNote, notice: `${body.resumed ? "Nedokončená pozvánka byla dokončena. " : "Pozvánka je připravená, přístupy uloženy. "}${body.notice}`, emailSent: body.emailSent });
      await reload();
    } catch (cause) {
      const error = cause as Error & { code?: string; body?: { userId?: string } };
      setInviteError(error.message);
      if (error.code === "account_exists") setExistingId(error.body?.userId);
      await reload();
    } finally {
      setInviteBusy(false);
    }
  }

  // ---- edit ---------------------------------------------------------------------------------
  const [editing, setEditing] = useState<Account | undefined>();
  const [draft, setDraft] = useState<{ displayName: string; isActive: boolean; isHwsAdmin: boolean; access: AccessDraft } | undefined>();
  const [editBusy, setEditBusy] = useState("");
  const [editError, setEditError] = useState("");
  const [editNotice, setEditNotice] = useState("");
  const [linkResult, setLinkResult] = useState<LinkResult | undefined>();
  const [linkDelivery, setLinkDelivery] = useState<"manual" | "email">("manual");
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  function openEdit(account: Account) {
    setEditing(account);
    setDraft({ displayName: account.displayName ?? "", isActive: account.isActive, isHwsAdmin: account.isHwsAdmin, access: accessDraftOf(account.apps) });
    setEditError("");
    setEditNotice("");
    setLinkResult(undefined);
    setLinkDelivery("manual");
  }

  const dirty = Boolean(editing && draft && (draft.displayName !== (editing.displayName ?? "") || draft.isActive !== editing.isActive || draft.isHwsAdmin !== editing.isHwsAdmin || !sameAccess(draft.access, editing.apps)));
  const isSelf = editing?.id === currentUser.id;
  const inviteDirty = inviteOpen && !inviteResult && Boolean(invite.email.trim() || invite.displayName.trim());

  // Leaving the page (reload, address bar, closing the tab) with unsaved edits asks first.
  useEffect(() => {
    if (!dirty && !inviteDirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, inviteDirty]);

  function requestClose() {
    if (dirty) setConfirmDiscard(true);
    else setEditing(undefined);
  }

  async function saveEdit() {
    if (!editing || !draft) return;
    setEditBusy("save");
    setEditError("");
    setEditNotice("");
    try {
      const body = await api<{ account: Account }>("/api/hws/accounts/update", {
        method: "POST",
        body: JSON.stringify({ userId: editing.id, expectedUpdatedAt: editing.updatedAt, displayName: draft.displayName, isActive: draft.isActive, isHwsAdmin: draft.isHwsAdmin, access: accessPayload(draft.access) }),
      });
      const fresh = (await reload())?.find((account) => account.id === body.account.id);
      if (fresh) openEdit(fresh);
      setEditNotice("Uloženo. Změna platí od příštího požadavku uživatele, i v už otevřeném přihlášení.");
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : "Změnu se nepodařilo uložit.");
    } finally {
      setEditBusy("");
    }
  }

  async function newLink() {
    if (!editing) return;
    setEditBusy("link");
    setEditError("");
    setLinkResult(undefined);
    try {
      const body = await api<{ kind: "invite" | "recovery"; link?: string; linkNote?: string; notice: string; emailSent: boolean }>("/api/hws/accounts/link", { method: "POST", body: JSON.stringify({ userId: editing.id, delivery: linkDelivery }) });
      setLinkResult({ link: body.link, linkNote: body.linkNote, notice: `${body.kind === "invite" ? "Nový odkaz pozvánky." : "Odkaz pro nastavení nového hesla (dosavadní heslo platí, dokud ho uživatel nezmění)."} ${body.notice}`, emailSent: body.emailSent });
      await reload();
    } catch (cause) {
      setEditError(cause instanceof Error ? cause.message : "Odkaz se nepodařilo vytvořit.");
    } finally {
      setEditBusy("");
    }
  }

  const emailOption = mailer?.configured ? "Odeslat e-mailem" : "Odeslat e-mailem (nenastaveno)";
  const inviteAccessCount = accessPayload(inviteAccess).length;

  return (
    <div data-ui="accounts" className="min-h-screen bg-muted">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b bg-background px-4 py-3 sm:px-8">
        <a href="/" className="text-sm font-bold tracking-[0.18em] text-foreground no-underline">HOMEWORKSTUDIO</a>
        <UserMenu user={currentUser} roleLabel="Správce HomeworkStudia" />
      </header>
      <main className="mx-auto w-full max-w-[1400px] px-4 py-6 sm:px-8">
        <PageHeader
          eyebrow="HomeworkStudio"
          title="Správa uživatelů"
          description="Společné účty, přístupy do aplikací a jejich role. Veřejná registrace neexistuje — účty vznikají jen pozvánkou."
          actions={
            <>
              <Button variant="outline" asChild><a href="/">Zpět na rozcestník</a></Button>
              <Button type="button" onClick={openInvite}>+ Pozvat uživatele</Button>
            </>
          }
        />

        {mailer && mailer.configured === false && <Notice tone="info" title="Pozvánky se předávají odkazem">{mailer.reason}</Notice>}
        {loadError && <Notice tone="error">{loadError}</Notice>}
        {notice && <Notice tone="success">{notice}</Notice>}

        <div className="mb-4 grid gap-3 rounded-xl border bg-card p-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" role="search">
          <Field id="accounts-query" label="Hledat">
            <Input id="accounts-query" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Jméno nebo e-mail" />
          </Field>
          <Field id="accounts-state" label="Stav účtu">
            <NativeSelect id="accounts-state" value={stateFilter} onChange={(event) => setStateFilter(event.target.value as typeof stateFilter)}>
              <option value="">Všechny</option>
              <option value="active">Aktivní</option>
              <option value="pending">Čeká na aktivaci</option>
              <option value="inactive">Deaktivované</option>
            </NativeSelect>
          </Field>
        </div>

        {loading && accounts.length === 0 ? (
          <LoadingState label="Načítám účty…" />
        ) : filtered.length === 0 ? (
          <EmptyState title="Žádné účty" description={accounts.length ? "Filtrům neodpovídá žádný účet." : "Zatím tu nejsou žádné účty."} />
        ) : (
          <div className="overflow-hidden rounded-xl border bg-card">
            <Table className="min-w-[860px]">
              <TableHeader className="bg-muted/60">
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4 text-muted-foreground">Uživatel</TableHead>
                  <TableHead className="text-muted-foreground">Stav účtu</TableHead>
                  <TableHead className="text-muted-foreground">Aplikace a role</TableHead>
                  <TableHead className="text-muted-foreground">Pozvánka</TableHead>
                  <TableHead className="pr-4 text-right text-muted-foreground"><span className="sr-only">Akce</span></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.map((account) => {
                  const state = accountState(account);
                  const apps = HWS_APPS.filter((app) => account.apps[app.key] !== undefined);
                  return (
                    <TableRow key={account.id}>
                      <TableCell className="pl-4 whitespace-normal">
                        <strong className="block font-semibold">{account.displayName || account.email}{account.id === currentUser.id ? " (vy)" : ""}</strong>
                        <span className="text-xs text-muted-foreground">{account.email}</span>
                        {account.isHwsAdmin && <StatusBadge tone="info" className="mt-1 flex w-fit">Správce HomeworkStudia</StatusBadge>}
                      </TableCell>
                      <TableCell>
                        <StatusBadge tone={state.tone} symbol={state.symbol}>{state.label}</StatusBadge>
                        {account.lastSignInAt && <small className="mt-0.5 block text-xs text-muted-foreground">přihlášen {formatDate(account.lastSignInAt)}</small>}
                      </TableCell>
                      <TableCell className="whitespace-normal">
                        {apps.length === 0 ? (
                          <span className="text-sm text-muted-foreground">Žádná aplikace</span>
                        ) : (
                          <span className="flex flex-wrap gap-1">
                            {apps.map((app) => <StatusBadge key={app.key} tone="neutral">{app.name} · {appRoleLabel(app.key, account.apps[app.key]!)}</StatusBadge>)}
                          </span>
                        )}
                      </TableCell>
                      <TableCell className="whitespace-normal text-sm">
                        {account.invitation ? (
                          <>
                            <span className={account.invitation.status === "access_pending" || account.invitation.status === "send_failed" ? "font-medium text-warning" : ""}>{INVITATION_STATUS_LABELS_CS[account.invitation.status]}</span>
                            <small className="block text-xs text-muted-foreground">{formatDate(account.invitation.createdAt)}</small>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </TableCell>
                      <TableCell className="pr-4 text-right">
                        <Button type="button" variant="outline" size="sm" onClick={() => openEdit(account)} aria-label={`Upravit ${account.displayName || account.email}`}>Upravit</Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </main>

      {/* ---- Invitation ---- */}
      <Dialog open={inviteOpen} onOpenChange={(open) => { if (!inviteBusy) setInviteOpen(open); }}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>Pozvat uživatele</DialogTitle>
            <DialogDescription>Vznikne jeden účet HomeworkStudio s přístupem do zaškrtnutých aplikací. Existující e-mail nový účet nezaloží.</DialogDescription>
          </DialogHeader>
          {inviteResult ? (
            <LinkBox result={inviteResult} onCopied={() => setInviteResult({ ...inviteResult, notice: "Odkaz zkopírován do schránky." })} onCopyFailed={() => setInviteError("Odkaz se nepodařilo zkopírovat — označte ho a zkopírujte ručně.")} />
          ) : (
            <div className="grid gap-4">
              <Field id="invite-name" label="Jméno">
                <Input id="invite-name" value={invite.displayName} onChange={(event) => setInvite({ ...invite, displayName: event.target.value })} autoComplete="off" />
              </Field>
              <Field id="invite-email" label="E-mail *">
                <Input id="invite-email" type="email" required value={invite.email} onChange={(event) => setInvite({ ...invite, email: event.target.value })} autoComplete="off" />
              </Field>
              <AccessEditor idPrefix="invite-app" draft={inviteAccess} onChange={setInviteAccess} />
              <Field id="invite-delivery" label="Doručení pozvánky" hint={mailer?.configured === false ? mailer.reason : "E-mail obsahuje jednorázový odkaz pro nastavení hesla."}>
                <NativeSelect id="invite-delivery" value={invite.delivery} onChange={(event) => setInvite({ ...invite, delivery: event.target.value as "manual" | "email" })}>
                  <option value="manual">Odkaz k ručnímu předání</option>
                  <option value="email" disabled={!mailer?.configured}>{emailOption}</option>
                </NativeSelect>
              </Field>
            </div>
          )}
          {inviteError && (
            <Notice tone="error">
              {inviteError}
              {existingId && (
                <>
                  {" "}
                  <Button type="button" variant="link" className="h-auto p-0" onClick={() => { const account = accounts.find((item) => item.id === existingId); setInviteOpen(false); if (account) openEdit(account); }}>Upravit přístupy tohoto účtu</Button>
                </>
              )}
            </Notice>
          )}
          <DialogFooter>
            {inviteResult ? (
              <Button type="button" onClick={() => setInviteOpen(false)}>Hotovo</Button>
            ) : (
              <>
                <Button type="button" variant="outline" onClick={() => setInviteOpen(false)} disabled={inviteBusy}>Zrušit</Button>
                <Button type="button" onClick={() => void submitInvite()} disabled={inviteBusy || !invite.email.trim() || inviteAccessCount === 0}>{inviteBusy ? "Vytvářím…" : "Vytvořit pozvánku"}</Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- Edit ---- */}
      <Sheet open={Boolean(editing)} onOpenChange={(open) => { if (!open) requestClose(); }}>
        <SheetContent side="right" className="overflow-y-auto data-[side=right]:w-full data-[side=right]:max-w-full data-[side=right]:sm:max-w-lg">
          {editing && draft && (
            <>
              <SheetHeader>
                <SheetTitle>{editing.displayName || editing.email}</SheetTitle>
                <SheetDescription>{editing.email} · {accountState(editing).label}{editing.deactivatedAt ? ` od ${formatDate(editing.deactivatedAt)}` : ""}</SheetDescription>
              </SheetHeader>
              <div className="@container grid min-w-0 gap-5 px-4">
                <Field id="edit-name" label="Jméno">
                  <Input id="edit-name" value={draft.displayName} onChange={(event) => setDraft({ ...draft, displayName: event.target.value })} />
                </Field>
                <div className="grid gap-3 rounded-lg border p-3">
                  <div className="flex items-start justify-between gap-3">
                    <Label htmlFor="edit-active" className="grid gap-0.5">
                      <span className="font-medium">Aktivní účet</span>
                      <span className="text-xs font-normal text-muted-foreground">Deaktivace zablokuje všechny aplikace a ukončí přihlášení.</span>
                    </Label>
                    <Switch id="edit-active" checked={draft.isActive} disabled={isSelf} onCheckedChange={(checked) => setDraft({ ...draft, isActive: checked })} />
                  </div>
                  <div className="flex items-start justify-between gap-3">
                    <Label htmlFor="edit-hws-admin" className="grid gap-0.5">
                      <span className="font-medium">Správce HomeworkStudia</span>
                      <span className="text-xs font-normal text-muted-foreground">Spravuje účty a přístupy. Data aplikací otevírá jen přes vlastní členství.</span>
                    </Label>
                    <Switch id="edit-hws-admin" checked={draft.isHwsAdmin} disabled={isSelf} onCheckedChange={(checked) => setDraft({ ...draft, isHwsAdmin: checked })} />
                  </div>
                  {isSelf && <p className="text-xs text-muted-foreground">Vlastní účet a vlastní správu může vypnout jen jiný správce.</p>}
                </div>
                <AccessEditor idPrefix="edit-app" draft={draft.access} onChange={(update) => setDraft((current) => (current ? { ...current, access: update(current.access) } : current))} />
                <p className="text-xs text-muted-foreground">Odebrání aplikace zablokuje jen ji; zakázky, historie a autorství zůstávají. Heslo se úpravou nemění.</p>

                <div className="grid gap-2 rounded-lg border p-3">
                  <strong className="text-sm">{editing.activated ? "Nové heslo" : "Pozvánka"}</strong>
                  <p className="text-xs text-muted-foreground">
                    {editing.activated
                      ? "Účet je aktivovaný. Odkaz pro nastavení nového hesla vytvořte jen na žádost uživatele — dosavadní heslo platí, dokud ho nezmění."
                      : editing.invitation
                        ? `Stav: ${INVITATION_STATUS_LABELS_CS[editing.invitation.status]}${editing.invitation.lastError ? ` (${editing.invitation.lastError})` : ""}.`
                        : "Účet ještě nemá nastavené heslo."}
                  </p>
                  <div className="grid min-w-0 gap-2 @md:grid-cols-[minmax(0,1fr)_auto]">
                    <NativeSelect aria-label="Doručení odkazu" value={linkDelivery} onChange={(event) => setLinkDelivery(event.target.value as "manual" | "email")}>
                      <option value="manual">Odkaz k ručnímu předání</option>
                      <option value="email" disabled={!mailer?.configured}>{emailOption}</option>
                    </NativeSelect>
                    <Button type="button" variant="outline" onClick={() => void newLink()} disabled={editBusy !== "" || !editing.isActive || dirty}>
                      {editBusy === "link" ? "Připravuji…" : editing.activated ? "Odkaz pro nové heslo" : "Znovu vytvořit pozvánku"}
                    </Button>
                  </div>
                  {dirty && <p className="text-xs text-muted-foreground">Nejdřív uložte změny.</p>}
                  {linkResult && <LinkBox result={linkResult} onCopied={() => setLinkResult({ ...linkResult, notice: "Odkaz zkopírován do schránky." })} onCopyFailed={() => setEditError("Odkaz se nepodařilo zkopírovat — označte ho a zkopírujte ručně.")} />}
                </div>
                {editError && <Notice tone="error">{editError}</Notice>}
                {editNotice && <Notice tone="success">{editNotice}</Notice>}
              </div>
              <SheetFooter>
                <ActionBar className="flex-wrap justify-end">
                  <Button type="button" variant="outline" onClick={requestClose}>Zavřít</Button>
                  <Button type="button" onClick={() => void saveEdit()} disabled={editBusy !== "" || !dirty}>{editBusy === "save" ? "Ukládám…" : "Uložit změny"}</Button>
                </ActionBar>
              </SheetFooter>
            </>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={confirmDiscard}
        title="Zahodit neuložené změny?"
        description="Úpravy jména, stavu nebo přístupů se neuloží."
        choices={[{ label: "Zahodit změny", value: "discard", destructive: true }]}
        onChoose={() => { setConfirmDiscard(false); setEditing(undefined); setNotice(""); }}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}
