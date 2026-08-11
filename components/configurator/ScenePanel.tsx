import { useState } from "react";
import type {
  BoothType,
  BoothVariant,
  FinishVariant,
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
  carpetVariants?: readonly FinishVariant[];
  carpetFinishId?: string;
  onCarpetFinishChange?: (finishId: string) => void;
  onSelectComponent: (componentId: string) => void;
  onSelectConstructionPart: (partId: string) => void;
  onToggleComponentLock: (componentId: string) => void;
  onToggleConstructionLock: (partId: string) => void;
  onToggleComponentVisibility: (componentId: string) => void;
  onToggleConstructionVisibility: (partId: string) => void;
};

type SceneItemProps = {
  kind: "construction" | "overhead" | "furniture" | "floor";
  label: string;
  selected: boolean;
  visible: boolean;
  systemLocked: boolean;
  userLocked: boolean;
  nested?: boolean;
  visibilityDisabled?: boolean;
  onSelect: () => void;
  onToggleVisibility: () => void;
  onToggleLock: () => void;
};

function Icon({ kind }: { kind: SceneItemProps["kind"] }) {
  if (kind === "furniture") return <svg viewBox="0 0 24 24"><rect x="5" y="6" width="14" height="12" rx="2" /><path d="M8 18v2M16 18v2" /></svg>;
  if (kind === "floor") return <svg viewBox="0 0 24 24"><path d="m4 16 8-9 8 9-8 4-8-4Z" /><path d="m7 14 5 2.5 5-2.5" /></svg>;
  if (kind === "overhead") return <svg viewBox="0 0 24 24"><path d="M4 8h16M5 16h14" /><path d="M7 8v8M12 8v8M17 8v8" strokeDasharray="2 2" /></svg>;
  return <svg viewBox="0 0 24 24"><path d="M5 19V5h14M5 9h10v10" /></svg>;
}

