import type { ProjectType } from "../../domain/models";
import { sumProjectLines, type ProjectPricingResult } from "../../domain/projectPricing";

type PricingBarProps = {
  /** The shared project pricing (domain/projectPricing.ts) — the same result as the customer calculation. */
  pricing: ProjectPricingResult;
  projectType?: ProjectType;
};

function money(value: number, currency: string): string {
  return `${value.toLocaleString("cs-CZ")} ${currency}`;
}

/**
 * Editor price bar (07-B1). Shows the same lines and totals as the customer calculation, the project
 * summary and the exports — never its own partial sum. A missing price is "K nacenění", never 0.
 */
export function PricingBar({ pricing, projectType }: PricingBarProps) {
  const { currency } = pricing;
  const booth = pricing.lines.find((line) => line.kind === "booth");
  const furniture = sumProjectLines(pricing.lines, (line) => line.kind === "scene_item" && line.status !== "not_billed");
  const services = sumProjectLines(pricing.lines, (line) => line.kind === "service");
  const boothLabel = !booth
    ? projectType === "individualni" ? "DLE KOMPONENT" : "—"
    : booth.status === "missing"
      ? "K nacenění"
      : booth.status === "included"
        ? "v ceně"
        : `${money(booth.totalNet ?? 0, currency)} bez DPH`;
  return (
    <div className="configuratorBottomBar">
      <div className="pricingInfo">
        <div>
          <span>CENA KONSTRUKCE</span>
          <strong className={booth?.status === "missing" ? "pricingMissing" : undefined}>{boothLabel}</strong>
        </div>
        <div>
          <span>ÚPRAVY KONSTRUKCE</span>
          <strong>cenu nemění</strong>
        </div>
        <div>
          <span>MOBILIÁŘ</span>
          <strong>{furniture.count} položek · {money(furniture.net, currency)}{furniture.missing ? <em className="pricingMissing"> · {furniture.missing} k nacenění</em> : null}</strong>
        </div>
        <div>
          <span>SLUŽBY A GRAFIKA</span>
          <strong>{money(services.net, currency)}{services.missing ? <em className="pricingMissing"> · {services.missing} k nacenění</em> : null}</strong>
        </div>
        <div>
          <span>{pricing.missingCount ? "MEZISOUČET — NEÚPLNÉ" : "CELKEM"}</span>
          <strong title={pricing.missingCount ? "Mezisoučet oceněných položek; položky k nacenění nejsou zahrnuty — nejde o konečnou cenu." : undefined}>
            {money(pricing.totals.net, currency)} bez DPH · {money(pricing.totals.gross, currency)} s DPH
            {pricing.missingCount ? <em className="pricingMissing"> · {pricing.missingCount} k nacenění</em> : null}
          </strong>
        </div>
      </div>
    </div>
  );
}
