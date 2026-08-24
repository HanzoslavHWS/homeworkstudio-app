import { componentCatalogItems } from "../../data/components";
import { calculateNetVatGross } from "../../domain/pricing";
import type { BoothType, Currency, PlacedComponent, ProjectType } from "../../domain/models";
import { getBasePricingEntry } from "../../domain/catalog";

type PricingBarProps = {
  booth?: BoothType;
  placedItems: readonly PlacedComponent[];
  currency: Currency;
  projectType?: ProjectType;
};

export function PricingBar({ booth, placedItems, currency, projectType }: PricingBarProps) {
  const boothNet = getBasePricingEntry(booth?.pricingEntries, currency)?.salePrice ?? 0;
  const furnitureNet = placedItems.reduce((sum, item) => {
    const definition = componentCatalogItems.find((candidate) => candidate.id === item.definitionId);
    return sum + (getBasePricingEntry(definition?.pricingEntries, currency)?.salePrice ?? 0);
  }, 0);
  const totals = calculateNetVatGross(boothNet + furnitureNet);
  // Report section 45: an Individual booth has no single fixed booth-level price (it's built from
  // individually-priced components) — "FIXNÍ TYPOVKA" is a typovka-only concept and was
  // semantically wrong here. This session doesn't implement Individual pricing (out of scope);
  // only the wording changes — typovka's own fallback text is untouched.
  const unpricedLabel = projectType === "individualni" ? "DLE KOMPONENT" : "FIXNÍ TYPOVKA";
  return (
    <div className="configuratorBottomBar">
      <div className="pricingInfo">
        <div>
          <span>CENA KONSTRUKCE</span>
          <strong>{boothNet ? `${boothNet.toLocaleString("cs-CZ")} ${currency} bez DPH` : unpricedLabel}</strong>
        </div>
        <div>
          <span>ÚPRAVY KONSTRUKCE</span>
          <strong>cenu nemění</strong>
        </div>
        <div>
          <span>MOBILIÁŘ</span>
          <strong>{placedItems.length} položek · {furnitureNet.toLocaleString("cs-CZ")} {currency}</strong>
        </div>
        <div>
          <span>CELKEM</span>
          <strong>{totals.net.toLocaleString("cs-CZ")} bez DPH · {totals.gross.toLocaleString("cs-CZ")} s DPH</strong>
        </div>
      </div>
    </div>
  );
}
