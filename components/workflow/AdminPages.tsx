import { useState } from "react";
import type { BoothType, ComponentDefinition, PricingEntry } from "../../domain/models";
import type { ProjectRecord } from "../../domain/project";
import type { ProjectStage } from "../../domain/project";
import {
  filterProjects,
  matchesBoothSearch,
  matchesCatalogSearch,
} from "../../domain/search";
import { placeComponent } from "../../data/components";
import { getComponentModel, getMasterReferenceModel } from "../../domain/cad3d";
import {
  calculateMarginDelta,
  calculateNetVatGross,
  pricingPolicyFor,
} from "../../domain/pricing";
import {
  catalogImageAsset,
  catalogDisplayName,
  catalogImageUrl,
  getBasePricingEntry,
} from "../../domain/catalog";
import { useAssetUrl } from "../../hooks/useAssetUrl";
import { BoothCadPlanView } from "../configurator/BoothCadPlanView";
import { BoothCadViewer } from "../configurator/BoothCadViewer";
import {
  categoryOptions,
  filterCatalogCategory,
} from "../../domain/catalogCategories";

type ProjectsProps = {
  projects: readonly ProjectRecord[];
  fairName: (id: string) => string;
  boothName: (id: string) => string;
  onOpen: (project: ProjectRecord) => void;
  onDelete: (id: string) => void;
  onNew: () => void;
};

export function ProjectsPage({ projects, fairName, boothName, onOpen, onDelete, onNew }: ProjectsProps) {
  const [query, setQuery] = useState("");
  const [fairId, setFairId] = useState("");
  const [stage, setStage] = useState<ProjectStage | "">("");
  const [action, setAction] = useState<"" | "yes" | "no">("");
  const [mode, setMode] = useState<ProjectRecord["mode"] | "">("");
  const filtered = filterProjects(projects, {
    query,
    fairId,
    stage,
    requiresAction: action,
    mode,
    fairName,
    boothName,
  });
  const fairIds = [...new Set(projects.map((project) => project.fairId).filter(Boolean))];
  const grouped = filtered.reduce((result, project) => {
    const key = project.fairId || "without-fair";
    const group = result.get(key) ?? [];
    group.push(project);
    result.set(key, group);
    return result;
  }, new Map<string, ProjectRecord[]>());
  return (
    <div className="workspacePage">
      <div className="workspacePageHeader">
        <div><span className="eyebrow">PROJEKTY</span><h1>Uložené projekty</h1></div>
        <button className="primaryButton" type="button" onClick={onNew}>Nový projekt</button>
      </div>
      <div className="adminFilters projectFilters">
        <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat firmu, projekt, stánek, výstavu nebo kontakt…" />
        <select value={fairId} onChange={(event) => setFairId(event.target.value)}><option value="">Všechny výstavy</option>{fairIds.map((id) => <option key={id} value={id}>{fairName(id)}</option>)}</select>
        <select value={stage} onChange={(event) => setStage(event.target.value as ProjectStage | "")}><option value="">Všechny stavy</option><option value="quote">Nabídka / Kalkulace</option><option value="design">Návrh</option><option value="approved">Odsouhlaseno</option><option value="done">Hotovo</option></select>
        <select value={action} onChange={(event) => setAction(event.target.value as typeof action)}><option value="">Akce: vše</option><option value="yes">Vyžaduje naši akci</option><option value="no">Bez naší akce</option></select>
        <select value={mode} onChange={(event) => setMode(event.target.value as typeof mode)}><option value="">Všechny režimy</option><option value="proposal">Návrh / kalkulace</option><option value="order">Objednávka</option><option value="production">Realizace</option></select>
      </div>
      {projects.length === 0 ? <p className="workspaceEmpty">Zatím není uložený žádný projekt.</p> : filtered.length === 0 ? <p className="workspaceEmpty">Filtrům neodpovídá žádný projekt.</p> :
        [...grouped].map(([fairId, group]) => (
          <section className="adminGroup" key={fairId}>
            <h2>{fairId === "without-fair" ? "Bez veletrhu" : fairName(fairId)}</h2>
            <div className="adminTable projectAdminTable">
              {group.map((project) => (
                <details className="projectListItem" key={project.id}>
                  <summary className="adminTableRow projectPrimaryRow">
                    <div><strong>{project.company || project.name}</strong><span>{project.name}</span></div>
                    <span>{fairName(project.fairId)}</span>
                    <span>{boothName(project.boothId) || project.boothNumber || "—"}</span>
                    <strong className={`stageBadge ${project.stage}`}>{stageLabel(project.stage)}</strong>
                    <time>{new Date(project.modifiedAt).toLocaleString("cs-CZ")}</time>
                  </summary>
                  <div className="projectExpandedDetail">
                    <div className="projectStatusGrid">
                      <ProjectStatus label="Grafika límce" value={project.technicalRequirements.fasciaGraphics.status} />
                      <ProjectStatus label="Elektro" value={project.technicalRequirements.electricity.status} />
                      <ProjectStatus label="Voda" value={project.technicalRequirements.water.status} />
                      <ProjectStatus label="Odpad" value={project.technicalRequirements.waste.status} />
                      <ProjectStatus label="Zákazník" value={project.waitingForCustomer ? "Čekáme" : "Nečeká"} />
                      <ProjectStatus label="Naše akce" value={project.requiresAction ? "Vyžadována" : "Bez akce"} />
                    </div>
                    <div className="projectExpandedNotes"><span>Interní poznámka</span><p>{project.notes.internalNote || "Bez interní poznámky."}</p></div>
                    <div className="projectExpandedMeta"><span>Kontakt: {project.contact.name || "—"} · {project.contact.phone || "—"} · {project.contact.email || "—"}</span><span>Nevyřešené řádky: {project.importedOrder?.lines.filter((line) => line.mappingStatus === "unresolved").length ?? 0}</span></div>
                    <div className="projectExpandedNotes"><span>Technické poznámky</span><p>{[project.technicalRequirements.electricity.note, project.technicalRequirements.water.note, project.technicalRequirements.waste.note, project.technicalRequirements.fasciaGraphics.note, project.technicalRequirements.fullWrapGraphics.note, project.technicalRequirements.cleaning.note, project.technicalRequirements.container.note].filter(Boolean).join(" · ") || "Bez technických poznámek."}</p></div>
                    <div className="projectRowActions"><button type="button" onClick={() => onOpen(project)}>Otevřít projekt</button><button type="button" className="dangerText" onClick={() => onDelete(project.id)}>Smazat</button></div>
                    <div className="futureAccess"><strong>Sdílení a práva</strong><span>Budoucí owner/member oprávnění · vyžaduje uživatelské účty</span><button disabled>Spravovat přístupy</button></div>
                  </div>
                </details>
              ))}
            </div>
          </section>
        ))}
    </div>
  );
}

