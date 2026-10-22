"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_EUR_RATE,
  DEFAULT_EUR_ROUNDING_MODE,
  DEFAULT_EUR_ROUNDING_STEP,
  EUR_ROUNDING_MODE_LABELS_CS,
  EUR_ROUNDING_MODES,
  EUR_ROUNDING_STEPS,
  PRICE_LIST_KIND_LABELS_CS,
  PRICE_VERSION_STATUS_LABELS_CS,
  priceItemCode,
  type EurRoundingMode,
  type PriceListKind,
  type PriceListVersion,
  type PriceVersionHeaderInput,
  type PriceVersionStatus,
  type PublishCheck,
  type VersionedPriceList,
} from "../../../domain/priceVersions";
import type { ListDraft } from "../../../lib/db/priceVersions.remoteApi.client";
import type { PricingCatalogItem } from "../../../lib/db/priceVersions.supabase";

/** Shared pieces of the sale page and the purchase panel (V1-DATA-05). */

export function formatAmount(value: number | undefined, currency: string): string {
  return value === undefined ? "—" : `${value.toLocaleString("cs-CZ", { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${currency === "CZK" ? "Kč" : "€"}`;
}

/** "516", "516,5", "1 234,50" -> number; empty / invalid -> undefined (never 0). */
export function parseAmountText(value: string): number | undefined {
  const trimmed = value.replace(/\s/gu, "").replace(",", ".");
  if (!trimmed) return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

export function amountText(value: number | undefined): string {
  return value === undefined ? "" : String(value).replace(".", ",");
}

export function versionTitle(version: Pick<PriceListVersion, "versionNo" | "label">): string {
  return `v${version.versionNo}${version.label ? ` · ${version.label}` : ""}`;
}

export function validityText(version: Pick<PriceListVersion, "validFrom" | "validTo">): string {
  const format = (value: string | undefined) => (value ? new Date(`${value}T00:00:00`).toLocaleDateString("cs-CZ") : "…");
  return version.validFrom || version.validTo ? `${format(version.validFrom)} – ${format(version.validTo)}` : "neuvedeno";
}

export function StatusBadge({ status }: { status: PriceVersionStatus }) {
  return <span className={`priceVersionStatus ${status}`}>{PRICE_VERSION_STATUS_LABELS_CS[status]}</span>;
}

export function PublishCheckView({ check }: { check: PublishCheck | null }) {
  if (!check) return null;
  if (!check.errors.length && !check.warnings.length) return <p className="priceVersionCheck ok">Kontrola v pořádku, verzi lze publikovat.</p>;
  return (
    <div className="priceVersionCheck">
      {check.errors.map((error) => <p key={error} className="uploadError">✖ {error}</p>)}
      {check.warnings.map((warning) => <p key={warning} className="fieldHint">⚠ {warning}</p>)}
    </div>
  );
}

export function ListForm({ kinds, initial, onSave, onCancel }: {
  kinds: readonly PriceListKind[];
  initial?: VersionedPriceList;
  onSave: (draft: ListDraft) => Promise<void>;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ListDraft>(initial ?? { code: "", name: "", kind: kinds[0]!, isActive: true });
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    setError("");
    try {
      await onSave(draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Ceník se nepodařilo uložit.");
    } finally {
      setSaving(false);
    }
  }
  return (
    <section className="adminDetail">
      <div className="eventForm">
        <h2>{initial ? "Upravit ceník" : "Nový ceník"}</h2>
        <div className="twoColumns">
          <label><span>Kód *</span><input value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase() })} placeholder="např. ZAKLADNI" disabled={Boolean(initial)} /></label>
          <label><span>Druh</span>
            <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as PriceListKind })} disabled={Boolean(initial) || kinds.length === 1}>
              {kinds.map((kind) => <option key={kind} value={kind}>{PRICE_LIST_KIND_LABELS_CS[kind]}</option>)}
            </select>
          </label>
        </div>
        <label><span>Název *</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label><span>Poznámka</span><textarea value={draft.note ?? ""} onChange={(event) => setDraft({ ...draft, note: event.target.value })} /></label>
        <label className="checkLabel"><input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} /> Aktivní ceník</label>
        {error && <p className="uploadError">{error}</p>}
        <div className="assetActions">
          <button type="button" className="primaryButton" onClick={save} disabled={saving}>{saving ? "Ukládám…" : initial ? "Uložit ceník" : "Založit ceník"}</button>
          <button type="button" className="secondaryButton" onClick={onCancel}>Zrušit</button>
        </div>
      </div>
    </section>
  );
}

