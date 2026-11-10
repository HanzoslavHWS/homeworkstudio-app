"use client";

import { useState } from "react";
import type { CatalogItemAdmin } from "../../domain/catalogItemsAdmin";
import type { CatalogItemAlias, CatalogItemAliasInput, CatalogItemAliasKind } from "../../domain/catalogItemAliases";
import type { CatalogAliasRegister } from "../../lib/db/catalogItemsAdmin.remoteApi.client";
import { NativeSelect } from "@/components/ui/native-select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

type DraftRow = CatalogItemAliasInput & Readonly<{ key: string }>;

const KIND_LABELS: Record<CatalogItemAliasKind, string> = { name: "Název", code: "Kód" };

function draftRows(itemId: string, aliases: readonly CatalogItemAlias[]): DraftRow[] {
  return aliases
    .filter((alias) => alias.catalogItemId === itemId && alias.isActive)
    .map((alias) => ({
      key: alias.id,
      id: alias.id,
      realizationCompanyId: alias.realizationCompanyId,
      aliasKind: alias.aliasKind,
      aliasText: alias.aliasText,
      unitCode: alias.unitCode,
      note: alias.note,
    }));
}

/**
 * "Alternativní názvy a kódy realizaček" (V1-DATA-03). General aliases and the names/codes each
 * realization company (V1-DATA-02 register) uses for this item — several per company allowed.
 * Saved as a whole list; a removed alias is deactivated on the server, never deleted.
 */
export function CatalogAliasesSection({
  item,
  register,
  onSave,
}: {
  item: CatalogItemAdmin;
  register: CatalogAliasRegister;
  /** Returns the item's aliases as stored, so the editor continues with their real ids. */
  onSave: (aliases: readonly CatalogItemAliasInput[]) => Promise<readonly CatalogItemAlias[]>;
}) {
  const [rows, setRows] = useState<DraftRow[]>(() => draftRows(item.id, register.aliases));
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);

  function update(key: string, patch: Partial<CatalogItemAliasInput>) {
    setRows((current) => current.map((row) => (row.key === key ? { ...row, ...patch } : row)));
    setDirty(true);
    setSaved(false);
  }

  function add(aliasKind: CatalogItemAliasKind) {
    setRows((current) => [...current, { key: `new-${Date.now()}-${current.length}`, aliasKind, aliasText: "" }]);
    setDirty(true);
    setSaved(false);
  }

  function remove(key: string) {
    setRows((current) => current.filter((row) => row.key !== key));
    setDirty(true);
    setSaved(false);
  }

  async function save() {
    setBusy(true);
    setError("");
    try {
      const stored = await onSave(rows.map(({ key: _key, ...row }) => row));
      setRows(draftRows(item.id, stored));
      setDirty(false);
      setSaved(true);
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Aliasy se nepodařilo uložit.");
    } finally {
      setBusy(false);
    }
  }

  const companyName = (id: string | undefined) => (id ? register.companies.find((company) => company.id === id)?.name ?? id : "Obecný");
  const activeCompanies = register.companies.filter((company) => company.isActive || rows.some((row) => row.realizationCompanyId === company.id));

  return (
    <section className="catalogDetailSection catalogAliasesSection">
      <h3>Alternativní názvy a kódy realizaček</h3>
      <p className="fieldHint">
        Obecný alias platí pro všechny. Alias realizačky platí jen pro danou firmu — stejný text u jiné firmy může znamenat jinou položku.
        Firmy se berou z evidence Realizační firmy.
      </p>
      {rows.length === 0 && <p className="fieldHint">Zatím bez aliasů.</p>}
      {rows.length > 0 && (
        <div className="overflow-x-auto">
        <table className="dataTable catalogAliasTable min-w-[560px]">
          <thead>
            <tr><th>Druh</th><th>Realizačka</th><th>Text</th><th>Jednotka u firmy</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td>
                  <NativeSelect aria-label="Druh aliasu" value={row.aliasKind} onChange={(event) => update(row.key, { aliasKind: event.target.value as CatalogItemAliasKind })}>
                    {(Object.keys(KIND_LABELS) as CatalogItemAliasKind[]).map((kind) => <option key={kind} value={kind}>{KIND_LABELS[kind]}</option>)}
                  </NativeSelect>
                </td>
                <td>
                  <NativeSelect aria-label="Realizačka" value={row.realizationCompanyId ?? ""} onChange={(event) => update(row.key, { realizationCompanyId: event.target.value || undefined })}>
                    <option value="">Obecný</option>
                    {activeCompanies.map((company) => <option key={company.id} value={company.id}>{company.name}{company.isActive ? "" : " (neaktivní)"}</option>)}
                  </NativeSelect>
                </td>
                <td>
                  <Input aria-label="Text aliasu" value={row.aliasText} onChange={(event) => update(row.key, { aliasText: event.target.value })} placeholder={row.aliasKind === "code" ? "např. CR-ZID-01" : "např. Židle čalouněná černá"} />
                </td>
                <td>
                  <NativeSelect aria-label="Jednotka u firmy" value={row.unitCode ?? ""} onChange={(event) => update(row.key, { unitCode: event.target.value || undefined })}>
                    <option value="">jako karta</option>
                    {register.units.map((unit) => <option key={unit.code} value={unit.code}>{unit.symbol}</option>)}
                  </NativeSelect>
                </td>
                <td><Button variant="outline" type="button" onClick={() => remove(row.key)}>Odebrat</Button></td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      )}
      <div className="assetActions">
        <Button variant="outline" type="button" onClick={() => add("name")}>+ Název</Button>
        <Button variant="outline" type="button" onClick={() => add("code")}>+ Kód</Button>
        <Button variant="default" type="button" onClick={() => void save()} disabled={!dirty || busy}>{busy ? "Ukládám…" : "Uložit aliasy"}</Button>
      </div>
      {error && <p className="uploadError">{error}</p>}
      {saved && !dirty && <p className="fieldHint">Aliasy uloženy ({rows.length}). {rows.filter((row) => row.realizationCompanyId).length > 0 ? `Firmy: ${[...new Set(rows.filter((row) => row.realizationCompanyId).map((row) => companyName(row.realizationCompanyId)))].join(", ")}.` : ""}</p>}
    </section>
  );
}
