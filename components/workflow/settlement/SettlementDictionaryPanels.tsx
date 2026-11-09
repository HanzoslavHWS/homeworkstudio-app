"use client";

import { useEffect, useMemo, useState } from "react";
import {
  CATALOG_NAME_TYPE_LABELS_CS,
  CATALOG_NAME_TYPES,
  normalizeSettlementText,
  SETTLEMENT_MAPPING_STATUS_LABELS_CS,
  SETTLEMENT_MAPPING_STATUSES,
  type CatalogNameType,
  type SettlementCatalogItem,
  type SettlementCheck,
  type SettlementMappingStatus,
  type SettlementVendorMapping,
} from "../../../domain/settlementCheck";
import {
  SETTLEMENT_EVALUATED_RULE_TYPES,
  SETTLEMENT_RULE_STATUS_LABELS_CS,
  SETTLEMENT_RULE_TYPE_LABELS_CS,
  SETTLEMENT_RULE_TYPES,
  type SettlementRule,
  type SettlementRuleType,
} from "../../../domain/settlementRules";
import type { RemoteApiSettlementClient, SettlementDictionary } from "../../../lib/db/settlementCheck.remoteApi.client";

type Run = (action: () => Promise<unknown>, successNotice?: string) => Promise<boolean>;

const PICKER_LIMIT = 60;

function catalogLabel(item: SettlementCatalogItem): string {
  return `${item.abfCode ?? item.internalCode ?? "bez kódu"} · ${item.displayName}${item.lifecycleStatus === "archived" ? " (archiv)" : ""}`;
}

/** Search + select over the catalog. Matches the ABF code, internal code, our name and the ABF name. */
export function CatalogItemPicker({ items, value, onChange, disabled }: { items: readonly SettlementCatalogItem[]; value: string; onChange: (id: string) => void; disabled?: boolean }) {
  const [query, setQuery] = useState("");
  const needle = normalizeSettlementText(query);
  const matches = useMemo(() => {
    const filtered = needle
      ? items.filter((item) => normalizeSettlementText(`${item.abfCode ?? ""} ${item.internalCode ?? ""} ${item.displayName} ${item.officialName ?? ""}`).includes(needle))
      : items.filter((item) => item.lifecycleStatus !== "archived");
    return [...filtered].sort((a, b) => a.displayName.localeCompare(b.displayName, "cs"));
  }, [items, needle]);
  const selected = items.find((item) => item.id === value);
  const options = matches.slice(0, PICKER_LIMIT);

  return (
    <span className="settlementPicker">
      <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="hledat komponentu (kód, název)…" disabled={disabled} />
      <select value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        <option value="">— vyberte komponentu —</option>
        {selected && !options.includes(selected) && <option value={selected.id}>{catalogLabel(selected)}</option>}
        {options.map((item) => <option key={item.id} value={item.id}>{catalogLabel(item)}</option>)}
      </select>
      {matches.length > PICKER_LIMIT && <small>zobrazeno {PICKER_LIMIT} z {matches.length} — upřesněte hledání</small>}
    </span>
  );
}

// ============================================================================
// Dictionary: realization-company names + ABF names of catalog cards
// ============================================================================

function MappingRow({ mapping, check, items, client, busy, run }: { mapping: SettlementVendorMapping; check: SettlementCheck; items: readonly SettlementCatalogItem[]; client: RemoteApiSettlementClient; busy: boolean; run: Run }) {
  const [catalogItemId, setCatalogItemId] = useState(mapping.catalogItemId ?? "");
  const [unit, setUnit] = useState(mapping.unit ?? "");
  const [status, setStatus] = useState<SettlementMappingStatus>(mapping.status);
  const dirty = catalogItemId !== (mapping.catalogItemId ?? "") || unit !== (mapping.unit ?? "") || status !== mapping.status;

  return (
    <div className="settlementMappingRow">
      <span><strong>{mapping.sourceText}</strong></span>
      <CatalogItemPicker items={items} value={catalogItemId} onChange={setCatalogItemId} disabled={busy} />
      <input value={unit} onChange={(event) => setUnit(event.target.value)} placeholder="z textu" disabled={busy} className="settlementUnitInput" />
      <select value={status} onChange={(event) => setStatus(event.target.value as SettlementMappingStatus)} disabled={busy}>
        {SETTLEMENT_MAPPING_STATUSES.map((value) => <option key={value} value={value}>{SETTLEMENT_MAPPING_STATUS_LABELS_CS[value]}</option>)}
      </select>
      <span><small>{new Date(mapping.updatedAt).toLocaleDateString("cs-CZ")}</small></span>
      <button
        type="button"
        disabled={busy || !dirty}
        onClick={() => void run(() => client.saveMapping({ realizationCompanyId: check.realizationCompanyId, sourceText: mapping.sourceText, catalogItemId: catalogItemId || null, unit: unit.trim() || null, status, recomputeCheckId: check.id }), "Slovník uložen, porovnání přepočítáno.")}
      >
        Uložit
      </button>
    </div>
  );
}

