"use client";

import type { AbraOrderReviewItem, AbraOrderTechnicalImport, AbraOrderTechnicalLine } from "../../../domain/abraOrderTechnicalImport";
import { ONLY_EXISTING_MESSAGE, type AbraOrderReconciliation, type ServiceReconciliationItem } from "../../../domain/abraOrderReconciliation";
import { technicalServiceCategoryLabel } from "../../../domain/technicalServiceCatalog";

const REVIEW_KIND_LABELS: Readonly<Record<AbraOrderReviewItem["kind"], string>> = {
  cancellationFee: "Stornopoplatek",
  unreadableQuantity: "Nečitelné množství",
  nonPositiveQuantity: "Nulové / záporné množství",
  fractionalQuantity: "Desetinné množství",
  unknownTechnicalCode: "Neznámý ABF kód",
  uncodedItem: "Bez ABF kódu",
  noElectricityWithElectricity: "L63 + elektřina",
};

const NO_ELECTRICITY_SOURCE_LABELS = { report: "z výjezdu elektřiny", "abra-orders": "z objednávek", manual: "nastaveno ručně" } as const;

function orderLinesText(lines: readonly AbraOrderTechnicalLine[]): string {
  return lines.map((line) => `${line.orderNumber} · ${line.code} ${line.quantityRaw} ${line.unit}${line.notes.length > 0 ? ` (${line.notes.join(" / ")})` : ""}`).join("; ");
}

function formatQuantity(value: number): string {
  return String(Math.round(value * 1000) / 1000).replace(".", ",");
}

