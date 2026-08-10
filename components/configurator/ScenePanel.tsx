import type {
  BoothType,
  BoothVariant,
  PlacedComponent,
} from "../../domain/models";

type ScenePanelProps = {
  booth: BoothType;
  variant?: BoothVariant;
  components: readonly PlacedComponent[];
  selectedComponentId: string | null;
  selectedConstructionPartId: string | null;
  onSelectComponent: (componentId: string) => void;
  onSelectConstructionPart: (partId: string) => void;
};

export function ScenePanel({
  booth,
  variant,
  components,
  selectedComponentId,
  selectedConstructionPartId,
  onSelectComponent,
  onSelectConstructionPart,
}: ScenePanelProps) {
  const assemblyName = variant
    ? `${booth.name} / ${variant.name}`
    : booth.name;

  return (
    <div className="scenePanel">
      <span className="propertySectionTitle">SCÉNA</span>

      <div className="sceneGroup">
        <strong>Konstrukce</strong>
        <button
          className={selectedConstructionPartId === "assembly" ? "sceneItem active" : "sceneItem"}
          onClick={() => onSelectConstructionPart("assembly")}
        >
          {assemblyName}
        </button>
        {booth.constructionParts.map((part) => (
          <button
            key={part.id}
            className={selectedConstructionPartId === part.id ? "sceneItem active" : "sceneItem"}
            onClick={() => onSelectConstructionPart(part.id)}
          >
            {part.name}
          </button>
        ))}
      </div>

      <div className="sceneGroup">
        <strong>Mobiliář</strong>
        {components.length === 0 ? (
          <span className="sceneEmpty">Žádné vložené prvky</span>
        ) : (
          components.map((component, componentIndex) => {
            const number = components
              .slice(0, componentIndex + 1)
              .filter((item) => item.sceneLabel === component.sceneLabel).length;
            const label = `${component.sceneLabel} ${String(number).padStart(2, "0")}`;

            return (
              <button
                key={component.id}
                className={selectedComponentId === component.id ? "sceneItem active" : "sceneItem"}
                onClick={() => onSelectComponent(component.id)}
              >
                {label}
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}
