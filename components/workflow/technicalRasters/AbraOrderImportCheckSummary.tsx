"use client";

import type { AbraOrderReviewItem, AbraOrderTechnicalImport, AbraOrderTechnicalLine } from "../../../domain/abraOrderTechnicalImport";
import { technicalServiceCategoryLabel } from "../../../domain/technicalServiceCatalog";

const REVIEW_KIND_LABELS: Readonly<Record<AbraOrderReviewItem["kind"], string>> = {
  cancellationFee: "Stornopoplatek",
  unreadableQuantity: "Nečitelné množství",
  nonPositiveQuantity: "Nulové / záporné množství",
  fractionalQuantity: "Desetinné množství",
  unknownTechnicalCode: "Neznámý kód",
  uncodedItem: "Bez ABF kódu",
};

function LineTable({ lines, showStand }: { lines: readonly AbraOrderTechnicalLine[]; showStand: boolean }) {
  return (
    <table className="abraOrderCheckTable">
      <thead>
        <tr>{showStand && <th>Stánek</th>}<th>Firma</th><th>Objednávka</th><th>Kód</th><th>Služba</th><th>Množství</th><th>Značka</th></tr>
      </thead>
      <tbody>
        {lines.map((line, index) => (
          <tr key={`${line.orderNumber}-${line.code}-${index}`}>
            {showStand && <td>{line.standNumber}</td>}
            <td>{line.companyName ?? "—"}</td>
            <td>{line.orderNumber}</td>
            <td>{line.code}</td>
            <td>{line.name}{line.notes.length > 0 && <span className="fieldHint"> — {line.notes.join(" / ")}</span>}</td>
            <td>{line.quantityRaw} {line.unit}</td>
            <td>{technicalServiceCategoryLabel(line.category)}: {line.externalLabel}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Kontrolní přehled importu formuláře objednávek ABRA (náhled před potvrzením): kolik objednávek a
 * služeb se našlo, co se vloží do rastru, služby bez čísla stánku, neznámé kódy a položky ke kontrole.
 * Nic z toho se automaticky nemaže ani neodhaduje.
 */
export function AbraOrderImportCheckSummary({ orderImport }: { orderImport: AbraOrderTechnicalImport }) {
  const { counts, servicesWithoutStand, unknownTechnicalCodes, reviewItems, importedLines } = orderImport;
  const problems = reviewItems.filter((item) => item.kind !== "unknownTechnicalCode");
  return (
    <div className="abraOrderCheck">
      <div className="technicalImportPreviewSummary">
        <span>Objednávek <strong>{counts.orders}</strong></span>
        <span>S technickými službami <strong>{counts.ordersWithTechnicalServices}</strong></span>
        <span>Technických služeb <strong>{counts.technicalServices}</strong></span>
        <span>Stánků se službami <strong>{counts.standsWithTechnicalServices}</strong></span>
        <span className={servicesWithoutStand.length > 0 ? "technicalImportPreviewSummaryWarn" : undefined}>Služby bez čísla stánku <strong>{servicesWithoutStand.length}</strong></span>
        <span className={unknownTechnicalCodes.length > 0 ? "technicalImportPreviewSummaryWarn" : undefined}>Neznámé kódy <strong>{unknownTechnicalCodes.length}</strong></span>
        <span className={problems.length > 0 ? "technicalImportPreviewSummaryWarn" : undefined}>Ke kontrole <strong>{problems.length}</strong></span>
      </div>
      <p className="fieldHint">
        {counts.pages} stran, {counts.items} položek. Ignorováno: {counts.ordersWithStandWithoutServices} objednávek se stánkem bez technické služby, {counts.ordersWithoutStandOrServices} bez stánku i služby (z toho {counts.emptyOrders} prázdných).
        Do rastru se vloží {counts.importedTechnicalServices} služeb.
      </p>

      <details className="technicalImportPreviewDetails">
        <summary>Co se vloží do rastru ({importedLines.length})</summary>
        <LineTable lines={importedLines} showStand />
      </details>

      {servicesWithoutStand.length > 0 && (
        <details className="technicalImportPreviewDetails" open>
          <summary className="technicalImportPreviewSummaryWarn">Služby bez čísla stánku — do rastru se nevloží ({servicesWithoutStand.length})</summary>
          <LineTable lines={servicesWithoutStand} showStand={false} />
        </details>
      )}

      {unknownTechnicalCodes.length > 0 && (
        <details className="technicalImportPreviewDetails" open>
          <summary className="technicalImportPreviewSummaryWarn">Nespárované a neznámé kódy ({unknownTechnicalCodes.length}) — nepřevádí se, kód není ve schválené tabulce</summary>
          <ul>
            {unknownTechnicalCodes.map((code) => <li key={code.code}><strong>{code.code}</strong> {code.name} — {code.itemCount}× ({code.orderNumbers.join(", ")})</li>)}
          </ul>
        </details>
      )}

      {problems.length > 0 && (
        <details className="technicalImportPreviewDetails">
          <summary className="technicalImportPreviewSummaryWarn">Storna a problematické položky ({problems.length}) — nic se automaticky nemaže</summary>
          <ul>
            {problems.map((item, index) => (
              <li key={`${item.orderNumber}-${index}`}>
                <strong>{REVIEW_KIND_LABELS[item.kind]}</strong>: {item.orderNumber}{item.standNumber ? ` (stánek ${item.standNumber})` : ""} · {item.companyName ?? "—"} · {item.code || "bez kódu"} {item.name} {item.quantityRaw} {item.unit} — {item.message}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
