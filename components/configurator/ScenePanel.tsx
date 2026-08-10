import type {
  BoothType,
  BoothVariant,
  PlacedComponent,
} from "../../domain/models";
import { groupConstructionParts } from "../../domain/construction";

type ScenePanelProps = {
  booth: BoothType;
  variant?: BoothVariant;
  components: readonly PlacedComponent[];
  constructionUserLocks: Readonly<Record<string, boolean>>;
  constructionVisibility: Readonly<Record<string, boolean>>;
  selectedComponentId: string | null;
  selectedConstructionPartId: string | null;
  onSelectComponent: (componentId: string) => void;
  onSelectConstructionPart: (partId: string) => void;
  onToggleComponentLock: (componentId: string) => void;
  onToggleConstructionLock: (partId: string) => void;
  onToggleComponentVisibility: (componentId: string) => void;
  onToggleConstructionVisibility: (partId: string) => void;
};

type SceneItemProps = {
  kind: "construction" | "overhead" | "furniture";
  label: string;
  selected: boolean;
  visible: boolean;
  systemLocked: boolean;
  userLocked: boolean;
  onSelect: () => void;
  onToggleVisibility: () => void;
  onToggleLock: () => void;
};

type IconProps = {
  className?: string;
};

function EyeIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" />
      <circle cx="12" cy="12" r="2.7" />
    </svg>
  );
}

function EyeOffIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4.2 7.8C2.9 9.2 2.5 12 2.5 12s3.5 6 9.5 6c1.6 0 3-.4 4.2-1" />
      <path d="M8.2 6.7C9.3 6.2 10.6 6 12 6c6 0 9.5 6 9.5 6s-.7 1.2-2 2.5" />
      <path d="M4 4l16 16" />
    </svg>
  );
}

function LockClosedIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M8 10V7a4 4 0 0 1 8 0v3" />
    </svg>
  );
}

function LockOpenIcon({ className }: IconProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="10" width="14" height="10" rx="2" />
      <path d="M16 10V7a4 4 0 0 0-7.7-1.5" />
    </svg>
  );
}

function TypeIcon({ kind, className }: IconProps & { kind: SceneItemProps["kind"] }) {
  if (kind === "construction") {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M5 19V5h14" />
        <path d="M5 9h10v10" />
      </svg>
    );
  }

  if (kind === "overhead") {
    return (
      <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M4 8h16M5 16h14" />
        <path d="M7 8v8M12 8v8M17 8v8" strokeDasharray="2 2" />
      </svg>
    );
  }

  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <rect x="5" y="6" width="14" height="12" rx="2" />
      <path d="M8 18v2M16 18v2" />
    </svg>
  );
}

function SceneItem({
  kind,
  label,
  selected,
  visible,
  systemLocked,
  userLocked,
  onSelect,
  onToggleVisibility,
  onToggleLock,
}: SceneItemProps) {
  const locked = systemLocked || userLocked;
  const lockStateClass = systemLocked
    ? "systemLocked"
    : userLocked
      ? "userLocked"
      : "unlocked";
  const lockLabel = systemLocked
    ? "Systémově zamčeno"
    : userLocked
      ? "Odemknout prvek"
      : "Zamknout prvek";

  return (
    <div
      className={[
        "sceneItem",
        selected ? "active" : "",
        visible ? "visible" : "hidden",
        lockStateClass,
      ].filter(Boolean).join(" ")}
    >
      <span className="sceneTypeIcon">
        <TypeIcon kind={kind} className="sceneSvgIcon" />
      </span>
      <button
        type="button"
        className="sceneSelect"
        onClick={onSelect}
        title={label}
      >
        {label}
      </button>
      <div className="sceneActions">
        <button
          type="button"
          className="sceneActionButton sceneVisibilityButton"
          onClick={(event) => {
            event.stopPropagation();
            onToggleVisibility();
          }}
          aria-pressed={visible}
          aria-label={visible ? "Skrýt prvek" : "Zobrazit prvek"}
          title={visible ? "Skrýt prvek" : "Zobrazit prvek"}
        >
          {visible
            ? <EyeIcon className="sceneSvgIcon" />
            : <EyeOffIcon className="sceneSvgIcon" />}
        </button>
        <button
          type="button"
          className="sceneActionButton sceneLockButton"
          onClick={(event) => {
            event.stopPropagation();
            onToggleLock();
          }}
          disabled={systemLocked}
          aria-pressed={locked}
          aria-label={lockLabel}
          title={lockLabel}
        >
          {locked
            ? <LockClosedIcon className="sceneSvgIcon" />
            : <LockOpenIcon className="sceneSvgIcon" />}
        </button>
      </div>
    </div>
  );
}