export function BoothCatalogPage({ booths }: { booths: readonly BoothType[] }) {
  const [localBooths, setLocalBooths] = useState<BoothType[]>([]);
  const allBooths = [...booths, ...localBooths];
  const [selectedId, setSelectedId] = useState(booths[0]?.id ?? "");
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");
  const [activeFilter, setActiveFilter] = useState<"all" | "active" | "inactive">("all");
  const booth = allBooths.find((item) => item.id === selectedId);
  return (
    <div className="workspacePage">
      <div className="workspacePageHeader"><div><span className="eyebrow">ADMINISTRACE</span><h1>Stánky</h1></div><button className="primaryButton" onClick={() => setShowForm(!showForm)}>+ Přidat stánek</button></div>
      <div className="adminFilters"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat kód, název, rozměr nebo typ…" /><select value={activeFilter} onChange={(event) => setActiveFilter(event.target.value as typeof activeFilter)}><option value="all">Aktivní i neaktivní</option><option value="active">Aktivní</option><option value="inactive">Neaktivní</option></select></div>
      {showForm && <MetadataForm kind="booth" onSubmit={(draft) => {
        const id = `booth-${Date.now()}`;
        const widthMm = numberOrNull(draft.widthMm);
        const depthMm = numberOrNull(draft.depthMm);
        const heightMm = numberOrNull(draft.heightMm);
        const created: BoothType = {
          id,
          code: draft.code,
          internalCode: draft.code,
          name: draft.name,
          description: draft.description,
          projectType: "typovy",
          size: widthMm && depthMm ? `${widthMm} × ${depthMm} mm` : "—",
          area: "—",
          widthMm,
          depthMm,
          heightMm,
          collarHeightMm: null,
          profileWidthMm: null,
          configReady: false,
          systemLocked: true,
          userLocked: false,
          visible: true,
          active: true,
          thumbnailUrl: draft.thumbnailUrl || undefined,
          photoUrl: draft.photoUrl || undefined,
          sketchupUrl: draft.sketchupUrl || undefined,
          variants: [],
          constructionParts: [],
          collisionObstacles: [],
          defaultViews: [],
          parts: [],
          pricing: pricingPolicyFor("typovy"),
          pricingEntries: [],
          printSurfaces: [],
          partDefinitions: [],
          assets: draft.modelUrl ? {
            sourceId: id,
            scale: 1,
            unit: "mm",
            models3d: [{ id: `${id}-master`, url: draft.modelUrl, role: "master-reference", unit: "mm", axisSystem: "x-right-y-depth-z-up" }],
          } : undefined,
        };
        setLocalBooths((items) => [...items, created]);
        setSelectedId(id);
        setShowForm(false);
      }} />}
      <div className="adminSplit">
        <div className="adminList">
          {allBooths.filter((item) => matchesBoothSearch(item, query) && (activeFilter === "all" || (item.active !== false) === (activeFilter === "active"))).map((item) => (
            <button key={item.id} className={item.id === selectedId ? "active" : ""} onClick={() => setSelectedId(item.id)}>
              <strong>{item.name}</strong><span>{item.internalCode ?? item.code} · {item.size}</span>
            </button>
          ))}
        </div>
        {booth && <div className="adminDetail">
          <div className="adminDetailMeta"><span>{booth.internalCode ?? booth.code}</span><h2>{booth.name}</h2><p>{booth.description}</p><dl><div><dt>Typ / kategorie</dt><dd>{booth.category ?? booth.projectType}</dd></div><div><dt>Nominální rozměry</dt><dd>{booth.nominalDimensions ? `${booth.nominalDimensions.widthMm} × ${booth.nominalDimensions.depthMm} × ${booth.nominalDimensions.heightMm} mm` : "—"}</dd></div><div><dt>CAD / model rozměry</dt><dd>{booth.cadDimensions ? `${booth.cadDimensions.widthMm} × ${booth.cadDimensions.depthMm ?? "—"} × ${booth.cadDimensions.heightMm ?? "—"} mm` : "—"}</dd></div><div><dt>Stav</dt><dd>{booth.active === false ? "Neaktivní" : "Aktivní"}</dd></div><div><dt>GLB asset</dt><dd>{getMasterReferenceModel(booth.assets)?.url ?? "—"}</dd></div><div><dt>Thumbnail / fotografie / SKP</dt><dd>{booth.thumbnailUrl ?? "—"} · {booth.photoUrl ?? "—"} · {booth.sketchupUrl ?? "—"}</dd></div><div><dt>Varianty / části</dt><dd>{booth.variants.length || "Bez variant"} · {booth.partDefinitions?.length ?? 0} mapovaných částí</dd></div><div><dt>Výchozí pohledy</dt><dd>{booth.defaultViews?.length ?? 0}</dd></div><div><dt>Potisk / tiskové plochy</dt><dd>{booth.printable ? "Ano" : "Ne"} · {booth.printSurfaces?.length ?? 0}</dd></div><div><dt>Finish varianty</dt><dd>{booth.finishVariants?.map((finish) => finish.name).join(", ") || "—"}</dd></div><div><dt>Base sale / purchase / měna</dt><dd>{priceSummary(booth.pricingEntries)}</dd></div><div><dt>Pricing overrides</dt><dd>{booth.pricingEntries?.filter((entry) => entry.exhibitionId || entry.priceListId || entry.realizationCompanyId).length ?? 0} řádků</dd></div></dl></div>
          {booth.widthMm && booth.depthMm && <div className="adminPreviews">{booth.thumbnailUrl && <div><span>THUMBNAIL</span><img className="catalogPhotoPreview" src={booth.thumbnailUrl} alt={`Náhled ${booth.name}`} /></div>}<div><span>2D NÁHLED</span><div className="adminPlanPreview"><BoothCadPlanView asset={getMasterReferenceModel(booth.assets)} footprintWidthMm={booth.widthMm} footprintDepthMm={booth.depthMm} visible selected={false} rotateView180 /></div></div><div><span>3D NÁHLED</span><BoothCadViewer asset={getMasterReferenceModel(booth.assets)} footprintWidthMm={booth.widthMm} footprintDepthMm={booth.depthMm} components={[]} defaultViews={booth.defaultViews} nominalDimensions={booth.nominalDimensions} /></div></div>}
        </div>}
      </div>
    </div>
  );
}