function ServiceTable({ items, decision }: { items: readonly ServiceReconciliationItem[]; decision?: Readonly<{ label: string; accepted: ReadonlySet<string>; onToggle: (id: string, accepted: boolean) => void }> }) {
  return (
    <table className="abraOrderCheckTable">
      <thead>
        <tr>
          {decision && <th>{decision.label}</th>}
          <th>Stánek</th><th>Služba</th><th>V rastru (zdroj)</th><th>V nových objednávkách</th><th>Rozdíl</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => (
          <tr key={item.id}>
            {decision && (
              <td><input type="checkbox" aria-label={`${decision.label}: ${item.standNumber} ${item.displayLabel}`} checked={decision.accepted.has(item.id)} onChange={(event) => decision.onToggle(item.id, event.target.checked)} /></td>
            )}
            <td>{item.standNumber}</td>
            <td><strong>{item.displayLabel}</strong> <span className="fieldHint">{technicalServiceCategoryLabel(item.category)} · {item.externalLabel}</span></td>
            <td>{item.existing.length === 0 ? "—" : item.existing.map((ref) => <div key={ref.serviceId}>{formatQuantity(ref.quantity)}× — {ref.sourceLabels.join(", ")}{ref.placementCount > 0 ? ` · umístěno ${ref.placementCount}` : ""}</div>)}</td>
            <td>{item.orderLines.length === 0 ? "—" : <>{formatQuantity(item.orderQuantity)}× <span className="fieldHint">{orderLinesText(item.orderLines)}</span></>}</td>
            <td>
              {item.kind === "quantityDiff" ? <>{item.orderQuantity > item.existingQuantity ? "+" : ""}{formatQuantity(item.orderQuantity - item.existingQuantity)}{item.placementsDroppedIfApplied > 0 && <span className="technicalImportPreviewSummaryWarn"> (odebere {item.placementsDroppedIfApplied} bodů)</span>}</> : item.kind === "onlyExisting" ? ONLY_EXISTING_MESSAGE : "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Kontrolní obrazovka importu formuláře objednávek ABRA. Nic se nemaže: nové služby, změny množství a
 * „BEZ elektriky“ se zapíšou jen zaškrtnuté; služby jen z dřívějších výjezdů zůstávají a jsou vypsané.
 * U každého rozdílu je vidět, ze kterého zdroje pochází.
 */
export function AbraOrderImportCheckSummary({
  orderImport,
  reconciliation,
  accepted,
  onToggle,
}: {
  orderImport: AbraOrderTechnicalImport;
  reconciliation: AbraOrderReconciliation;
  accepted: ReadonlySet<string>;
  onToggle: (id: string, accepted: boolean) => void;
}) {
  const { counts, servicesWithoutStand, reviewItems, ambiguousPages, noElectricityLines } = orderImport;
  const byKind = (kind: ServiceReconciliationItem["kind"]) => reconciliation.services.filter((item) => item.kind === kind);
  const newItems = byKind("new");
  const quantityItems = byKind("quantityDiff");
  const onlyExisting = byKind("onlyExisting");
  const matched = byKind("matched");
  const unknownOrUncoded = reviewItems.filter((item) => item.kind === "unknownTechnicalCode" || item.kind === "uncodedItem");
  const otherReview = reviewItems.filter((item) => item.kind !== "unknownTechnicalCode" && item.kind !== "uncodedItem");
  const noElectricityOffers = reconciliation.noElectricity.filter((item) => item.kind === "new");
  const noElectricityNotes = reconciliation.noElectricity.filter((item) => item.kind !== "new");
  const noElectricityWithoutStand = noElectricityLines.filter((line) => !line.standNumber);
  const toggleAll = (ids: readonly string[], value: boolean) => ids.forEach((id) => onToggle(id, value));
  const warn = (value: number) => (value > 0 ? "technicalImportPreviewSummaryWarn" : undefined);

  return (
    <div className="abraOrderCheck">
      <div className="technicalImportPreviewSummary">
        <span>Objednávek <strong>{counts.orders}</strong></span>
        <span>Rozpoznaných služeb <strong>{counts.technicalServices}</strong></span>
        <span>Stánků se službami <strong>{counts.standsWithTechnicalServices}</strong></span>
        <span className={warn(newItems.length)}>Nové k doplnění <strong>{newItems.length}</strong></span>
        <span>Shodné <strong>{matched.length}</strong></span>
        <span className={warn(onlyExisting.length)}>Jen v předchozích výjezdech <strong>{onlyExisting.length}</strong></span>
        <span className={warn(quantityItems.length)}>Rozdílná množství <strong>{quantityItems.length}</strong></span>
        <span className={warn(unknownOrUncoded.length)}>Neznámé / bez kódu <strong>{unknownOrUncoded.length}</strong></span>
        <span className={warn(servicesWithoutStand.length + noElectricityWithoutStand.length)}>Služby bez stánku <strong>{servicesWithoutStand.length + noElectricityWithoutStand.length}</strong></span>
        <span className={warn(ambiguousPages.length)}>Nejednoznačné strany PDF <strong>{ambiguousPages.length}</strong></span>
      </div>
      <p className="fieldHint">
        {counts.pages} stran, {counts.items} položek, {counts.ordersWithTechnicalServices} objednávek s technickými službami. Ignorováno: {counts.ordersWithStandWithoutServices} objednávek se stánkem bez technické služby, {counts.ordersWithoutStandOrServices} bez stánku i služby.
        Nic se nemaže — do rastru se zapíšou jen zaškrtnuté položky.
      </p>

      {ambiguousPages.length > 0 && (
        <details className="technicalImportPreviewDetails" open>
          <summary className="technicalImportPreviewSummaryWarn">Nejednoznačně přiřazené strany PDF ({ambiguousPages.length}) — jejich položky se nenačetly</summary>
          <ul>{ambiguousPages.map((page) => <li key={page.page}>Strana {page.page}{page.orderNumber ? ` (${page.orderNumber}, č. ${page.pageOfOrder ?? "?"})` : ""}: {page.reason} — {page.itemCount} položek ({page.itemCodes.join(", ") || "—"})</li>)}</ul>
        </details>
      )}

      {newItems.length > 0 && (
        <details className="technicalImportPreviewDetails" open>
          <summary>Nové služby k doplnění ({newItems.length}) — zdroj: nové objednávky</summary>
          <p className="fieldHint">
            <button type="button" className="technicalActionButton secondary compact" onClick={() => toggleAll(newItems.map((item) => item.id), true)}>Vybrat vše</button>{" "}
            <button type="button" className="technicalActionButton secondary compact" onClick={() => toggleAll(newItems.map((item) => item.id), false)}>Zrušit výběr</button>
          </p>
          <ServiceTable items={newItems} decision={{ label: "Doplnit", accepted, onToggle }} />
        </details>
      )}

      {quantityItems.length > 0 && (
        <details className="technicalImportPreviewDetails" open>
          <summary className="technicalImportPreviewSummaryWarn">Rozdílná množství ({quantityItems.length}) — beze změny, dokud nezaškrtnete</summary>
          <ServiceTable items={quantityItems} decision={{ label: "Upravit podle objednávek", accepted, onToggle }} />
        </details>
      )}

      {onlyExisting.length > 0 && (
        <details className="technicalImportPreviewDetails" open>
          <summary className="technicalImportPreviewSummaryWarn">Služby jen v předchozích výjezdech ({onlyExisting.length}) — zůstávají beze změny</summary>
          <ServiceTable items={onlyExisting} />
        </details>
      )}

      {(noElectricityOffers.length > 0 || noElectricityNotes.length > 0 || noElectricityWithoutStand.length > 0) && (
        <details className="technicalImportPreviewDetails" open>
          <summary>BEZ elektriky (L63) — {noElectricityOffers.length} k doplnění, {noElectricityNotes.filter((item) => item.kind === "conflict").length} rozporů</summary>
          <ul>
            {noElectricityOffers.map((item) => (
              <li key={item.id}><label><input type="checkbox" checked={accepted.has(item.id)} onChange={(event) => onToggle(item.id, event.target.checked)} /> Doplnit červené X — stánek <strong>{item.standNumber}</strong> ({item.orderNumbers.join(", ")})</label></li>
            ))}
            {noElectricityNotes.map((item) => (
              <li key={item.id} className={item.kind === "matched" ? undefined : "technicalImportPreviewSummaryWarn"}>
                Stánek <strong>{item.standNumber}</strong>: {item.message}{item.existingSource ? ` (v rastru ${NO_ELECTRICITY_SOURCE_LABELS[item.existingSource]})` : ""}{item.orderNumbers.length > 0 ? ` — ${item.orderNumbers.join(", ")}` : ""}
              </li>
            ))}
            {noElectricityWithoutStand.map((line, index) => (
              <li key={`l63-nostand-${line.orderNumber}-${index}`} className="technicalImportPreviewSummaryWarn">
                Objednávka <strong>{line.orderNumber}</strong>{line.companyName ? ` (${line.companyName})` : ""}: L63 BEZ ELEKTRICKÉ ENERGIE bez čísla stánku — do rastru se nevloží.{line.notes.length > 0 ? ` Poznámka: ${line.notes.join(" / ")}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}

      {matched.length > 0 && (
        <details className="technicalImportPreviewDetails">
          <summary>Shodné služby ({matched.length}) — bez nových bodů, umístění zůstávají</summary>
          <ServiceTable items={matched} />
        </details>
      )}

      {unknownOrUncoded.length > 0 && (
        <details className="technicalImportPreviewDetails">
          <summary className="technicalImportPreviewSummaryWarn">Neznámé ABF kódy a položky bez kódu ({unknownOrUncoded.length}) — nepřevádí se</summary>
          <table className="abraOrderCheckTable">
            <thead><tr><th>Objednávka</th><th>Firma</th><th>Stánek</th><th>Kód</th><th>Položka</th><th>Množství</th><th>Poznámka</th></tr></thead>
            <tbody>
              {unknownOrUncoded.map((item, index) => (
                <tr key={`${item.orderNumber}-${index}`}><td>{item.orderNumber}</td><td>{item.companyName ?? "—"}</td><td>{item.standNumber ?? "—"}</td><td>{item.code || "bez kódu"}</td><td>{item.name}</td><td>{item.quantityRaw} {item.unit}</td><td>{item.notes.join(" / ") || "—"}</td></tr>
              ))}
            </tbody>
          </table>
        </details>
      )}

      {servicesWithoutStand.length > 0 && (
        <details className="technicalImportPreviewDetails" open>
          <summary className="technicalImportPreviewSummaryWarn">Objednávky se službami bez čísla stánku ({servicesWithoutStand.length}) — do rastru se nevloží</summary>
          <table className="abraOrderCheckTable">
            <thead><tr><th>Firma</th><th>Objednávka</th><th>Kód</th><th>Služba</th><th>Množství</th></tr></thead>
            <tbody>{servicesWithoutStand.map((line, index) => <tr key={`${line.orderNumber}-${index}`}><td>{line.companyName ?? "—"}</td><td>{line.orderNumber}</td><td>{line.code}</td><td>{line.name}</td><td>{line.quantityRaw} {line.unit}</td></tr>)}</tbody>
          </table>
        </details>
      )}

      {otherReview.length > 0 && (
        <details className="technicalImportPreviewDetails">
          <summary className="technicalImportPreviewSummaryWarn">Storna a problematické položky ({otherReview.length}) — nic se automaticky nemaže</summary>
          <ul>
            {otherReview.map((item, index) => (
              <li key={`${item.orderNumber}-${index}`}><strong>{REVIEW_KIND_LABELS[item.kind]}</strong>: {item.orderNumber}{item.standNumber ? ` (stánek ${item.standNumber})` : ""} · {item.companyName ?? "—"} · {item.code || "bez kódu"} {item.name} {item.quantityRaw} {item.unit} — {item.message}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