type HeaderDraft = Readonly<{ label: string; validFrom: string; validTo: string; eurRate: string; eurRoundingMode: EurRoundingMode; eurRoundingStep: string; note: string }>;

function headerDraftOf(version: PriceListVersion): HeaderDraft {
  return {
    label: version.label ?? "",
    validFrom: version.validFrom ?? "",
    validTo: version.validTo ?? "",
    eurRate: String(version.eurRate ?? DEFAULT_EUR_RATE).replace(".", ","),
    eurRoundingMode: version.eurRoundingMode ?? DEFAULT_EUR_ROUNDING_MODE,
    eurRoundingStep: String(version.eurRoundingStep ?? DEFAULT_EUR_ROUNDING_STEP),
    note: version.note ?? "",
  };
}

export function headerInputOf(draft: HeaderDraft): PriceVersionHeaderInput {
  return {
    ...(draft.label.trim() ? { label: draft.label.trim() } : {}),
    ...(draft.validFrom ? { validFrom: draft.validFrom } : {}),
    ...(draft.validTo ? { validTo: draft.validTo } : {}),
    eurRate: Number(draft.eurRate.replace(",", ".")),
    eurRoundingMode: draft.eurRoundingMode,
    eurRoundingStep: Number(draft.eurRoundingStep) as PriceVersionHeaderInput["eurRoundingStep"],
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
  };
}