export function SettlementDictionaryTab({ check, dictionary, client, busy, run }: { check: SettlementCheck; dictionary: SettlementDictionary; client: RemoteApiSettlementClient; busy: boolean; run: Run }) {
  const [query, setQuery] = useState("");
  const [onlyOpen, setOnlyOpen] = useState(true);
  const [nameItemId, setNameItemId] = useState("");
  const [nameType, setNameType] = useState<CatalogNameType>("abf_alternative");
  const [nameText, setNameText] = useState("");

  const needle = normalizeSettlementText(query);
  const mappings = dictionary.mappings.filter((mapping) => (!onlyOpen || mapping.status !== "confirmed") && (!needle || mapping.normalizedText.includes(needle)));
  const confirmed = dictionary.mappings.filter((mapping) => mapping.status === "confirmed").length;
  const itemById = new Map(dictionary.catalogItems.map((item) => [item.id, item]));

  return (
    <div className="settlementDictionary">
      <div className="workflowCard">
        <div className="workflowCardHeader">
          <div><span>SLOVNÍK REALIZAČKY</span><strong>{check.realizationCompanyName} — názvy položek ve vyúčtování</strong></div>
          <small>{confirmed} potvrzeno z {dictionary.mappings.length}</small>
        </div>
        <p className="workflowMuted">Platí pro všechny akce této firmy. V porovnání se použijí jen potvrzená mapování; návrhy a nejasné zůstávají k rozhodnutí. Stejný text u jiné realizačky je samostatný záznam.</p>
        <div className="settlementFilters">
          <label className="settlementCheckbox"><input type="checkbox" checked={onlyOpen} onChange={(event) => setOnlyOpen(event.target.checked)} /> jen nepotvrzené</label>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat text realizačky…" />
        </div>
        <div className="settlementMappingRow settlementMappingHeader"><span>Originální text realizačky</span><span>Komponenta katalogu</span><span>Jednotka</span><span>Stav</span><span>Změněno</span><span /></div>
        {mappings.length === 0 && <p className="workspaceEmpty">{dictionary.mappings.length === 0 ? "Slovník je prázdný — naplní se prvním importem vyúčtování." : "Nic neodpovídá filtru."}</p>}
        {mappings.map((mapping) => <MappingRow key={`${mapping.id}:${mapping.updatedAt}`} mapping={mapping} check={check} items={dictionary.catalogItems} client={client} busy={busy} run={run} />)}
      </div>

      <div className="workflowCard">
        <div className="workflowCardHeader"><div><span>KATALOG KOMPONENT</span><strong>Názvy ABF u komponent</strong></div></div>
        <p className="workflowMuted">
          Každá komponenta má ABF kód, originální název ABF (upravuje se na kartě katalogu) a náš zobrazovaný název — ty se zde nemění.
          Tady se k ní přidávají další názvy, pod kterými ji ABF uvádí v objednávkách (historické, zkrácené, jinak zapsané).
        </p>
        <div className="settlementActionRow">
          <CatalogItemPicker items={dictionary.catalogItems} value={nameItemId} onChange={setNameItemId} disabled={busy} />
          <select value={nameType} onChange={(event) => setNameType(event.target.value as CatalogNameType)} disabled={busy}>
            {CATALOG_NAME_TYPES.map((type) => <option key={type} value={type}>{CATALOG_NAME_TYPE_LABELS_CS[type]}</option>)}
          </select>
          <input value={nameText} onChange={(event) => setNameText(event.target.value)} placeholder="název přesně podle ABF" disabled={busy} className="settlementWideInput" />
          <button
            type="button"
            disabled={busy || !nameItemId || !nameText.trim()}
            onClick={() => void run(() => client.addCatalogName({ catalogItemId: nameItemId, nameType, name: nameText.trim(), recomputeCheckId: check.id }), "Název přidán.").then((ok) => { if (ok) setNameText(""); })}
          >
            Přidat název
          </button>
        </div>
        <table className="pricingPreviewTable">
          <thead><tr><th>ABF kód</th><th>Náš název</th><th>Originální název ABF</th><th>Další názvy ABF</th></tr></thead>
          <tbody>
            {dictionary.catalogNames.length === 0 && <tr><td colSpan={4}>Zatím žádný doplněný název.</td></tr>}
            {[...new Set(dictionary.catalogNames.map((name) => name.catalogItemId))].map((catalogItemId) => {
              const item = itemById.get(catalogItemId);
              return (
                <tr key={catalogItemId}>
                  <td>{item?.abfCode ?? "—"}</td>
                  <td>{item?.displayName ?? "(komponenta není v katalogu)"}</td>
                  <td>{item?.officialName ?? "—"}</td>
                  <td>
                    {dictionary.catalogNames.filter((name) => name.catalogItemId === catalogItemId).map((name) => (
                      <span key={name.id} className="settlementNameChip" title={CATALOG_NAME_TYPE_LABELS_CS[name.nameType]}>
                        {name.name}{name.nameType === "abf_original" ? " (orig.)" : ""}
                        <button type="button" className="textButton dangerText" disabled={busy} aria-label={`Odebrat název ${name.name}`} onClick={() => { if (window.confirm(`Odebrat název „${name.name}“?`)) void run(() => client.deleteCatalogName(name.id, check.id)); }}>×</button>
                      </span>
                    ))}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ============================================================================
// Rules
// ============================================================================

export function SettlementRulesTab({
  check,
  eventName,
  catalogItems,
  client,
  busy,
  actor,
  run,
}: {
  check: SettlementCheck;
  eventName: string;
  catalogItems: readonly SettlementCatalogItem[];
  client: RemoteApiSettlementClient;
  busy: boolean;
  actor: string;
  run: Run;
}) {
  const [rules, setRules] = useState<readonly SettlementRule[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [ruleType, setRuleType] = useState<SettlementRuleType>("unit_conversion");
  const [name, setName] = useState("");
  const [explanation, setExplanation] = useState("");
  const [onlyThisEvent, setOnlyThisEvent] = useState(false);
  const [catalogItemId, setCatalogItemId] = useState("");
  const [definitionText, setDefinitionText] = useState("");

  const loadRules = () => client.rules(check.realizationCompanyId).then(setRules).catch((cause) => setLoadError(cause instanceof Error ? cause.message : "Pravidla se nepodařilo načíst."));
  useEffect(() => {
    void loadRules();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [check.realizationCompanyId, check.updatedAt]);

  async function create() {
    let definition: Record<string, unknown> = {};
    if (ruleType === "out_of_scope") {
      definition = { catalogItemId };
    } else if (definitionText.trim()) {
      try {
        const parsed = JSON.parse(definitionText) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        definition = parsed as Record<string, unknown>;
      } catch {
        setLoadError("Definice musí být platný JSON objekt, např. {\"from\":\"ks\",\"to\":\"bm\",\"factor\":1}.");
        return;
      }
    }
    setLoadError("");
    const ok = await run(() => client.createRule({ realizationCompanyId: check.realizationCompanyId, rule: { ruleType, name, explanation, eventId: onlyThisEvent ? check.eventId : null, definition }, actorName: actor.trim() || undefined }), "Pravidlo uloženo jako návrh — zatím se nepoužívá.");
    if (ok) {
      setName("");
      setExplanation("");
      setDefinitionText("");
      await loadRules();
    }
  }

  async function setStatus(rule: SettlementRule, status: SettlementRule["status"]) {
    if (status === "active") {
      if (!actor.trim()) { setLoadError("Vyplňte nahoře své jméno — pravidlo může aktivovat jen konkrétní osoba."); return; }
      if (!window.confirm(`Aktivovat pravidlo „${rule.name}“?\n\nPotvrzujete, že jste ho ověřili. Od této chvíle ovlivňuje výsledky kontrol firmy ${check.realizationCompanyName}.`)) return;
    }
    setLoadError("");
    if (await run(() => client.setRuleStatus({ id: rule.id, status, actorName: actor.trim() || undefined, recomputeCheckId: check.id }))) await loadRules();
  }

  const itemName = (id: unknown) => (typeof id === "string" ? catalogItems.find((item) => item.id === id)?.displayName : undefined);

  return (
    <div className="settlementDictionary">
      <div className="workflowCard">
        <div className="workflowCardHeader"><div><span>PRAVIDLA</span><strong>{check.realizationCompanyName} — způsob účtování</strong></div></div>
        <p className="workflowMuted">
          Pravidlo vzniká vždy jako návrh a nic neovlivňuje, dokud ho konkrétní osoba neaktivuje. V této verzi porovnání vyhodnocuje jen typ
          „{SETTLEMENT_RULE_TYPE_LABELS_CS.out_of_scope}“. Ostatní typy se zatím jen evidují — řádky, které by je potřebovaly, mají stav „Vyžaduje pravidlo“.
        </p>
        {loadError && <p className="uploadError">{loadError}</p>}
        {!rules && !loadError && <p className="workspaceEmpty">Načítám pravidla…</p>}
        {rules && rules.length === 0 && <p className="workspaceEmpty">Firma zatím nemá žádné pravidlo.</p>}
        {rules?.map((rule) => (
          <div key={rule.id} className="settlementRule">
            <div className="settlementFileHead">
              <strong>{rule.name}</strong>
              <em className={`settlementBadge settlementRule-${rule.status}`}>{SETTLEMENT_RULE_STATUS_LABELS_CS[rule.status]}</em>
              {!SETTLEMENT_EVALUATED_RULE_TYPES.includes(rule.ruleType) && <em className="settlementBadge">zatím se nevyhodnocuje</em>}
              {rule.status !== "active" && <button type="button" disabled={busy} onClick={() => void setStatus(rule, "active")}>Aktivovat</button>}
              {rule.status === "active" && <button type="button" disabled={busy} onClick={() => void setStatus(rule, "disabled")}>Vypnout</button>}
            </div>
            <small>
              {SETTLEMENT_RULE_TYPE_LABELS_CS[rule.ruleType]} · {rule.eventId ? `jen akce ${rule.eventId === check.eventId ? eventName : rule.eventId}` : "všechny akce firmy"}
              {rule.origin === "ai_suggestion" ? " · návrh AI" : ""}
              {rule.verifiedBy ? ` · ověřil(a) ${rule.verifiedBy} ${rule.verifiedAt ? new Date(rule.verifiedAt).toLocaleDateString("cs-CZ") : ""}` : " · neověřeno"}
            </small>
            <p>{rule.explanation}</p>
            {Object.keys(rule.definition).length > 0 && (
              <small>{itemName(rule.definition.catalogItemId) ? `Komponenta: ${itemName(rule.definition.catalogItemId)}` : typeof rule.definition.abfName === "string" ? `Název ABF: ${rule.definition.abfName}` : `Definice: ${JSON.stringify(rule.definition)}`}</small>
            )}
          </div>
        ))}
      </div>

      <div className="workflowCard">
        <div className="workflowCardHeader"><div><span>NOVÉ PRAVIDLO</span><strong>Uložit návrh pravidla</strong></div></div>
        <div className="settlementRuleForm">
          <label>
            <span>Typ</span>
            <select value={ruleType} onChange={(event) => setRuleType(event.target.value as SettlementRuleType)} disabled={busy}>
              {SETTLEMENT_RULE_TYPES.map((type) => <option key={type} value={type}>{SETTLEMENT_RULE_TYPE_LABELS_CS[type]}</option>)}
            </select>
          </label>
          <label><span>Název</span><input value={name} onChange={(event) => setName(event.target.value)} disabled={busy} placeholder="např. Límec se účtuje v bm" /></label>
          <label className="settlementWide"><span>Vysvětlení (zobrazí se u každého ovlivněného řádku)</span><textarea value={explanation} onChange={(event) => setExplanation(event.target.value)} disabled={busy} rows={3} /></label>
          {ruleType === "out_of_scope" ? (
            <label className="settlementWide"><span>Komponenta, kterou realizačka neúčtuje</span><CatalogItemPicker items={catalogItems} value={catalogItemId} onChange={setCatalogItemId} disabled={busy} /></label>
          ) : (
            <label className="settlementWide"><span>Definice (JSON, nepovinné — zatím se jen ukládá)</span><textarea value={definitionText} onChange={(event) => setDefinitionText(event.target.value)} disabled={busy} rows={2} placeholder='{"from":"ks","to":"bm","factor":1}' /></label>
          )}
          <label className="settlementCheckbox"><input type="checkbox" checked={onlyThisEvent} onChange={(event) => setOnlyThisEvent(event.target.checked)} disabled={busy} /> jen pro akci {eventName}</label>
        </div>
        <div className="printSurfaceCreateFormActions">
          <button type="button" disabled={busy || !name.trim() || explanation.trim().length < 10 || (ruleType === "out_of_scope" && !catalogItemId)} onClick={() => void create()}>Uložit jako návrh</button>
        </div>
      </div>
    </div>
  );
}