export function ComponentCatalogPage({ items }: { items: readonly ComponentDefinition[] }) {
  const [localItems, setLocalItems] = useState<ComponentDefinition[]>([]);
  const allItems = [...items, ...localItems];
  const visibleItems = allItems.filter(
    (item) => item.active !== false && item.sceneLayer === "furniture",
  );
  const categories = categoryOptions(visibleItems);
  const [selectedId, setSelectedId] = useState(visibleItems[0]?.id ?? "");
  const [showForm, setShowForm] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("");
  const [printable, setPrintable] = useState("");
  const [showIn3D, setShowIn3D] = useState("");
  const item = allItems.find((entry) => entry.id === selectedId);
  const preview = item ? placeComponent(item, "admin-preview", 600, 600) : undefined;
  const selectedCategory = item
    ? categories.find((value) => value.id === item.category)?.name ?? item.category
    : "";
  const selectedPrice = getBasePricingEntry(item?.pricingEntries, "CZK");
  const selectedTax = calculateNetVatGross(
    selectedPrice?.salePrice ?? 0,
    item?.vatRatePercent,
  );
  const selectedMargin =
    selectedPrice?.salePrice !== undefined &&
    selectedPrice.purchasePrice !== undefined
      ? calculateMarginDelta(selectedPrice.salePrice, selectedPrice.purchasePrice)
      : undefined;
  return (
    <div className="workspacePage">
      <div className="workspacePageHeader"><div><span className="eyebrow">ADMINISTRACE</span><h1>Mobiliář / komponenty</h1></div><button className="primaryButton" onClick={() => setShowForm(!showForm)}>+ Přidat mobiliář</button></div>
      <div className="adminFilters"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Hledat kód, název nebo kategorii…" /><select value={printable} onChange={(event) => setPrintable(event.target.value)}><option value="">Potisk: vše</option><option value="yes">Printable</option><option value="no">Bez potisku</option></select><select value={showIn3D} onChange={(event) => setShowIn3D(event.target.value)}><option value="">3D: vše</option><option value="yes">Zobrazuje se v 3D</option><option value="no">Pouze 2D</option></select></div>
      <div className="adminCategoryTabs"><button className={!category ? "active" : ""} onClick={() => setCategory("")}>Vše</button>{categories.map((entry) => <button key={entry.id} className={category === entry.id ? "active" : ""} onClick={() => setCategory(entry.id)}>{entry.name}</button>)}</div>
      {showForm && <MetadataForm kind="component" onSubmit={(draft) => {
        const id = `catalog-${Date.now()}`;
        const created: ComponentDefinition = {
          id,
          internalCode: draft.code,
          type: "catalog-component",
          displayName: draft.name,
          name: draft.name,
          category: draft.category || "other",
          description: draft.description,
          sceneLabel: draft.name,
          widthMm: Number(draft.widthMm) || 100,
          depthMm: Number(draft.depthMm) || 100,
          heightMm: Number(draft.heightMm) || undefined,
          resizable: false,
          productionProfiles: {},
          rotation: { defaultMode: "free", snapStep: 45, quickAngles: [0, 45, 90, 135, 180, 225, 270, 315], allowFreeRotation: true, locked: false },
          systemLocked: false,
          userLocked: false,
          visible: true,
          thumbnailUrl: draft.thumbnailUrl || undefined,
          photoUrl: draft.photoUrl || undefined,
          sketchupUrl: draft.sketchupUrl || undefined,
          modelUrl: draft.modelUrl || undefined,
          footprint2D: { shape: "rectangle" },
          showIn2D: draft.showIn2D,
          showIn3D: draft.showIn3D,
          sceneLayer: "furniture",
          printable: draft.printable,
          printWidthMm: draft.printable ? Number(draft.printWidthMm) || undefined : undefined,
          printHeightMm: draft.printable ? Number(draft.printHeightMm) || undefined : undefined,
          unit: "ks",
          active: true,
          pricingEntries: [],
          printSurfaces: draft.printable
            ? [{ id: `${id}-print-1`, name: "Tisková plocha 1", widthMm: Number(draft.printWidthMm) || Number(draft.widthMm) || 100, heightMm: Number(draft.printHeightMm) || Number(draft.heightMm) || 100, materialRole: "PRINT_SURFACE", active: true }]
            : [],
          partDefinitions: [],
          assets: draft.modelUrl ? {
            sourceId: id,
            scale: 1,
            unit: "mm",
            models3d: [{ id: `${id}-model`, url: draft.modelUrl, role: "component", unit: "mm", axisSystem: "x-right-y-depth-z-up", anchor: "footprint-center-floor" }],
          } : undefined,
        };
        setLocalItems((entries) => [...entries, created]);
        setSelectedId(id);
        setShowForm(false);
      }} />}
      <div className="adminSplit">
        <div className="adminList catalogAdminList">{filterCatalogCategory(visibleItems, category).filter((entry) => matchesCatalogSearch(entry, query) && (!printable || Boolean(entry.printable) === (printable === "yes")) && (!showIn3D || Boolean(entry.showIn3D) === (showIn3D === "yes"))).map((entry) => {
          const basePrice = getBasePricingEntry(entry.pricingEntries, "CZK");
          const categoryName = categories.find((value) => value.id === entry.category)?.name ?? entry.category;
          return <button key={entry.id} className={`catalogListCard ${entry.id === selectedId ? "active" : ""}`} onClick={() => setSelectedId(entry.id)}>
            <SafeCatalogImage item={entry} className="catalogCardImage" alt={`Náhled ${catalogDisplayName(entry)}`} fallback={<span className={`catalogCardFallback ${entry.sceneLayer}`}>{entry.footprint2D?.symbol ?? "2D"}</span>} />
            <span className="catalogCardCopy"><strong>{catalogDisplayName(entry)}</strong><small>{entry.internalCode}</small><small>{entry.widthMm} × {entry.depthMm} × {entry.heightMm ?? "—"} mm</small><b>{basePrice?.salePrice !== undefined ? `${formatMoney(basePrice.salePrice)} bez DPH` : "Cena neuvedena"}</b><em>Kategorie: {categoryName}</em></span>
          </button>;
        })}</div>
        {item && preview && <div className="adminDetail">
          <header className="catalogDetailHeader"><span>{item.internalCode}</span><h2>{catalogDisplayName(item)}</h2><p>{item.description}</p></header>
          <div className="catalogDetailSections">
            <CatalogDetailSection title="Identifikace"><dl><Detail label="Interní kód" value={item.internalCode} /><Detail label="Oficiální interní název" value={item.officialName} /><Detail label="Zobrazovaný název" value={catalogDisplayName(item)} /><Detail label="Kategorie" value={selectedCategory} /><Detail label="Jednotka" value={item.unit} /><Detail label="Stav" value={item.active === false ? "Neaktivní" : "Aktivní"} /></dl></CatalogDetailSection>
            <CatalogDetailSection title="Rozměry"><dl><Detail label="Šířka" value={`${item.widthMm} mm`} /><Detail label="Hloubka" value={`${item.depthMm} mm`} /><Detail label="Výška" value={item.heightMm !== undefined ? `${item.heightMm} mm` : "—"} /></dl></CatalogDetailSection>
            <CatalogDetailSection title="Ceny"><dl><Detail label="Prodejní cena bez DPH" value={selectedPrice?.salePrice !== undefined ? formatMoney(selectedPrice.salePrice) : "—"} /><Detail label="Nákupní cena bez DPH" value={selectedPrice?.purchasePrice !== undefined ? formatMoney(selectedPrice.purchasePrice) : "—"} /><Detail label="Marže / rozdíl" value={selectedMargin !== undefined ? formatMoney(selectedMargin) : "—"} /><Detail label={`DPH ${selectedTax.vatRatePercent} %`} value={selectedPrice?.salePrice !== undefined ? formatMoney(selectedTax.vat) : "—"} /><Detail label="Cena s DPH" value={selectedPrice?.salePrice !== undefined ? formatMoney(selectedTax.gross) : "—"} /><Detail label="Pricing overrides / ceníky" value={`${item.pricingEntries?.filter((entry) => entry.exhibitionId || entry.priceListId || entry.realizationCompanyId).length ?? 0} řádků`} /></dl></CatalogDetailSection>
            <CatalogDetailSection title="Assety"><dl><Detail label="GLB URL" value={getComponentModel(item.assets)?.url ?? item.modelUrl ?? "—"} /><Detail label="Reálná fotografie" value={item.photoUrl ?? "—"} /><Detail label="Thumbnail URL" value={item.thumbnailUrl ?? (item.photoUrl ? `${item.photoUrl} (fallback)` : "—")} /><Detail label="SKP URL" value={item.sketchupUrl ?? "—"} /></dl></CatalogDetailSection>
            <CatalogDetailSection title="Vlastnosti"><dl><Detail label="Zobrazit ve 2D" value={yesNo(item.showIn2D)} /><Detail label="Zobrazit ve 3D" value={yesNo(item.showIn3D)} /><Detail label="Potisknutelné" value={yesNo(item.printable)} /><Detail label="Tiskové plochy" value={String(item.printSurfaces?.length ?? 0)} /><Detail label="Finish varianty" value={item.finishVariants?.map((finish) => finish.name).join(", ") || "—"} /></dl></CatalogDetailSection>
          </div>
          <div className="adminPreviews catalogAssetPreviews"><div><span>REÁLNÁ FOTOGRAFIE</span><SafeCatalogImage item={item} className="catalogPhotoPreview" alt={`Fotografie ${catalogDisplayName(item)}`} fallback={<p className="catalogPhotoPlaceholder">Fotografie zatím není nahraná</p>} /></div><div><span>2D NÁHLED</span>{item.showIn2D ? <div className={`catalogFootprint ${item.sceneLayer}`}>{item.footprint2D?.symbol ?? catalogDisplayName(item)}</div> : <p className="workspaceEmpty">Položka se ve 2D nezobrazuje.</p>}</div><div><span>3D PREVIEW</span>{item.showIn3D ? <BoothCadViewer footprintWidthMm={1200} footprintDepthMm={1200} components={[preview]} /> : <p className="workspaceEmpty">Tato komponenta je pouze ve 2D.</p>}</div></div>
        </div>}
      </div>
    </div>
  );
}

