"use client";

import { useMemo, useState } from "react";
import { itemTypeOf, type CatalogItemAdmin } from "../../domain/catalogItemsAdmin";
import { CATALOG_ITEM_TYPE_LABELS_CS } from "../../domain/catalogItemTypes";
import {
  isKitOwnerType,
  KIT_SUBSTITUTE_RULE_LABELS_CS,
  KIT_SUBSTITUTE_RULES,
  type CatalogPackageItem,
  type CatalogPackageItemInput,
  type KitLineKind,
  type KitSubstituteRule,
} from "../../domain/catalogPackages";
import { KIT_ALLOWANCE_UNIT_LABELS_CS, KIT_ALLOWANCE_UNITS, type KitAllowanceUnit } from "../../domain/catalogKitPrintAllowance";
import { PRINT_SURFACE_TYPES, type PrintSurfaceTypeId } from "../../domain/printSurfaceTypeCatalog";
import { CATALOG_UNITS } from "../../domain/catalogUnits";
import {
  activeVariants,
  VARIANT_SET_KIND_LABELS_CS,
  VARIANT_SET_KINDS,
  VARIANT_SURCHARGE_RULE_LABELS_CS,
  VARIANT_SURCHARGE_RULES,
  type CatalogVariantSet,
  type CatalogVariantSetInput,
  type VariantSetKind,
  type VariantSurchargeRule,
} from "../../domain/catalogVariants";
import { carpetFinishVariants } from "../../domain/finishes";

function itemOptionLabel(item: CatalogItemAdmin): string {
  const code = item.abfCode ?? item.internalCode;
  return `${code ? `${code} · ` : ""}${item.displayName} (${CATALOG_ITEM_TYPE_LABELS_CS[itemTypeOf(item)]}${item.lifecycleStatus === "archived" ? ", archivováno" : ""})`;
}

let draftCounter = 0;
const draftKey = (prefix: string) => `${prefix}-${Date.now()}-${(draftCounter += 1)}`;

function parseDecimal(raw: string): number {
  return Number(raw.replace(",", ".").trim());
}

// ============================================================================
// OBSAH KOMPLETU — BOOTH and KIT (V1-DATA-04)
// ============================================================================

type DraftSubstitute = Readonly<{ key: string; substituteItemId: string; substituteVariantId: string; surchargeRule: KitSubstituteRule; surchargeUnitCode: string; quantityFactor: string; note: string }>;
type DraftAllowance = Readonly<{ key: string; surfaceTypeId: PrintSurfaceTypeId | ""; printSurfaceIds: string; unitCode: KitAllowanceUnit; includedQuantity: string }>;
type DraftLine = Readonly<{
  key: string;
  lineKey?: string;
  lineKind: KitLineKind;
  childItemId: string;
  label: string;
  labelEn: string;
  quantity: string;
  unitCode: string;
  includedInPackage: boolean;
  note: string;
  variantSetId: string;
  defaultVariantId: string;
  allowSubstitutes: boolean;
  substitutes: readonly DraftSubstitute[];
  allowances: readonly DraftAllowance[];
}>;

function toDraft(item: CatalogItemAdmin): readonly DraftLine[] {
  return (item.packageItems ?? []).map((line) => ({
    key: line.id,
    lineKey: line.lineKey,
    lineKind: line.lineKind,
    childItemId: line.childItemId ?? "",
    label: line.label ?? "",
    labelEn: line.labelEn ?? "",
    quantity: String(line.quantity),
    unitCode: line.unitCode ?? "",
    includedInPackage: line.includedInPackage,
    note: line.note ?? "",
    variantSetId: line.variantSetId ?? "",
    defaultVariantId: line.defaultVariantId ?? "",
    allowSubstitutes: Boolean(line.substitutes?.length),
    substitutes: (line.substitutes ?? []).map((substitute) => ({
      key: substitute.id ?? draftKey("sub"),
      substituteItemId: substitute.substituteItemId,
      substituteVariantId: substitute.substituteVariantId ?? "",
      surchargeRule: substitute.surchargeRule,
      surchargeUnitCode: substitute.surchargeUnitCode ?? "",
      quantityFactor: String(substitute.quantityFactor),
      note: substitute.note ?? "",
    })),
    allowances: (line.printAllowance ?? []).map((allowance) => ({
      key: draftKey("gr"),
      surfaceTypeId: allowance.surfaceTypeId ?? "",
      printSurfaceIds: (allowance.printSurfaceIds ?? []).join(", "),
      unitCode: allowance.unitCode,
      includedQuantity: String(allowance.includedQuantity),
    })),
  }));
}

