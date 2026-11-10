"use client";

import { useState } from "react";
import {
  COMPONENT_GROUP_LABELS_CS,
  COMPONENT_GROUP_TARGETS,
  COMPONENT_GROUPS,
  type CatalogCategoryDef,
  type ComponentGroup,
} from "../../domain/catalogClassification";
import { CATALOG_ITEM_KIND_LABELS_CS } from "../../domain/catalogItemsAdmin";
import { TECHNICAL_SERVICE_CATEGORIES } from "../../domain/technicalServiceCatalog";
import type { CatalogItemKind } from "../../domain/models";
import type { ParameterValueType } from "../../domain/catalogParameters";
import { saveCatalogCategoryRemote, useCatalogCategories } from "../../lib/db/catalogCategories.remoteApi.client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { NativeSelect } from "@/components/ui/native-select";
import { Textarea } from "@/components/ui/textarea";

type Draft = Readonly<{
  isNew: boolean;
  id: string;
  name: string;
  group: ComponentGroup;
  kinds: readonly CatalogItemKind[];
  description: string;
  isActive: boolean;
  sortOrder: string;
  serviceCategory: string;
  priceCategory: "" | "standard" | "electricity";
  recommended: readonly ParameterDraft[];
}>;

/** rowKey = React key only (stable while rows are added/removed); never sent to the server. */
type ParameterDraft = Readonly<{ rowKey: string; id: string; name: string; valueType: ParameterValueType; unit: string; sortOrder: string; isActive: boolean; isNew: boolean }>;

let rowKeySequence = 0;
const nextRowKey = () => `row-${++rowKeySequence}`;

function toDraft(category: CatalogCategoryDef): Draft {
  return {
    isNew: false,
    id: category.id,
    name: category.name,
    group: category.group,
    kinds: category.kinds,
    description: category.description ?? "",
    isActive: category.isActive,
    sortOrder: String(category.sortOrder),
    serviceCategory: category.serviceCategory ?? "",
    priceCategory: category.priceCategory ?? "",
    recommended: (category.recommendedParameters ?? []).map((parameter) => ({ rowKey: nextRowKey(), id: parameter.id, name: parameter.name, valueType: parameter.valueType, unit: parameter.unit ?? "", sortOrder: String(parameter.sortOrder), isActive: parameter.isActive, isNew: false })),
  };
}

function newDraft(group: ComponentGroup): Draft {
  return { isNew: true, id: "", name: "", group, kinds: [COMPONENT_GROUP_TARGETS[group].kinds[0]!], description: "", isActive: true, sortOrder: "1000", serviceCategory: "", priceCategory: "", recommended: [] };
}

/**
 * Administrace → Katalog komponent → Kategorie (V1-CATALOG). Categories of the five component
 * groups: add / rename / describe / (de)activate / reorder, plus their technical and pricing mapping.
 * Never deleted (deactivate instead); a category used by cards keeps its group (server check).
 * Read-only while the catalog_categories migration is not applied (built-in list).
 */