function SafeCatalogImage({ item, className, alt, fallback }: { item: Pick<ComponentDefinition, "thumbnailUrl" | "photoUrl" | "thumbnailAsset" | "photoAsset">; className: string; alt: string; fallback: React.ReactNode }) {
  const [unavailableUrls, setUnavailableUrls] = useState<string[]>([]);
  const legacySource = catalogImageUrl(item, unavailableUrls);
  const resolved = useAssetUrl(catalogImageAsset(item), legacySource);
  const source = resolved.url;
  return source
    ? <img className={className} src={source} alt={alt} onError={() => setUnavailableUrls((urls) => urls.includes(source) ? urls : [...urls, source])} />
    : fallback;
}

function CatalogDetailSection({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="catalogDetailSection"><h3>{title}</h3>{children}</section>;
}

function Detail({ label, value }: { label: string; value: React.ReactNode }) {
  return <div><dt>{label}</dt><dd>{value || "—"}</dd></div>;
}

function formatMoney(value: number): string {
  return `${value.toLocaleString("cs-CZ")} Kč`;
}

function yesNo(value: boolean | undefined): string {
  return value ? "Ano" : "Ne";
}

type MetadataDraft = {
  code: string;
  name: string;
  category: string;
  description: string;
  widthMm: string;
  depthMm: string;
  heightMm: string;
  modelUrl: string;
  thumbnailUrl: string;
  photoUrl: string;
  sketchupUrl: string;
  showIn2D: boolean;
  showIn3D: boolean;
  printable: boolean;
  printWidthMm: string;
  printHeightMm: string;
};

function MetadataForm({ kind, onSubmit }: { kind: "booth" | "component"; onSubmit: (draft: MetadataDraft) => void }) {
  const [draft, setDraft] = useState<MetadataDraft>({ code: "", name: "", category: "", description: "", widthMm: "", depthMm: "", heightMm: "", modelUrl: "", thumbnailUrl: "", photoUrl: "", sketchupUrl: "", showIn2D: true, showIn3D: false, printable: false, printWidthMm: "", printHeightMm: "" });
  const text = (field: keyof MetadataDraft) => (event: React.ChangeEvent<HTMLInputElement>) => setDraft((current) => ({ ...current, [field]: event.target.value }));
  return <form className="metadataForm" onSubmit={(event) => { event.preventDefault(); if (draft.code.trim() && draft.name.trim()) onSubmit(draft); }}><strong>{kind === "booth" ? "Nový stánek" : "Nová katalogová položka"}</strong><input required value={draft.code} onChange={text("code")} placeholder="Interní kód" /><input required value={draft.name} onChange={text("name")} placeholder="Název" />{kind === "component" && <input value={draft.category} onChange={text("category")} placeholder="Kategorie" />}<input value={draft.description} onChange={text("description")} placeholder="Popis" /><div className="threeColumns"><input type="number" value={draft.widthMm} onChange={text("widthMm")} placeholder="Šířka mm" /><input type="number" value={draft.depthMm} onChange={text("depthMm")} placeholder="Hloubka mm" /><input type="number" value={draft.heightMm} onChange={text("heightMm")} placeholder="Výška mm" /></div><input value={draft.modelUrl} onChange={text("modelUrl")} placeholder="GLB model URL v /public" /><input value={draft.thumbnailUrl} onChange={text("thumbnailUrl")} placeholder="Thumbnail URL" /><input value={draft.photoUrl} onChange={text("photoUrl")} placeholder="Reálná fotografie URL" /><input value={draft.sketchupUrl} onChange={text("sketchupUrl")} placeholder="Volitelný SketchUp / SKP URL" />{kind === "component" && <><div className="checkRow"><label><input type="checkbox" checked={draft.showIn2D} onChange={(event) => setDraft((current) => ({ ...current, showIn2D: event.target.checked }))} /> 2D</label><label><input type="checkbox" checked={draft.showIn3D} onChange={(event) => setDraft((current) => ({ ...current, showIn3D: event.target.checked }))} /> 3D</label><label><input type="checkbox" checked={draft.printable} onChange={(event) => setDraft((current) => ({ ...current, printable: event.target.checked }))} /> Potisk</label></div>{draft.printable && <div className="twoColumns"><input type="number" value={draft.printWidthMm} onChange={text("printWidthMm")} placeholder="Tisková šířka mm" /><input type="number" value={draft.printHeightMm} onChange={text("printHeightMm")} placeholder="Tisková výška mm" /></div>}</>}<p>Metadata se přidají do aktuální pracovní relace. Trvalé uložení a upload GLB čekají na catalog repository a AssetStorageProvider.</p><button type="submit">Přidat do pracovní relace</button></form>;
}

function numberOrNull(value: string): number | null {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function stageLabel(stage: ProjectStage): string {
  return stage === "quote"
    ? "Nabídka / Kalkulace"
    : stage === "design"
      ? "Návrh"
      : stage === "approved"
        ? "Odsouhlaseno"
        : "Hotovo";
}

function ProjectStatus({ label, value }: { label: string; value: string }) {
  const labels: Record<string, string> = {
    unspecified: "Neuvedeno",
    notWanted: "Zákazník nechce",
    inquire: "Poptat",
    ordered: "Objednáno",
  };
  return <div><span>{label}</span><strong>{labels[value] ?? value}</strong></div>;
}

function priceSummary(entries: readonly PricingEntry[] | undefined): string {
  const base = entries?.find(
    (entry) =>
      !entry.exhibitionId &&
      !entry.priceListId &&
      !entry.realizationCompanyId,
  );
  return base
    ? `${base.salePrice ?? "—"} / ${base.purchasePrice ?? "—"} ${base.currency}`
    : "— / —";
}
