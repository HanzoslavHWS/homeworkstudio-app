import { componentCatalogItems } from "../../data/components";
import { calculateNetVatGross } from "../../domain/pricing";
import type { BoothType, Currency, PlacedComponent } from "../../domain/models";

type PricingBarProps = {
  booth?: BoothType;
  placedItems: readonly PlacedComponent[];
  currency: Currency;
};

export function PricingBar({ booth, placedItems, currency }: PricingBarProps) {
  const boothNet = booth?.pricingEntries?.find((entry) => entry.currency === currency && !entry.exhibitionId && !entry.priceListId)?.salePrice ?? 0;
  const furnitureNet = placedItems.reduce((sum, item) => {
    const definition = componentCatalogItems.find((candidate) => candidate.id === item.definitionId);
    return sum + (definition?.pricingEntries?.find((entry) => entry.currency === currency && !entry.exhibitionId && !entry.priceListId)?.salePrice ?? 0);
  }, 0);
  const totals = calculateNetVatGross(boothNet + furnitureNet);
  return (
    <div className="configuratorBottomBar">
      <div className="pricingInfo">
        <div>
          <span>CENA KONSTRUKCE</span>
          <strong>{boothNet ? `${boothNet.toLocaleString("cs-CZ")} ${currency} bez DPH` : "FIXNÍ TYPOVKA"}</strong>
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