function toPayload(lines: readonly DraftLine[]): CatalogPackageItemInput[] {
  return lines
    .filter((line) => (line.lineKind === "text" ? line.label.trim() : line.childItemId))
    .map((line): CatalogPackageItemInput => {
      const text = line.lineKind === "text";
      const substitutes = !text && line.allowSubstitutes
        ? line.substitutes.filter((substitute) => substitute.substituteItemId).map((substitute) => ({
            substituteItemId: substitute.substituteItemId,
            ...(substitute.substituteVariantId ? { substituteVariantId: substitute.substituteVariantId } : {}),
            surchargeRule: substitute.surchargeRule,
            ...(substitute.surchargeRule === "per_unit" && substitute.surchargeUnitCode ? { surchargeUnitCode: substitute.surchargeUnitCode } : {}),
            quantityFactor: substitute.quantityFactor.trim() ? parseDecimal(substitute.quantityFactor) : 1,
            ...(substitute.note.trim() ? { note: substitute.note.trim() } : {}),
          }))
        : [];
      const printAllowance = text
        ? []
        : line.allowances.map((allowance) => {
            const ids = allowance.printSurfaceIds.split(",").map((id) => id.trim()).filter(Boolean);
            return {
              ...(allowance.surfaceTypeId ? { surfaceTypeId: allowance.surfaceTypeId } : {}),
              ...(ids.length ? { printSurfaceIds: ids } : {}),
              unitCode: allowance.unitCode,
              includedQuantity: parseDecimal(allowance.includedQuantity),
            };
          });
      return {
        ...(line.lineKey ? { lineKey: line.lineKey } : {}),
        lineKind: line.lineKind,
        ...(text ? {} : { childItemId: line.childItemId }),
        ...(text && line.label.trim() ? { label: line.label.trim() } : {}),
        ...(text && line.labelEn.trim() ? { labelEn: line.labelEn.trim() } : {}),
        quantity: parseDecimal(line.quantity),
        ...(line.unitCode ? { unitCode: line.unitCode } : {}),
        includedInPackage: text ? true : line.includedInPackage,
        ...(line.note.trim() ? { note: line.note.trim() } : {}),
        ...(!text && line.variantSetId ? { variantSetId: line.variantSetId } : {}),
        ...(!text && line.variantSetId && line.defaultVariantId ? { defaultVariantId: line.defaultVariantId } : {}),
        ...(printAllowance.length ? { printAllowance } : {}),
        ...(substitutes.length ? { substitutes } : {}),
      };
    });
}

function newLine(lineKind: KitLineKind): DraftLine {
  return {
    key: draftKey("line"),
    lineKind,
    childItemId: "",
    label: "",
    labelEn: "",
    quantity: "1",
    unitCode: "",
    includedInPackage: true,
    note: "",
    variantSetId: "",
    defaultVariantId: "",
    allowSubstitutes: false,
    substitutes: [],
    allowances: [],
  };
}