export function CatalogCategoriesPanel({ onClose }: { onClose: () => void }) {
  const register = useCatalogCategories();
  const [draft, setDraft] = useState<Draft | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await saveCatalogCategoryRemote(
        {
          id: draft.id.trim(),
          name: draft.name.trim(),
          group: draft.group,
          kinds: draft.kinds,
          ...(draft.description.trim() ? { description: draft.description.trim() } : {}),
          isActive: draft.isActive,
          sortOrder: Number(draft.sortOrder) || 1000,
          ...(draft.serviceCategory ? { serviceCategory: draft.serviceCategory } : {}),
          ...(draft.priceCategory ? { priceCategory: draft.priceCategory } : {}),
          recommendedParameters: draft.recommended
            .filter((parameter) => parameter.name.trim())
            .map((parameter) => ({ id: parameter.isNew ? "" : parameter.id, name: parameter.name.trim(), valueType: parameter.valueType, ...(parameter.unit.trim() ? { unit: parameter.unit.trim() } : {}), sortOrder: Number(parameter.sortOrder) || 0, isActive: parameter.isActive })) as never,
        },
        draft.isNew,
      );
      setMessage(`Kategorie „${saved.name}“ byla uložena.`);
      setDraft(undefined);
      register.reload();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Kategorii se nepodařilo uložit.");
    } finally {
      setBusy(false);
    }
  }

  const technical = draft && (draft.group === "technical_service" || draft.group === "technical_point");

  return (
    <div className="catalogDetailSection adminDetail catalogCategoriesPanel rounded-xl border bg-card p-5">
      <div className="priceVersionListHeader">
        <h3 className="text-lg font-semibold tracking-normal normal-case text-foreground">Kategorie katalogu</h3>
        <Button variant="outline" type="button" onClick={onClose}>Zavřít</Button>
      </div>
      <p className="fieldHint">Druh komponenty → Kategorie. Kategorie určuje interní typ karty, cenové zařazení a technickou kategorii služby. Kategorie se nemažou, jen deaktivují; kategorii použité kartami nelze změnit druh.</p>
      {!register.persisted && register.loaded && (
        <p className="fieldWarning">Zobrazen vestavěný seznam (jen pro čtení). Přidávání a úpravy budou dostupné po aplikaci migrace 20261023120000_catalog_categories. {register.error ?? ""}</p>
      )}
      {message && <p className="saveOk">{message}</p>}
      {COMPONENT_GROUPS.map((group) => (
        <div key={group} className="catalogCategoryGroup">
          <h4>
            {COMPONENT_GROUP_LABELS_CS[group]}
            {register.persisted && <Button variant="link" type="button" onClick={() => setDraft(newDraft(group))}>+ Nová kategorie</Button>}
          </h4>
          <ul className="sourceAssetList">
            {register.categories.filter((category) => category.group === group).map((category) => (
              <li key={category.id} className="sourceAssetListItem">
                <span className="sourceAssetKindBadge">{category.isActive ? "aktivní" : "neaktivní"}</span>
                <span>
                  <strong>{category.name}</strong> <small className="fieldHint">({category.id} · {category.kinds.map((kind) => CATALOG_ITEM_KIND_LABELS_CS[kind]).join(", ")}{category.priceCategory === "electricity" ? " · ceník elektřiny" : ""}{category.serviceCategory ? ` · technická kategorie ${category.serviceCategory}` : ""}{category.recommendedParameters?.length ? ` · doporučené parametry: ${category.recommendedParameters.filter((parameter) => parameter.isActive).map((parameter) => parameter.name).join(", ") || "jen neaktivní"}` : ""})</small>
                </span>
                {register.persisted && <Button variant="link" type="button" onClick={() => setDraft(toDraft(category))}>Upravit</Button>}
              </li>
            ))}
          </ul>
        </div>
      ))}
      {draft && (
        <div className="catalogCategoryEditor">
          <h4>{draft.isNew ? `Nová kategorie — ${COMPONENT_GROUP_LABELS_CS[draft.group]}` : `Upravit kategorii „${draft.name}“`}</h4>
          <div className="catalogCategoryForm">
            <label className="catalogCategoryField">
              <span>Název *</span>
              <Input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="např. Barové židle" />
            </label>
            <div className="catalogCategoryField">
              <span>Identifikátor</span>
              {draft.isNew ? <Input aria-label="Identifikátor" value={draft.id} onChange={(event) => setDraft({ ...draft, id: event.target.value })} placeholder="Nevyplněno = vytvoří se z názvu" /> : <span className="catalogCategoryReadOnly">{draft.id} <small>(stabilní, nelze měnit)</small></span>}
            </div>
            <label className="catalogCategoryField">
              <span>Druh komponenty</span>
              <NativeSelect value={draft.group} onChange={(event) => { const group = event.target.value as ComponentGroup; setDraft({ ...draft, group, kinds: [COMPONENT_GROUP_TARGETS[group].kinds[0]!], serviceCategory: "", priceCategory: "" }); }}>
                {COMPONENT_GROUPS.map((group) => <option key={group} value={group}>{COMPONENT_GROUP_LABELS_CS[group]}</option>)}
              </NativeSelect>
            </label>
            <label className="catalogCategoryField">
              <span>Pořadí</span>
              <Input type="number" value={draft.sortOrder} onChange={(event) => setDraft({ ...draft, sortOrder: event.target.value })} />
            </label>
            {technical && (
              <label className="catalogCategoryField">
                <span>Technická kategorie</span>
                <NativeSelect value={draft.serviceCategory} onChange={(event) => setDraft({ ...draft, serviceCategory: event.target.value })}>
                  <option value="">— žádná —</option>
                  {TECHNICAL_SERVICE_CATEGORIES.map((category) => <option key={category.id} value={category.id}>{category.labelCz}</option>)}
                </NativeSelect>
              </label>
            )}
            {draft.group === "technical_service" && (
              <label className="catalogCategoryField">
                <span>Prodejní ceník</span>
                <NativeSelect value={draft.priceCategory} onChange={(event) => setDraft({ ...draft, priceCategory: event.target.value as Draft["priceCategory"] })}>
                  <option value="">Základní prodejní ceník</option>
                  <option value="electricity">Ceník elektřiny</option>
                </NativeSelect>
              </label>
            )}
            <fieldset className="catalogCategoryField catalogCategoryFieldWide">
              <legend>Interní druhy <small>(první zaškrtnutý = výchozí)</small></legend>
              <div className="catalogCategoryChecks">
                {COMPONENT_GROUP_TARGETS[draft.group].kinds.map((kind) => (
                  <label key={kind} className="catalogCategoryCheck">
                    <input type="checkbox" checked={draft.kinds.includes(kind)} onChange={(event) => setDraft({ ...draft, kinds: event.target.checked ? [...draft.kinds, kind] : draft.kinds.filter((candidate) => candidate !== kind) })} />
                    {CATALOG_ITEM_KIND_LABELS_CS[kind]}
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="catalogCategoryField catalogCategoryFieldWide">
              <span>Popis</span>
              <Textarea rows={2} value={draft.description} onChange={(event) => setDraft({ ...draft, description: event.target.value })} placeholder="Volitelný" />
            </label>
            <div className="catalogCategoryField catalogCategoryFieldWide">
              <span>Stav</span>
              <label className="catalogCategoryCheck"><input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} /> Aktivní — nabízet u nových zařazení</label>
            </div>
          </div>
          <section className="catalogCategoryParameters">
            <h5>Doporučené parametry</h5>
            {!register.parametersMigrated && <p className="fieldWarning">Doporučené parametry budou upravitelné po aplikaci migrace 20261023130000_catalog_category_parameters.</p>}
            <p className="catalogCategoryHint">Nepovinná pole nabízená na kartách této kategorie. Rozměry, barva, materiál a výkon jsou systémové parametry a sem nepatří. Uložený parametr se nemaže — deaktivujte ho; hodnoty na kartách zůstanou. Odebrat lze jen parametr, který ještě nebyl uložen.</p>
            {draft.recommended.length > 0 && (
              <div className="catalogParameterTable" role="table" aria-label="Doporučené parametry">
                <div className="catalogParameterRow catalogParameterHead" role="row">
                  <span role="columnheader">Název parametru</span>
                  <span role="columnheader">Typ hodnoty</span>
                  <span role="columnheader">Jednotka</span>
                  <span role="columnheader">Pořadí</span>
                  <span role="columnheader">Stav</span>
                </div>
                {draft.recommended.map((parameter, index) => {
                  const update = (patch: Partial<ParameterDraft>) => setDraft({ ...draft, recommended: draft.recommended.map((candidate, candidateIndex) => (candidateIndex === index ? { ...candidate, ...patch } : candidate)) });
                  const missingName = !parameter.isNew && !parameter.name.trim();
                  return (
                    <div key={parameter.rowKey} className={`catalogParameterRow${parameter.isActive ? "" : " isInactive"}${parameter.isNew ? " isUnsaved" : ""}`} role="row">
                      <label className="catalogParameterCell catalogParameterNameCell">
                        <span className="catalogParameterCellLabel">Název parametru{parameter.isNew && <em className="catalogParameterUnsavedBadge">nový, neuložený</em>}</span>
                        <Input aria-label="Název parametru" aria-invalid={missingName || undefined} value={parameter.name} disabled={!register.parametersMigrated} onChange={(event) => update({ name: event.target.value })} placeholder="např. Rychlost připojení" />
                        {missingName && <small className="catalogParameterError">Uložený parametr musí mít název. Pokud ho už nechcete nabízet, deaktivujte ho.</small>}
                      </label>
                      <label className="catalogParameterCell">
                        <span className="catalogParameterCellLabel">Typ hodnoty</span>
                        <NativeSelect aria-label="Typ hodnoty" value={parameter.valueType} disabled={!register.parametersMigrated} onChange={(event) => update({ valueType: event.target.value as ParameterValueType })}>
                          <option value="text">Text</option>
                          <option value="number">Číslo</option>
                        </NativeSelect>
                      </label>
                      <label className="catalogParameterCell">
                        <span className="catalogParameterCellLabel">Jednotka</span>
                        <Input aria-label="Jednotka" value={parameter.unit} disabled={!register.parametersMigrated} onChange={(event) => update({ unit: event.target.value })} placeholder="např. Mb/s" />
                      </label>
                      <label className="catalogParameterCell">
                        <span className="catalogParameterCellLabel">Pořadí</span>
                        <Input aria-label="Pořadí" type="number" value={parameter.sortOrder} disabled={!register.parametersMigrated} onChange={(event) => update({ sortOrder: event.target.value })} />
                      </label>
                      <div className="catalogParameterCell catalogParameterStateCell">
                        <span className="catalogParameterCellLabel">Stav</span>
                        <label className="catalogCategoryCheck"><input type="checkbox" checked={parameter.isActive} disabled={!register.parametersMigrated} onChange={(event) => update({ isActive: event.target.checked })} /> <span>aktivní</span></label>
                        {parameter.isNew && <Button variant="destructive" type="button" onClick={() => setDraft({ ...draft, recommended: draft.recommended.filter((_, candidateIndex) => candidateIndex !== index) })} title="Odebrat tento dosud neuložený parametr">Odebrat</Button>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
            {draft.recommended.some((parameter) => parameter.isNew) && <p className="catalogCategoryHint catalogParameterLegend"><span className="catalogParameterLegendMark" aria-hidden="true" /> Žlutě označené parametry jsou nové — uloží se až tlačítkem Uložit kategorii, do té doby je lze odebrat.</p>}
            {register.parametersMigrated && <Button variant="outline" type="button" onClick={() => setDraft({ ...draft, recommended: [...draft.recommended, { rowKey: nextRowKey(), id: "", name: "", valueType: "text", unit: "", sortOrder: String((draft.recommended.length + 1) * 10), isActive: true, isNew: true }] })}>+ Přidat doporučený parametr</Button>}
          </section>
          <div className="catalogCategoryActions">
            <Button variant="default" type="button" disabled={busy || !draft.name.trim() || draft.kinds.length === 0 || draft.recommended.some((parameter) => !parameter.isNew && !parameter.name.trim())} onClick={() => void save()}>{busy ? "Ukládám…" : "Uložit kategorii"}</Button>
            <Button variant="outline" type="button" onClick={() => setDraft(undefined)}>Zrušit</Button>
          </div>
        </div>
      )}
      {error && <p className="uploadError">{error}</p>}
    </div>
  );
}