function Eye({ off = false }: { off?: boolean }) {
  return <svg viewBox="0 0 24 24">{off ? <><path d="M4.2 7.8C2.9 9.2 2.5 12 2.5 12s3.5 6 9.5 6c1.6 0 3-.4 4.2-1M8.2 6.7C9.3 6.2 10.6 6 12 6c6 0 9.5 6 9.5 6s-.7 1.2-2 2.5M4 4l16 16" /></> : <><path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z" /><circle cx="12" cy="12" r="2.7" /></>}</svg>;
}

function Lock({ open = false }: { open?: boolean }) {
  return <svg viewBox="0 0 24 24"><rect x="5" y="10" width="14" height="10" rx="2" /><path d={open ? "M16 10V7a4 4 0 0 0-7.7-1.5" : "M8 10V7a4 4 0 0 1 8 0v3"} /></svg>;
}

function SceneItem(props: SceneItemProps) {
  const locked = props.systemLocked || props.userLocked;
  return <div className={`sceneItem ${props.selected ? "active" : ""} ${props.nested ? "nested" : ""} ${props.visible ? "visible" : "hidden"}`}>
    <span className="sceneTypeIcon"><Icon kind={props.kind} /></span>
    <button type="button" className="sceneSelect" onClick={props.onSelect} title={props.label}>{props.label}</button>
    <div className="sceneActions">
      <button type="button" className="sceneActionButton" disabled={props.visibilityDisabled} onClick={(event) => { event.stopPropagation(); props.onToggleVisibility(); }} title={props.visibilityDisabled ? "Viditelnost části bude dostupná po mapování GLB nodů" : props.visible ? "Skrýt prvek" : "Zobrazit prvek"}><Eye off={!props.visible} /></button>
      <button type="button" className="sceneActionButton" disabled={props.systemLocked} onClick={(event) => { event.stopPropagation(); props.onToggleLock(); }} title={props.systemLocked ? "Systémově zamčeno" : locked ? "Odemknout" : "Zamknout"}><Lock open={!locked} /></button>
    </div>
  </div>;
}

function TreeHeader({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return <button type="button" className="sceneTreeHeader" onClick={onToggle}><span>{open ? "▾" : "▸"}</span><strong>{label}</strong></button>;
}

export function ScenePanel(props: ScenePanelProps) {
  const [openGroups, setOpenGroups] = useState({ construction: true, overhead: true, floor: true, furniture: true });
  const toggle = (key: keyof typeof openGroups) => setOpenGroups((value) => ({ ...value, [key]: !value[key] }));
  const assemblyName = props.variant ? `${props.booth.name} / ${props.variant.name}` : props.booth.name;
  const groups = groupConstructionParts(props.booth.constructionParts);
  const assemblyVisible = props.constructionVisibility.assembly ?? props.booth.visible;
  const perPartVisibilityAvailable = Boolean(props.booth.partDefinitions?.length);

  return <div className="scenePanel">
    <span className="propertySectionTitle">SCÉNA</span>
    <div className="sceneTreeGroup">
      <TreeHeader label="Konstrukce" open={openGroups.construction} onToggle={() => toggle("construction")} />
      {openGroups.construction && <div className="sceneTreeChildren">
        <SceneItem kind="construction" label={assemblyName} selected={props.selectedConstructionPartId === "assembly"} visible={assemblyVisible} systemLocked={props.booth.systemLocked} userLocked={props.constructionUserLocks.assembly ?? props.booth.userLocked} onSelect={() => props.onSelectConstructionPart("assembly")} onToggleVisibility={() => props.onToggleConstructionVisibility("assembly")} onToggleLock={() => props.onToggleConstructionLock("assembly")} />
        {groups.ground.map((part) => <SceneItem key={part.id} nested kind="construction" label={part.name} selected={props.selectedConstructionPartId === part.id} visible={props.constructionVisibility[part.id] ?? part.visible} systemLocked={part.systemLocked} userLocked={props.constructionUserLocks[part.id] ?? part.userLocked} visibilityDisabled={!perPartVisibilityAvailable} onSelect={() => props.onSelectConstructionPart(part.id)} onToggleVisibility={() => props.onToggleConstructionVisibility(part.id)} onToggleLock={() => props.onToggleConstructionLock(part.id)} />)}
        {groups.overhead.length > 0 && <div className="sceneNestedGroup">
          <TreeHeader label="Horní konstrukce" open={openGroups.overhead} onToggle={() => toggle("overhead")} />
          {openGroups.overhead && groups.overhead.map((part) => <SceneItem key={part.id} nested kind="overhead" label={part.name} selected={props.selectedConstructionPartId === part.id} visible={props.constructionVisibility[part.id] ?? part.visible} systemLocked={part.systemLocked} userLocked={props.constructionUserLocks[part.id] ?? part.userLocked} visibilityDisabled={!perPartVisibilityAvailable} onSelect={() => props.onSelectConstructionPart(part.id)} onToggleVisibility={() => props.onToggleConstructionVisibility(part.id)} onToggleLock={() => props.onToggleConstructionLock(part.id)} />)}
        </div>}
      </div>}
    </div>
    <div className="sceneTreeGroup">
      <TreeHeader label="Podlaha" open={openGroups.floor} onToggle={() => toggle("floor")} />
      {openGroups.floor && <div className="sceneFloorControl"><span className="sceneTypeIcon"><Icon kind="floor" /></span><label><span>Koberec</span><select value={props.carpetFinishId ?? "none"} onChange={(event) => props.onCarpetFinishChange?.(event.target.value)}>{props.carpetVariants?.map((variant) => <option key={variant.id} value={variant.id}>{variant.name}</option>)}</select></label></div>}
    </div>
    <div className="sceneTreeGroup">
      <TreeHeader label="Mobiliář" open={openGroups.furniture} onToggle={() => toggle("furniture")} />
      {openGroups.furniture && <div className="sceneTreeChildren">{props.components.length === 0 ? <span className="sceneEmpty">Žádné vložené prvky</span> : props.components.map((component, index) => {
        const number = props.components.slice(0, index + 1).filter((item) => item.sceneLabel === component.sceneLabel).length;
        return <SceneItem key={component.id} kind="furniture" label={`${component.sceneLabel} ${String(number).padStart(2, "0")}`} selected={props.selectedComponentId === component.id} visible={component.visible} systemLocked={component.systemLocked} userLocked={component.userLocked} onSelect={() => props.onSelectComponent(component.id)} onToggleVisibility={() => props.onToggleComponentVisibility(component.id)} onToggleLock={() => props.onToggleComponentLock(component.id)} />;
      })}</div>}
    </div>
  </div>;
}
