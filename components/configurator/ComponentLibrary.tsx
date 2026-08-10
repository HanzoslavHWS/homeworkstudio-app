import { componentCatalogItems } from "../../data/components";
import type { ComponentDefinition } from "../../domain/models";

type ComponentLibraryProps = {
  onAddComponent: (definition: ComponentDefinition) => void;
};

export function ComponentLibrary({
  onAddComponent,
}: ComponentLibraryProps) {
  return (
    <aside className="componentLibrary">
      <div className="panelHeader">
        <span>KOMPONENTY</span>
        <strong>Knihovna</strong>
      </div>

      <div className="librarySection">
        <span className="libraryTitle">MOBILIÁŘ</span>

        {componentCatalogItems.map((definition) => (
          <button
            key={definition.id}
            className="libraryItem"
            onClick={() => onAddComponent(definition)}
          >
            <span
              className={
                definition.type === "chair"
                  ? "libraryItemIcon chairIcon"
                  : "libraryItemIcon cabinetIcon"
              }
            >
              {definition.type === "chair" ? "◇" : "▭"}
            </span>
            <span className="libraryItemText">
              <strong>{definition.name}</strong>
              <small>
                {definition.widthMm} × {definition.depthMm} mm
              </small>
              <em>
                {definition.assets?.models3d?.length
                  ? "CAD model 1:1"
                  : "2D testovací prvek"}
              </em>
            </span>
            <span className="libraryAdd">+</span>
          </button>
        ))}

        <p className="libraryHint">
          Položky s CAD modelem používají stejné projektové souřadnice v 2D i 3D.
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