export function KitContentsSection({
  item,
  allItems,
  variantSets,
  onSavePackage,
}: {
  item: CatalogItemAdmin;
  allItems: readonly CatalogItemAdmin[];
  variantSets: readonly CatalogVariantSet[];
  onSavePackage: (lines: readonly CatalogPackageItemInput[]) => Promise<Readonly<{ packageItems: readonly CatalogPackageItem[]; warnings: readonly string[] }>>;
}) {
  const [lines, setLines] = useState<readonly DraftLine[]>(() => toDraft(item));
  // What is stored right now — refreshed after every save, so the next save sends the stored line keys.
  const [storedItem, setStoredItem] = useState<CatalogItemAdmin>(item);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [savedHint, setSavedHint] = useState("");
  const [warnings, setWarnings] = useState<readonly string[]>([]);

  const byId = useMemo(() => new Map(allItems.map((candidate) => [candidate.id, candidate])), [allItems]);
  // A14: a kit never contains another BOOTH/KIT. New lines pick only non-archived cards; an existing
  // line keeps showing its (possibly archived) component — archival never breaks a kit.
  const pickable = useMemo(
    () =>
      allItems
        .filter((candidate) => candidate.id !== item.id && candidate.lifecycleStatus !== "archived" && !isKitOwnerType(itemTypeOf(candidate)))
        .slice()
        .sort((a, b) => itemOptionLabel(a).localeCompare(itemOptionLabel(b), "cs", { numeric: true })),
    [allItems, item.id],
  );
  const allVariantOptions = useMemo(
    () => variantSets.flatMap((set) => activeVariants(set).map((variant) => ({ id: variant.id, label: `${set.name}: ${variant.name}` }))),
    [variantSets],
  );
  const initialPayload = useMemo(() => JSON.stringify(toPayload(toDraft(storedItem))), [storedItem]);
  const dirty = JSON.stringify(toPayload(lines)) !== initialPayload;

  function update(key: string, patch: Partial<DraftLine>) {
    setLines((current) => current.map((line) => (line.key === key ? { ...line, ...patch } : line)));
    setSavedHint("");
  }

  function move(key: string, direction: -1 | 1) {
    setLines((current) => {
      const index = current.findIndex((line) => line.key === key);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= current.length) return current;
      const next = current.slice();
      [next[index], next[target]] = [next[target]!, next[index]!];
      return next;
    });
    setSavedHint("");
  }

  function toggleExpanded(key: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function addLine(lineKind: KitLineKind) {
    const line = newLine(lineKind);
    setLines((current) => [...current, line]);
    if (lineKind === "text") setExpanded((current) => new Set(current).add(line.key));
  }

  function optionsFor(line: DraftLine, selectedId: string) {
    const selectedItem = selectedId ? byId.get(selectedId) : undefined;
    const keepSelected = selectedItem && !pickable.some((candidate) => candidate.id === selectedItem.id);
    return (
      <>
        {keepSelected && <option value={selectedItem.id}>{itemOptionLabel(selectedItem)}</option>}
        {pickable.filter((candidate) => candidate.id !== line.childItemId || selectedId === line.childItemId).map((candidate) => (
          <option key={candidate.id} value={candidate.id}>{itemOptionLabel(candidate)}</option>
        ))}
      </>
    );
  }

  async function handleSave() {
    setBusy(true);
    setError("");
    setWarnings([]);
    try {
      const result = await onSavePackage(toPayload(lines));
      const saved = { ...storedItem, packageItems: result.packageItems };
      setStoredItem(saved);
      setLines(toDraft(saved));
      setWarnings(result.warnings);
      setSavedHint("Obsah kompletu uložen.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Uložení obsahu selhalo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="catalogDetailSection catalogPackageSection kitContentsSection" aria-label="Obsah kompletu">
      <h3>Obsah kompletu</h3>
      <p className="fieldHint">
        Položky „Zahrnuto v ceně“ jsou součástí ceny kompletu a zákazníkovi se znovu nepřičítají. Povolená náhrada komponentu nahradí (nepřidá další) a doplatek se spočítá podle zvoleného pravidla z ceníku; dokud ceníky nejsou, editor funguje i bez cen.
      </p>
      {lines.length === 0 && <p className="workspaceEmpty">Komplet zatím neobsahuje žádné položky.</p>}
      {lines.map((line, index) => {
        const text = line.lineKind === "text";
        const isOpen = expanded.has(line.key);
        const set = variantSets.find((candidate) => candidate.id === line.variantSetId);
        return (
          <div key={line.key} className={`kitLine ${text ? "kitLineText" : ""}`} data-line-key={line.lineKey ?? ""}>
            <div className="kitLineMain">
              <div className="kitLineOrder">
                <button type="button" aria-label="Posunout nahoru" title="Posunout nahoru" disabled={index === 0} onClick={() => move(line.key, -1)}>▲</button>
                <button type="button" aria-label="Posunout dolů" title="Posunout dolů" disabled={index === lines.length - 1} onClick={() => move(line.key, 1)}>▼</button>
              </div>
              <span className="kitLineBadge">{text ? "Text" : "Komponenta"}</span>
              {text ? (
                <input aria-label="Název textové položky" placeholder="Název (např. Stavba stánku)" value={line.label} onChange={(event) => update(line.key, { label: event.target.value })} />
              ) : (
                <select aria-label="Komponenta" value={line.childItemId} onChange={(event) => update(line.key, { childItemId: event.target.value })}>
                  <option value="">— vyberte komponentu —</option>
                  {optionsFor(line, line.childItemId)}
                </select>
              )}
              <input aria-label="Množství" className="kitLineQuantity" inputMode="decimal" value={line.quantity} onChange={(event) => update(line.key, { quantity: event.target.value })} />
              <select aria-label="Jednotka" value={line.unitCode} onChange={(event) => update(line.key, { unitCode: event.target.value })}>
                <option value="">jednotka</option>
                {CATALOG_UNITS.map((unit) => <option key={unit.code} value={unit.code}>{unit.symbol}</option>)}
              </select>
              <label className="checkboxRow" title={text ? "Textová položka je vždy v ceně kompletu" : undefined}>
                <input type="checkbox" checked={text ? true : line.includedInPackage} disabled={text} onChange={(event) => update(line.key, { includedInPackage: event.target.checked })} />
                Zahrnuto v ceně
              </label>
              <button type="button" className="linkButton" aria-expanded={isOpen} onClick={() => toggleExpanded(line.key)}>{isOpen ? "Méně" : "Více"}</button>
              <button type="button" className="dangerText" onClick={() => setLines((current) => current.filter((candidate) => candidate.key !== line.key))}>Odebrat</button>
            </div>
            {!isOpen && (line.allowSubstitutes || line.variantSetId || line.allowances.length > 0 || line.note) && (
              <small className="kitLineSummary">
                {[
                  line.allowSubstitutes && line.substitutes.length ? `${line.substitutes.length}× náhrada` : undefined,
                  set ? `vzorník ${set.name}` : undefined,
                  line.allowances.length ? `${line.allowances.length}× zahrnutá grafika` : undefined,
                  line.note ? `pozn.: ${line.note}` : undefined,
                ].filter(Boolean).join(" · ")}
              </small>
            )}
            {isOpen && (
              <div className="kitLineDetail">
                <label>
                  <span>Poznámka</span>
                  <input value={line.note} onChange={(event) => update(line.key, { note: event.target.value })} placeholder="Nepovinná poznámka" />
                </label>
                <label>
                  <span>Klíč řádku</span>
                  <input value={line.lineKey ?? ""} readOnly placeholder="Přidělí se při uložení" title="Stabilní identifikátor řádku — po uložení se nemění" />
                </label>
                {text && (
                  <label>
                    <span>Anglický název</span>
                    <input value={line.labelEn} onChange={(event) => update(line.key, { labelEn: event.target.value })} placeholder="Nepovinné" />
                  </label>
                )}
                {!text && (
                  <>
                    <div className="kitLineGroup">
                      <label>
                        <span>Vzorník (barevné varianty)</span>
                        <select value={line.variantSetId} onChange={(event) => update(line.key, { variantSetId: event.target.value, defaultVariantId: "" })}>
                          <option value="">— bez variant —</option>
                          {variantSets.filter((candidate) => candidate.isActive || candidate.id === line.variantSetId).map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name} ({candidate.code})</option>)}
                        </select>
                      </label>
                      {set && (
                        <label>
                          <span>Výchozí varianta</span>
                          <select value={line.defaultVariantId} onChange={(event) => update(line.key, { defaultVariantId: event.target.value })}>
                            <option value="">— nevybráno —</option>
                            {set.variants.filter((variant) => variant.isActive || variant.id === line.defaultVariantId).map((variant) => <option key={variant.id} value={variant.id}>{variant.name} ({variant.code})</option>)}
                          </select>
                        </label>
                      )}
                      {variantSets.length === 0 && <small className="fieldHint">Zatím není založený žádný vzorník (tlačítko „Vzorníky“ nahoře).</small>}
                    </div>

                    <div className="kitLineGroup">
                      <label className="checkboxRow">
                        <input type="checkbox" checked={line.allowSubstitutes} onChange={(event) => update(line.key, { allowSubstitutes: event.target.checked })} />
                        Povolit náhradu
                      </label>
                      {line.allowSubstitutes && (
                        <>
                          {line.substitutes.length === 0 && <small className="fieldHint">Vyberte povolené alternativy, např. elektřinu 3 kW a 5 kW místo 2 kW.</small>}
                          {line.substitutes.map((substitute) => {
                            const patchSubstitute = (patch: Partial<DraftSubstitute>) =>
                              update(line.key, { substitutes: line.substitutes.map((candidate) => (candidate.key === substitute.key ? { ...candidate, ...patch } : candidate)) });
                            return (
                              <div key={substitute.key} className="kitSubstituteRow">
                                <select aria-label="Náhradní komponenta" value={substitute.substituteItemId} onChange={(event) => patchSubstitute({ substituteItemId: event.target.value })}>
                                  <option value="">— alternativa —</option>
                                  {optionsFor(line, substitute.substituteItemId)}
                                </select>
                                {allVariantOptions.length > 0 && (
                                  <select aria-label="Varianta náhrady" value={substitute.substituteVariantId} onChange={(event) => patchSubstitute({ substituteVariantId: event.target.value })}>
                                    <option value="">bez varianty</option>
                                    {allVariantOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
                                  </select>
                                )}
                                <select aria-label="Pravidlo doplatku" value={substitute.surchargeRule} onChange={(event) => patchSubstitute({ surchargeRule: event.target.value as KitSubstituteRule })}>
                                  {KIT_SUBSTITUTE_RULES.map((rule) => <option key={rule} value={rule}>{KIT_SUBSTITUTE_RULE_LABELS_CS[rule]}</option>)}
                                </select>
                                {substitute.surchargeRule === "per_unit" && (
                                  <select aria-label="Jednotka doplatku" value={substitute.surchargeUnitCode} onChange={(event) => patchSubstitute({ surchargeUnitCode: event.target.value })}>
                                    <option value="">jednotka</option>
                                    {CATALOG_UNITS.map((unit) => <option key={unit.code} value={unit.code}>{unit.symbol}</option>)}
                                  </select>
                                )}
                                <button type="button" className="dangerText" onClick={() => update(line.key, { substitutes: line.substitutes.filter((candidate) => candidate.key !== substitute.key) })}>Odebrat</button>
                              </div>
                            );
                          })}
                          <button
                            type="button"
                            className="secondaryButton"
                            onClick={() => update(line.key, { substitutes: [...line.substitutes, { key: draftKey("sub"), substituteItemId: "", substituteVariantId: "", surchargeRule: "price_difference", surchargeUnitCode: "", quantityFactor: "1", note: "" }] })}
                          >
                            + Přidat alternativu
                          </button>
                        </>
                      )}
                    </div>

                    <div className="kitLineGroup">
                      <span className="kitLineGroupTitle">Zahrnutá grafika</span>
                      {line.allowances.map((allowance) => {
                        const patchAllowance = (patch: Partial<DraftAllowance>) =>
                          update(line.key, { allowances: line.allowances.map((candidate) => (candidate.key === allowance.key ? { ...candidate, ...patch } : candidate)) });
                        return (
                          <div key={allowance.key} className="kitSubstituteRow">
                            <select aria-label="Typ tiskové plochy" value={allowance.surfaceTypeId} onChange={(event) => patchAllowance({ surfaceTypeId: event.target.value as PrintSurfaceTypeId | "", unitCode: event.target.value === "fascia" ? "bm" : allowance.unitCode })}>
                              <option value="">— typ plochy —</option>
                              {PRINT_SURFACE_TYPES.map((type) => <option key={type.id} value={type.id}>{type.labelCz}</option>)}
                            </select>
                            <input aria-label="Zahrnuté množství" className="kitLineQuantity" inputMode="decimal" value={allowance.includedQuantity} onChange={(event) => patchAllowance({ includedQuantity: event.target.value })} />
                            <select aria-label="Jednotka grafiky" value={allowance.unitCode} onChange={(event) => patchAllowance({ unitCode: event.target.value as KitAllowanceUnit })}>
                              {KIT_ALLOWANCE_UNITS.map((unit) => <option key={unit} value={unit}>{KIT_ALLOWANCE_UNIT_LABELS_CS[unit]}</option>)}
                            </select>
                            <input aria-label="Konkrétní plochy" placeholder="ID ploch (nepovinné, např. fascia-print)" value={allowance.printSurfaceIds} onChange={(event) => patchAllowance({ printSurfaceIds: event.target.value })} />
                            <button type="button" className="dangerText" onClick={() => update(line.key, { allowances: line.allowances.filter((candidate) => candidate.key !== allowance.key) })}>Odebrat</button>
                          </div>
                        );
                      })}
                      <button
                        type="button"
                        className="secondaryButton"
                        onClick={() => update(line.key, { allowances: [...line.allowances, { key: draftKey("gr"), surfaceTypeId: "fascia", printSurfaceIds: "", unitCode: "bm", includedQuantity: "" }] })}
                      >
                        + Přidat rozsah grafiky
                      </button>
                      <small className="fieldHint">Účtuje se jen přesah nad zahrnuté množství. Různé typy ploch a jednotky se nikdy neodečítají.</small>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        );
      })}
      <div className="assetActions">
        <button type="button" className="secondaryButton" onClick={() => addLine("item")}>+ Přidat položku</button>
        <button type="button" className="secondaryButton" onClick={() => addLine("text")}>+ Textová položka</button>
        <button type="button" className="primaryButton" onClick={() => void handleSave()} disabled={!dirty || busy}>
          {busy ? "Ukládám…" : "Uložit obsah"}
        </button>
      </div>
      {savedHint && <small className="fieldHint">{savedHint}</small>}
      {warnings.map((warning) => <small key={warning} className="fieldHint kitWarning">{warning}</small>)}
      {error && <small className="uploadError kitError">{error}</small>}
    </section>
  );
}


// ============================================================================
// VZORNÍKY — swatch books and their variants (V1-DATA-04)
// ============================================================================

type DraftVariant = Readonly<{
  key: string;
  id?: string;
  code: string;
  name: string;
  nameEn: string;
  swatchColor: string;
  priceItemId: string;
  surchargeRule: VariantSurchargeRule;
  surchargeUnitCode: string;
  legacyFinishId: string;
  isActive: boolean;
}>;

type DraftSet = Readonly<{ id?: string; code: string; name: string; kind: VariantSetKind; isActive: boolean; note: string; variants: readonly DraftVariant[] }>;

function setToDraft(set: CatalogVariantSet | undefined): DraftSet {
  if (!set) return { code: "", name: "", kind: "carpet", isActive: true, note: "", variants: [] };
  return {
    id: set.id,
    code: set.code,
    name: set.name,
    kind: set.kind,
    isActive: set.isActive,
    note: set.note ?? "",
    variants: set.variants.map((variant) => ({
      key: variant.id,
      id: variant.id,
      code: variant.code,
      name: variant.name,
      nameEn: variant.nameEn ?? "",
      swatchColor: variant.swatchColor ?? "",
      priceItemId: variant.priceItemId ?? "",
      surchargeRule: variant.surchargeRule,
      surchargeUnitCode: variant.surchargeUnitCode ?? "",
      legacyFinishId: variant.legacyFinishId ?? "",
      isActive: variant.isActive,
    })),
  };
}

function draftToInput(draft: DraftSet): CatalogVariantSetInput {
  return {
    ...(draft.id ? { id: draft.id } : {}),
    code: draft.code,
    name: draft.name,
    kind: draft.kind,
    isActive: draft.isActive,
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
    variants: draft.variants.map((variant) => ({
      ...(variant.id ? { id: variant.id } : {}),
      code: variant.code,
      name: variant.name,
      ...(variant.nameEn.trim() ? { nameEn: variant.nameEn.trim() } : {}),
      ...(variant.swatchColor ? { swatchColor: variant.swatchColor } : {}),
      ...(variant.priceItemId ? { priceItemId: variant.priceItemId } : {}),
      surchargeRule: variant.surchargeRule,
      ...(variant.surchargeRule === "per_unit" && variant.surchargeUnitCode ? { surchargeUnitCode: variant.surchargeUnitCode } : {}),
      ...(variant.legacyFinishId ? { legacyFinishId: variant.legacyFinishId } : {}),
      isActive: variant.isActive,
    })),
  };
}

const LEGACY_CARPET_FINISHES = carpetFinishVariants.filter((finish) => finish.id !== "none" && finish.materialRole === "CARPET" && finish.swatchColor);

export function VariantSetsPanel({
  variantSets,
  allItems,
  onSave,
  onClose,
}: {
  variantSets: readonly CatalogVariantSet[];
  allItems: readonly CatalogItemAdmin[];
  onSave: (input: CatalogVariantSetInput) => Promise<CatalogVariantSet>;
  onClose: () => void;
}) {
  const [selectedId, setSelectedId] = useState<string | "new" | undefined>(variantSets[0]?.id);
  const selected = selectedId && selectedId !== "new" ? variantSets.find((set) => set.id === selectedId) : undefined;
  const [draft, setDraft] = useState<DraftSet>(() => setToDraft(selected));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [hint, setHint] = useState("");

  const priceItems = useMemo(
    () => allItems.filter((item) => item.lifecycleStatus !== "archived" || draft.variants.some((variant) => variant.priceItemId === item.id)).slice().sort((a, b) => itemOptionLabel(a).localeCompare(itemOptionLabel(b), "cs", { numeric: true })),
    [allItems, draft.variants],
  );

  function select(id: string | "new") {
    setSelectedId(id);
    setDraft(setToDraft(id === "new" ? undefined : variantSets.find((set) => set.id === id)));
    setError("");
    setHint("");
  }

  function patchVariant(key: string, patch: Partial<DraftVariant>) {
    setDraft((current) => ({ ...current, variants: current.variants.map((variant) => (variant.key === key ? { ...variant, ...patch } : variant)) }));
  }

  function addVariant(seed: Partial<DraftVariant> = {}) {
    setDraft((current) => ({
      ...current,
      variants: [...current.variants, { key: draftKey("var"), code: "", name: "", nameEn: "", swatchColor: "", priceItemId: "", surchargeRule: "none", surchargeUnitCode: "", legacyFinishId: "", isActive: true, ...seed }],
    }));
  }

  /** Draft only — the admin reviews codes and links and saves explicitly. */
  function prefillFromLegacyCarpets() {
    const present = new Set(draft.variants.map((variant) => variant.legacyFinishId));
    for (const finish of LEGACY_CARPET_FINISHES) {
      if (present.has(finish.id)) continue;
      addVariant({ code: finish.code, name: finish.name, swatchColor: finish.swatchColor ?? "", legacyFinishId: finish.id });
    }
  }

  async function handleSave() {
    setBusy(true);
    setError("");
    setHint("");
    try {
      const saved = await onSave(draftToInput(draft));
      setSelectedId(saved.id);
      setDraft(setToDraft(saved));
      setHint("Vzorník uložen.");
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Uložení vzorníku selhalo.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="catalogDetailSection variantSetsPanel" aria-label="Vzorníky">
      <div className="variantSetsHeader">
        <h3>Vzorníky (barevné varianty)</h3>
        <button type="button" className="linkButton" onClick={onClose}>Zavřít</button>
      </div>
      <div className="variantSetsTabs">
        {variantSets.map((set) => (
          <button key={set.id} type="button" className={selectedId === set.id ? "primaryButton" : "secondaryButton"} onClick={() => select(set.id)}>
            {set.name}{set.isActive ? "" : " (neaktivní)"}
          </button>
        ))}
        <button type="button" className={selectedId === "new" ? "primaryButton" : "secondaryButton"} onClick={() => select("new")}>+ Nový vzorník</button>
      </div>
      {(selectedId === "new" || selected) && (
        <>
          <div className="variantSetFields">
            <label><span>Kód</span><input value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value })} placeholder="KOBERCE-2026" /></label>
            <label><span>Název</span><input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="Koberce 2026" /></label>
            <label>
              <span>Druh</span>
              <select value={draft.kind} onChange={(event) => setDraft({ ...draft, kind: event.target.value as VariantSetKind })}>
                {VARIANT_SET_KINDS.map((kind) => <option key={kind} value={kind}>{VARIANT_SET_KIND_LABELS_CS[kind]}</option>)}
              </select>
            </label>
            <label className="checkboxRow"><input type="checkbox" checked={draft.isActive} onChange={(event) => setDraft({ ...draft, isActive: event.target.checked })} />Aktivní</label>
          </div>
          <table className="catalogAliasTable variantTable">
            <thead>
              <tr><th>Interní kód</th><th>Název barvy</th><th>Náhled</th><th>Účtuje se jako</th><th>Příplatek</th><th>Starší ID</th><th>Aktivní</th></tr>
            </thead>
            <tbody>
              {draft.variants.map((variant) => (
                <tr key={variant.key}>
                  <td><input aria-label="Interní kód barvy" value={variant.code} onChange={(event) => patchVariant(variant.key, { code: event.target.value })} placeholder="SEDA" /></td>
                  <td><input aria-label="Název barvy" value={variant.name} onChange={(event) => patchVariant(variant.key, { name: event.target.value })} placeholder="Šedá" /></td>
                  <td>
                    <input aria-label="Barva náhledu" type="color" value={variant.swatchColor || "#cccccc"} onChange={(event) => patchVariant(variant.key, { swatchColor: event.target.value })} />
                  </td>
                  <td>
                    <select aria-label="Katalogová položka" value={variant.priceItemId} onChange={(event) => patchVariant(variant.key, { priceItemId: event.target.value })}>
                      <option value="">— karta / ABF kód —</option>
                      {priceItems.map((item) => <option key={item.id} value={item.id}>{itemOptionLabel(item)}</option>)}
                    </select>
                  </td>
                  <td>
                    <select aria-label="Pravidlo příplatku" value={variant.surchargeRule} onChange={(event) => patchVariant(variant.key, { surchargeRule: event.target.value as VariantSurchargeRule })}>
                      {VARIANT_SURCHARGE_RULES.map((rule) => <option key={rule} value={rule}>{VARIANT_SURCHARGE_RULE_LABELS_CS[rule]}</option>)}
                    </select>
                    {variant.surchargeRule === "per_unit" && (
                      <select aria-label="Jednotka příplatku" value={variant.surchargeUnitCode} onChange={(event) => patchVariant(variant.key, { surchargeUnitCode: event.target.value })}>
                        <option value="">jednotka</option>
                        {CATALOG_UNITS.map((unit) => <option key={unit.code} value={unit.code}>{unit.symbol}</option>)}
                      </select>
                    )}
                  </td>
                  <td><input aria-label="Starší ID barvy" value={variant.legacyFinishId} onChange={(event) => patchVariant(variant.key, { legacyFinishId: event.target.value })} placeholder="carpet-grey" list="legacy-carpet-finishes" /></td>
                  <td><input aria-label="Aktivní" type="checkbox" checked={variant.isActive} onChange={(event) => patchVariant(variant.key, { isActive: event.target.checked })} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          <datalist id="legacy-carpet-finishes">
            {LEGACY_CARPET_FINISHES.map((finish) => <option key={finish.id} value={finish.id}>{finish.name}</option>)}
          </datalist>
          <p className="fieldHint">Varianty se nemažou, jen deaktivují — starší projekty a komplety na ně mohou odkazovat. Částky příplatků se doplní v ceníku (V1-DATA-05).</p>
          <div className="assetActions">
            <button type="button" className="secondaryButton" onClick={() => addVariant()}>+ Přidat barvu</button>
            {draft.kind === "carpet" && <button type="button" className="secondaryButton" onClick={prefillFromLegacyCarpets}>Předvyplnit dnešní barvy koberců</button>}
            <button type="button" className="primaryButton" onClick={() => void handleSave()} disabled={busy}>{busy ? "Ukládám…" : "Uložit vzorník"}</button>
          </div>
          {hint && <small className="fieldHint">{hint}</small>}
          {error && <small className="uploadError kitError">{error}</small>}
        </>
      )}
    </section>
  );
}