export function ScenePanel({
  booth,
  variant,
  components,
  constructionUserLocks,
  constructionVisibility,
  selectedComponentId,
  selectedConstructionPartId,
  onSelectComponent,
  onSelectConstructionPart,
  onToggleComponentLock,
  onToggleConstructionLock,
  onToggleComponentVisibility,
  onToggleConstructionVisibility,
}: ScenePanelProps) {
  const assemblyName = variant
    ? `${booth.name} / ${variant.name}`
    : booth.name;
  const constructionGroups = groupConstructionParts(booth.constructionParts);

  return (
    <div className="scenePanel">
      <span className="propertySectionTitle">SCÉNA</span>

      <div className="sceneGroup">
        <strong>Konstrukce</strong>
        <SceneItem
          kind="construction"
          label={assemblyName}
          selected={selectedConstructionPartId === "assembly"}
          visible={constructionVisibility.assembly ?? booth.visible}
          systemLocked={booth.systemLocked}
          userLocked={constructionUserLocks.assembly ?? booth.userLocked}
          onSelect={() => onSelectConstructionPart("assembly")}
          onToggleVisibility={() => onToggleConstructionVisibility("assembly")}
          onToggleLock={() => onToggleConstructionLock("assembly")}
        />
        {constructionGroups.ground.map((part) => (
          <SceneItem
            key={part.id}
            kind="construction"
            label={part.name}
            selected={selectedConstructionPartId === part.id}
            visible={constructionVisibility[part.id] ?? part.visible}
            systemLocked={part.systemLocked}
            userLocked={constructionUserLocks[part.id] ?? part.userLocked}
            onSelect={() => onSelectConstructionPart(part.id)}
            onToggleVisibility={() => onToggleConstructionVisibility(part.id)}
            onToggleLock={() => onToggleConstructionLock(part.id)}
          />
        ))}
      </div>

      {constructionGroups.overhead.length > 0 && (
        <div className="sceneGroup sceneOverheadGroup">
          <strong>Horní konstrukce</strong>
          {constructionGroups.overhead.map((part) => (
            <SceneItem
              key={part.id}
              kind="overhead"
              label={part.name}
              selected={selectedConstructionPartId === part.id}
              visible={constructionVisibility[part.id] ?? part.visible}
              systemLocked={part.systemLocked}
              userLocked={constructionUserLocks[part.id] ?? part.userLocked}
              onSelect={() => onSelectConstructionPart(part.id)}
              onToggleVisibility={() => onToggleConstructionVisibility(part.id)}
              onToggleLock={() => onToggleConstructionLock(part.id)}
            />
          ))}
        </div>
      )}

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
              <SceneItem
                key={component.id}
                kind="furniture"
                label={label}
                selected={selectedComponentId === component.id}
                visible={component.visible}
                systemLocked={component.systemLocked}
                userLocked={component.userLocked}
                onSelect={() => onSelectComponent(component.id)}
                onToggleVisibility={() => onToggleComponentVisibility(component.id)}
                onToggleLock={() => onToggleComponentLock(component.id)}
              />
            );
          })
        )}
      </div>
    </div>
  );
}
