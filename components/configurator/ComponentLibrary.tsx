import { useState } from "react";
import { componentCatalogItems } from "../../data/components";
import {
  categoryOptions,
  filterCatalogCategory,
} from "../../domain/catalogCategories";
import type { ComponentDefinition } from "../../domain/models";
import type { OrderInventoryItem } from "../../domain/order";
import { matchesCatalogSearch } from "../../domain/search";
import { catalogDisplayName } from "../../domain/catalog";

type Props = {
  onAddComponent: (definition: ComponentDefinition) => void;
  inventory?: readonly OrderInventoryItem[];
};

function SectionHeader({ label, open, onToggle }: { label: string; open: boolean; onToggle: () => void }) {
  return <button type="button" className="librarySectionHeader" onClick={onToggle}><span>{open ? "▾" : "▸"}</span><strong>{label}</strong></button>;
}

export function ComponentLibrary({ onAddComponent, inventory = [] }: Props) {
  const [open, setOpen] = useState({ inventory: true, furniture: true, technical: false });
  const [category, setCategory] = useState("");
  const [query, setQuery] = useState("");
  const activeItems = componentCatalogItems.filter((item) => item.active !== false && item.catalogItemType !== "service");
  const physical = activeItems.filter((item) => item.sceneLayer === "furniture");
  const technical = activeItems.filter((item) => item.sceneLayer !== "furniture");
  const categories = categoryOptions(physical);
  const furniture = filterCatalogCategory(physical, category).filter((item) => matchesCatalogSearch(item, query));
  const toggle = (key: keyof typeof open) => setOpen((value) => ({ ...value, [key]: !value[key] }));

  const renderItem = (definition: ComponentDefinition) => <button key={definition.id} className="libraryItem" onClick={() => onAddComponent(definition)}>
    <span className={`libraryItemIcon ${definition.sceneLayer !== "furniture" ? "technicalIcon" : definition.type === "chair" ? "chairIcon" : "cabinetIcon"}`}>{definition.footprint2D?.symbol ?? (definition.type === "chair" ? "◇" : "▭")}</span>
    <span className="libraryItemText"><strong>{catalogDisplayName(definition)}</strong><small>{definition.internalCode ? `Kód: ${definition.internalCode} · ` : ""}{definition.widthMm} × {definition.depthMm} mm</small><em>{definition.showIn3D ? "CAD model 1:1" : definition.sceneLayer !== "furniture" ? "Pouze 2D technická vrstva" : "2D prvek"}</em></span><span className="libraryAdd">+</span>
  </button>;

  return <aside className="componentLibrary">
    <div className="panelHeader"><span>KOMPONENTY</span><strong>Knihovna</strong></div>
    <div className="librarySection collapsibleLibrarySection">
      <SectionHeader label="Zásobník objednávky" open={open.inventory} onToggle={() => toggle("inventory")} />
      {open.inventory && (inventory.length === 0 ? <p className="libraryHint">Zatím není importovaná objednávka.</p> : <div className="orderInventoryList">{inventory.map((item) => <div className={`orderInventoryItem ${item.status}`} key={item.catalogItemId}><strong>{item.name}</strong><span>Objednávka: {item.ordered}</span><span>Model: {item.placed}</span><span>{item.status === "complete" ? "OK" : item.status === "over" ? `Navíc: ${item.extra}` : `Chybí: ${item.remaining}`}</span>{item.remaining > 0 && <button type="button" onClick={() => { const definition = activeItems.find((entry) => entry.id === item.catalogItemId); if (definition) onAddComponent(definition); }}>Vložit</button>}</div>)}</div>)}
    </div>
    <div className="librarySection collapsibleLibrarySection">
      <SectionHeader label="Mobiliář" open={open.furniture} onToggle={() => toggle("furniture")} />
      {open.furniture && <><input className="librarySearch" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat v katalogu…" /><div className="libraryCategoryTabs"><button className={!category ? "active" : ""} onClick={() => setCategory("")}>Vše</button>{categories.map((item) => <button key={item.id} className={category === item.id ? "active" : ""} onClick={() => setCategory(item.id)}>{item.name}</button>)}</div>{furniture.length ? furniture.map(renderItem) : <p className="libraryHint">V této kategorii nejsou položky.</p>}</>}
    </div>
    <div className="librarySection collapsibleLibrarySection">
      <SectionHeader label="Technické body · 2D" open={open.technical} onToggle={() => toggle("technical")} />
      {open.technical && technical.map(renderItem)}
    </div>
  </aside>;
}
