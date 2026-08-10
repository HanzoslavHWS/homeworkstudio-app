type ComponentLibraryProps = {
  onAddCabinet: () => void;
  onAddChair: () => void;
};

export function ComponentLibrary({
  onAddCabinet,
  onAddChair,
}: ComponentLibraryProps) {
  return (
    <aside className="componentLibrary">
      <div className="panelHeader">
        <span>KOMPONENTY</span>
        <strong>Knihovna</strong>
      </div>

      <div className="librarySection">
        <span className="libraryTitle">TEST MOBILIÁŘE</span>

        <button className="libraryItem" onClick={onAddCabinet}>
          <span className="libraryItemIcon cabinetIcon">▭</span>
          <span className="libraryItemText">
            <strong>Skříňka</strong>
            <small>800 × 400 mm</small>
            <em>rotace po 90°</em>
          </span>
          <span className="libraryAdd">+</span>
        </button>

        <button className="libraryItem" onClick={onAddChair}>
          <span className="libraryItemIcon chairIcon">◇</span>
          <span className="libraryItemText">
            <strong>Židle</strong>
            <small>450 × 500 mm</small>
            <em>volná rotace</em>
          </span>
          <span className="libraryAdd">+</span>
        </button>

        <p className="libraryHint">
          Zatím testujeme ovládání. Později sem připojíme přesné CAD komponenty 1:1.
        </p>
      </div>

      <div className="librarySection">
        <span className="libraryTitle">PŘIPRAVUJEME</span>
        <div className="futureLibraryList">
          <span>Vitríny</span>
          <span>Pulty</span>
          <span>Stoly</span>
          <span>Židle</span>
          <span>Barovky</span>
          <span>Police</span>
          <span>Elektro</span>
        </div>
      </div>
    </aside>
  );
}