/** Header of a version. Read-only once published: a new rate means a new version. */
export function VersionHeaderForm({ version, showEur, onSave, onRuleChange }: {
  version: PriceListVersion;
  showEur: boolean;
  onSave: (header: PriceVersionHeaderInput) => Promise<void>;
  onRuleChange?: (rule: Pick<PriceListVersion, "eurRate" | "eurRoundingMode" | "eurRoundingStep">) => void;
}) {
  const [draft, setDraft] = useState<HeaderDraft>(() => headerDraftOf(version));
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const editable = version.status === "draft";

  useEffect(() => {
    setDraft(headerDraftOf(version));
    setDirty(false);
    setError("");
    // Reset only when another version is shown or the stored one changed (its revision moved).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version.id, version.revision, version.status]);

  function update(patch: Partial<HeaderDraft>) {
    const next = { ...draft, ...patch };
    setDraft(next);
    setDirty(true);
    const rate = Number(next.eurRate.replace(",", "."));
    if (onRuleChange && rate > 0) onRuleChange({ eurRate: rate, eurRoundingMode: next.eurRoundingMode, eurRoundingStep: Number(next.eurRoundingStep) });
  }

  async function save() {
    setSaving(true);
    setError("");
    try {
      await onSave(headerInputOf(draft));
      setDirty(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Hlavičku se nepodařilo uložit.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="priceVersionHeader">
      <div className="twoColumns">
        <label><span>Označení verze</span><input value={draft.label} onChange={(event) => update({ label: event.target.value })} disabled={!editable} placeholder="např. 2026 podzim" /></label>
        <label><span>Poznámka</span><input value={draft.note} onChange={(event) => update({ note: event.target.value })} disabled={!editable} /></label>
      </div>
      <div className="twoColumns">
        <label><span>Evidenční platnost od</span><input type="date" value={draft.validFrom} onChange={(event) => update({ validFrom: event.target.value })} disabled={!editable} /></label>
        <label><span>Evidenční platnost do</span><input type="date" value={draft.validTo} onChange={(event) => update({ validTo: event.target.value })} disabled={!editable} /></label>
      </div>
      <p className="fieldHint">Platnost je jen evidenční. Veletrh používá verzi, která mu je výslovně přiřazená, bez ohledu na datum konání.</p>
      {showEur && (
        <div className="priceVersionEurRule">
          <label><span>Kurz (Kč za 1 €)</span><input value={draft.eurRate} onChange={(event) => update({ eurRate: event.target.value })} disabled={!editable} inputMode="decimal" /></label>
          <label><span>Zaokrouhlení EUR</span>
            <select value={draft.eurRoundingMode} onChange={(event) => update({ eurRoundingMode: event.target.value as EurRoundingMode })} disabled={!editable}>
              {EUR_ROUNDING_MODES.map((mode) => <option key={mode} value={mode}>{EUR_ROUNDING_MODE_LABELS_CS[mode]}</option>)}
            </select>
          </label>
          <label><span>Krok</span>
            <select value={draft.eurRoundingStep} onChange={(event) => update({ eurRoundingStep: event.target.value })} disabled={!editable}>
              {EUR_ROUNDING_STEPS.map((step) => <option key={step} value={String(step)}>{step.toLocaleString("cs-CZ")} €</option>)}
            </select>
          </label>
        </div>
      )}
      {showEur && <p className="fieldHint">Zaokrouhluje se jednotková cena, ne součet. Změnu kurzu u publikované verze řeší nová verze, staré ceny se nepřepočítají.</p>}
      {error && <p className="uploadError">{error}</p>}
      {editable && <div className="assetActions"><button type="button" className="secondaryButton" onClick={save} disabled={!dirty || saving}>{saving ? "Ukládám…" : "Uložit hlavičku verze"}</button></div>}
    </div>
  );
}

/** Versions of one list with the lifecycle actions. */
export function VersionTable({ versions, selectedId, usage, gaps, onSelect }: {
  versions: readonly PriceListVersion[];
  selectedId?: string;
  usage?: (versionId: string) => readonly string[];
  /** Price tracks a version cannot fully price (shown as a warning). */
  gaps?: (versionId: string) => readonly string[];
  onSelect: (versionId: string) => void;
}) {
  if (versions.length === 0) return <p className="workspaceEmpty">Ceník zatím nemá žádnou verzi.</p>;
  return (
    <table className="priceVersionTable">
      <thead><tr><th>Verze</th><th>Stav</th><th>Evidenční platnost</th><th>Kurz</th><th>Publikováno</th>{usage && <th>Používají veletrhy</th>}{gaps && <th>Neúplné cenové režimy</th>}</tr></thead>
      <tbody>
        {versions.map((version) => (
          <tr key={version.id} className={version.id === selectedId ? "selected" : ""} onClick={() => onSelect(version.id)}>
            <td><button type="button" className="linkButton">{versionTitle(version)}</button></td>
            <td><StatusBadge status={version.status} /></td>
            <td>{validityText(version)}</td>
            <td>{version.eurRate.toLocaleString("cs-CZ")}</td>
            <td>{version.publishedAt ? `${new Date(version.publishedAt).toLocaleString("cs-CZ")}${version.publishedBy ? ` · ${version.publishedBy}` : ""}` : "—"}</td>
            {usage && <td>{usage(version.id).join(", ") || "—"}</td>}
            {gaps && <td className={gaps(version.id).length ? "dangerText" : ""}>{gaps(version.id).join(", ") || "úplné"}</td>}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** Lifecycle buttons of the selected version. */
export function VersionActions({ version, busy, onCheck, onPublish, onDelete, onArchive, onCopy }: {
  version: PriceListVersion;
  busy: boolean;
  onCheck: () => void;
  onPublish: () => void;
  onDelete: () => void;
  onArchive: () => void;
  onCopy: () => void;
}) {
  return (
    <div className="assetActions priceVersionActions">
      {version.status === "draft" && <button type="button" className="secondaryButton" onClick={onCheck} disabled={busy}>Zkontrolovat</button>}
      {version.status === "draft" && <button type="button" className="primaryButton" onClick={onPublish} disabled={busy}>Publikovat</button>}
      {version.status === "draft" && <button type="button" className="secondaryButton dangerText" onClick={onDelete} disabled={busy}>Smazat koncept</button>}
      <button type="button" className="secondaryButton" onClick={onCopy} disabled={busy}>{version.status === "draft" ? "Kopírovat do nové verze" : "Vytvořit opravnou verzi"}</button>
      {version.status === "published" && <button type="button" className="secondaryButton" onClick={onArchive} disabled={busy}>Archivovat</button>}
    </div>
  );
}

/** ABF code from the catalog card; internal items without one show their generator code. */
export function ItemCodeCell({ item }: { item: PricingCatalogItem | undefined }) {
  const code = priceItemCode(item);
  if (!code) return <td className="priceItemCode"><span className="fieldHint">—</span></td>;
  return <td className="priceItemCode" title={code.kind === "abf" ? "ABF kód z katalogové karty" : "Generátorový kód (karta nemá ABF kód)"}><code>{code.code}</code>{code.kind === "generator" && <small className="fieldHint"> gen.</small>}</td>;
}
