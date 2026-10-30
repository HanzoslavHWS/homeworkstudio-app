"use client";

import type { AbraOrderFairCheck } from "../../../domain/abraOrderFairCheck";
import type { PlacementLossItem } from "../../../domain/technicalRaster";

const points = (count: number) => `${count} ${count === 1 ? "umístěný bod" : count < 5 ? "umístěné body" : "umístěných bodů"}`;

/**
 * Placed points an import would remove. Unplaced points are always used up first, so only points the
 * user really put into the raster appear here — and the import waits for an explicit "yes".
 */
export function PlacementLossConfirmation({ items, confirmed, onConfirmedChange }: { items: readonly PlacementLossItem[]; confirmed: boolean; onConfirmedChange: (confirmed: boolean) => void }) {
  if (items.length === 0) return null;
  const total = items.reduce((sum, item) => sum + item.placementCount, 0);
  return (
    <div className="technicalImportSafetyCheck" role="alert">
      <strong>Pozor: import odstraní {points(total)}</strong>
      <p className="fieldHint">Nižší množství nejdřív ubírá body, které ještě nejsou umístěné. Tyto body jsou už ručně umístěné v rastru a po potvrzení zmizí:</p>
      <table className="abraOrderCheckTable">
        <thead><tr><th>Stánek</th><th>Služba</th><th>Množství</th><th>Zmizí</th></tr></thead>
        <tbody>
          {items.map((item, index) => (
            <tr key={`${item.standNumber}-${item.externalLabel}-${index}`}>
              <td>{item.standNumber}</td>
              <td>{item.externalLabel}</td>
              <td>{item.previousQuantity}× → {item.quantity}×</td>
              <td>{points(item.placementCount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <label className="technicalImportSafetyConfirm">
        <input type="checkbox" checked={confirmed} onChange={(event) => onConfirmedChange(event.target.checked)} />
        <span>Rozumím a souhlasím s odstraněním {points(total)}.</span>
      </label>
    </div>
  );
}

/** "Patří tento soubor k tomuto veletrhu?" — the order PDF has no fair identifier, so the user confirms it explicitly. */
export function AbraOrderFairConfirmation({ check, confirmed, onConfirmedChange }: { check: AbraOrderFairCheck; confirmed: boolean; onConfirmedChange: (confirmed: boolean) => void }) {
  const conflict = check.status === "conflict";
  return (
    <div className={conflict ? "technicalImportSafetyCheck" : "technicalImportSafetyCheck neutral"} role={conflict ? "alert" : undefined}>
      <strong>{conflict ? "Rozporná příslušnost k veletrhu" : "Příslušnost k veletrhu nelze ověřit"}</strong>
      <dl className="technicalImportSafetyFacts">
        <dt>Zdrojový soubor</dt>
        <dd>{check.sourceFileName} — řada dokladů {check.orderSeries.join(", ") || "—"}{check.issueDateRange ? `, vystaveno ${check.issueDateRange.from === check.issueDateRange.to ? check.issueDateRange.from : `${check.issueDateRange.from} – ${check.issueDateRange.to}`}` : ""}</dd>
        <dt>Cílový veletrh</dt>
        <dd>{check.target.eventLabel ?? "nepřiřazen"} — projekt „{check.target.projectName}“{check.target.hall ? `, hala ${check.target.hall}` : ""}</dd>
        {check.standsInRaster && (<><dt>Stánky v rastru</dt><dd>{check.standsInRaster.matched} z {check.standsInRaster.total} stánků s technickými službami</dd></>)}
      </dl>
      <ul>{check.findings.map((finding) => <li key={finding.kind} className={finding.kind === "seriesDiffers" || finding.kind === "noStandInRaster" ? "technicalImportPreviewSummaryWarn" : undefined}>{finding.message}</li>)}</ul>
      <label className="technicalImportSafetyConfirm">
        <input type="checkbox" checked={confirmed} onChange={(event) => onConfirmedChange(event.target.checked)} />
        <span>{check.confirmationText}</span>
      </label>
    </div>
  );
}
