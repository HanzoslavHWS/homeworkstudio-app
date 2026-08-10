type PricingBarProps = {
  placedItemCount: number;
};

export function PricingBar({ placedItemCount }: PricingBarProps) {
  return (
    <div className="configuratorBottomBar">
      <div className="pricingInfo">
        <div>
          <span>CENA KONSTRUKCE</span>
          <strong>FIXNÍ TYPOVKA</strong>
        </div>
        <div>
          <span>ÚPRAVY KONSTRUKCE</span>
          <strong>cenu nemění</strong>
        </div>
        <div>
          <span>MOBILIÁŘ</span>
          <strong>{placedItemCount} položek</strong>
        </div>
      </div>

      <button className="primaryButton" disabled>
        Pokračovat na vizualizaci
        <span>→</span>
      </button>
    </div>
  );
}
