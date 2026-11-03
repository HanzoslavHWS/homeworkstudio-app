import type { CatalogItemKind, CatalogItemType } from "./models.ts";
import { isKnownTechnicalServiceCategory } from "./technicalServiceCatalog.ts";
import { parseRecommendedParameters, type RecommendedParameter } from "./catalogParameters.ts";

/**
 * Katalog: Druh komponenty → Kategorie (V1-CATALOG).
 *
 * The user picks one of five COMPONENT GROUPS ("Druh komponenty") and a category of that group.
 * Everything else follows from the category: the internal card type (catalog_items.item_type),
 * the internal technical kind (catalog_items.kind — kept as it is, the generator, readiness and
 * kits keep using it), the pricing classification (price_category) and the technical service
 * category (serviceTechnical.serviceCategory, shared with Technické rastry).
 *
 * Typové stánky (BOOTH) and komplety (KIT) are NOT one of the five groups: they keep their own
 * specialized administration and rules (package contents, included items, substitutes, 3D).
 */
export const COMPONENT_GROUPS = ["product", "graphics", "technical_service", "internal_component", "technical_point"] as const;
export type ComponentGroup = (typeof COMPONENT_GROUPS)[number];

export const COMPONENT_GROUP_LABELS_CS: Readonly<Record<ComponentGroup, string>> = {
  product: "Produkt",
  graphics: "Grafika",
  technical_service: "Technická služba",
  internal_component: "Interní komponenta",
  technical_point: "Technický bod",
};

export const COMPONENT_GROUP_HINTS_CS: Readonly<Record<ComponentGroup, string>> = {
  product: "Fyzické vybavení stánku (židle, stoly, pulty, koberce, osvětlení…). Fotografie, rozměry, 2D/3D, výrobní podklady.",
  graphics: "Grafické služby a tiskové plochy (límec v bm, celopolep a polep pultu v m²). Výpočty grafiky se řídí stávajícími pravidly.",
  technical_service: "Objednávaná a účtovaná služba (elektřina, internet, úklid…). Bez povinného 3D a CAD.",
  internal_component: "Konstrukční / interní prvek generátoru (sloupky, panely…). ABF kód není povinný, generátorový kód ano.",
  technical_point: "Neúčtovaný 2D symbol umístění (elektro bod, internetový bod…). Účtuje se objednaná služba, ne bod.",
};

/** Card type and the internal kinds each group may use. */
export const COMPONENT_GROUP_TARGETS: Readonly<Record<ComponentGroup, Readonly<{ itemType: CatalogItemType; kinds: readonly CatalogItemKind[] }>>> = {
  product: { itemType: "PRODUCT", kinds: ["furniture", "floor_finish", "construction", "other"] },
  graphics: { itemType: "SERVICE", kinds: ["graphics_service"] },
  technical_service: { itemType: "SERVICE", kinds: ["service"] },
  internal_component: { itemType: "INTERNAL_COMPONENT", kinds: ["booth_component", "construction", "other"] },
  technical_point: { itemType: "SERVICE", kinds: ["technical_point"] },
};

export function isComponentGroup(value: unknown): value is ComponentGroup {
  return typeof value === "string" && (COMPONENT_GROUPS as readonly string[]).includes(value);
}

/** "booth" / "kit" = specialized cards outside the five groups. */
export type CardGroup = ComponentGroup | "booth" | "kit";

export function groupOfCard(itemType: CatalogItemType, kind: CatalogItemKind): CardGroup {
  if (itemType === "BOOTH") return "booth";
  if (itemType === "KIT") return "kit";
  if (itemType === "PRODUCT") return "product";
  if (itemType === "INTERNAL_COMPONENT") return "internal_component";
  if (kind === "graphics_service") return "graphics";
  if (kind === "technical_point") return "technical_point";
  return "technical_service";
}

export type CatalogCategoryDef = Readonly<{
  /** Stable identifier = the value stored in catalog_items.category. Existing values are kept as ids. */
  id: string;
  name: string;
  group: ComponentGroup;
  /** Internal kinds allowed for this category; the first is the default when a card moves into it. */
  kinds: readonly CatalogItemKind[];
  description?: string;
  isActive: boolean;
  sortOrder: number;
  /** Technical service category (Technické rastry registry) a card of this category carries. */
  serviceCategory?: string;
  /** Pricing classification (V1-DATA-05). Omitted = derived from the group (see derivedPriceCategory). */
  priceCategory?: "standard" | "electricity";
  /** Optional parameters offered on cards of this category (catalog administration). Values live in the card's existing parameter list. */
  recommendedParameters?: readonly RecommendedParameter[];
}>;

/**
 * Built-in registry — the seed of the catalog_categories table (migration 20261023120000) and the
 * fallback while that migration is not applied. Every category value already used by cards keeps
 * its exact id ("chairs", "Nábytek", "T. služby", …); new categories get readable slug ids.
 */
export const BUILT_IN_CATALOG_CATEGORIES: readonly CatalogCategoryDef[] = [
  // Produkt
  { id: "chairs", name: "Židle", group: "product", kinds: ["furniture"], isActive: true, sortOrder: 10 },
  { id: "product-tables", name: "Stoly", group: "product", kinds: ["furniture"], isActive: true, sortOrder: 20 },
  { id: "product-counters", name: "Pulty", group: "product", kinds: ["furniture"], isActive: true, sortOrder: 30 },
  { id: "Kuchyňka", name: "Kuchyňka", group: "product", kinds: ["furniture", "other"], isActive: true, sortOrder: 40 },
  { id: "Nábytek", name: "Ostatní mobiliář", group: "product", kinds: ["furniture", "other"], isActive: true, sortOrder: 50 },
  { id: "product-carpets", name: "Koberce", group: "product", kinds: ["floor_finish"], isActive: true, sortOrder: 60 },
  { id: "Podlaha", name: "Podlaha", group: "product", kinds: ["floor_finish"], isActive: true, sortOrder: 70 },
  { id: "Osvětlení", name: "Osvětlení", group: "product", kinds: ["other", "furniture"], isActive: true, sortOrder: 80 },
  { id: "Světlo", name: "Světlo / elektro (ABF)", group: "product", kinds: ["other", "furniture"], isActive: true, sortOrder: 90 },
  { id: "Octanorm", name: "Octanorm", group: "product", kinds: ["furniture", "construction", "other"], isActive: true, sortOrder: 100 },
  { id: "Stavba", name: "Stavba", group: "product", kinds: ["construction"], isActive: true, sortOrder: 110 },
  { id: "Úvaz", name: "Úvaz (rigging)", group: "product", kinds: ["construction"], isActive: true, sortOrder: 120 },
  { id: "Ostatní", name: "Ostatní produkty", group: "product", kinds: ["other", "furniture"], isActive: true, sortOrder: 130 },
  // Grafika
  { id: "graphics-fascia", name: "Límec (bm)", group: "graphics", kinds: ["graphics_service"], isActive: true, sortOrder: 210 },
  { id: "graphics-full-wrap", name: "Celopolep (m²)", group: "graphics", kinds: ["graphics_service"], isActive: true, sortOrder: 220 },
  { id: "graphics-counter", name: "Polep pultu (m²)", group: "graphics", kinds: ["graphics_service"], isActive: true, sortOrder: 230 },
  { id: "graphics-other", name: "Ostatní grafika", group: "graphics", kinds: ["graphics_service"], isActive: true, sortOrder: 240 },
  // Technická služba
  { id: "service-electricity", name: "Elektřina", group: "technical_service", kinds: ["service"], serviceCategory: "electricity", priceCategory: "electricity", isActive: true, sortOrder: 310 },
  { id: "service-internet", name: "Internet", group: "technical_service", kinds: ["service"], serviceCategory: "internet", isActive: true, sortOrder: 320 },
  { id: "service-cleaning", name: "Úklid", group: "technical_service", kinds: ["service"], serviceCategory: "cleaning", isActive: true, sortOrder: 330 },
  { id: "service-water", name: "Voda", group: "technical_service", kinds: ["service"], serviceCategory: "water", isActive: true, sortOrder: 340 },
  { id: "service-waste", name: "Odpad", group: "technical_service", kinds: ["service"], serviceCategory: "waste", isActive: true, sortOrder: 350 },
  { id: "T. služby", name: "Ostatní technické služby", group: "technical_service", kinds: ["service"], serviceCategory: "other", isActive: true, sortOrder: 360 },
  { id: "services", name: "Služby (původní obecná kategorie)", group: "technical_service", kinds: ["service", "graphics_service"], description: "Historická obecná kategorie. Nové karty zařaďte do konkrétní technické služby nebo grafiky.", isActive: false, sortOrder: 390 },
  // Interní komponenta
  { id: "Sloupky", name: "Sloupky", group: "internal_component", kinds: ["booth_component", "construction"], isActive: true, sortOrder: 410 },
  { id: "Panely / stěny", name: "Panely / stěny", group: "internal_component", kinds: ["booth_component", "construction"], isActive: true, sortOrder: 420 },
  { id: "Límce", name: "Límce (konstrukční profil)", group: "internal_component", kinds: ["booth_component", "construction"], isActive: true, sortOrder: 430 },
  { id: "Dveře", name: "Dveře", group: "internal_component", kinds: ["booth_component", "construction"], isActive: true, sortOrder: 440 },
  { id: "Zázemí / konstrukce", name: "Konstrukční prvky / zázemí", group: "internal_component", kinds: ["construction", "booth_component"], isActive: true, sortOrder: 450 },
  { id: "internal-other", name: "Ostatní interní komponenty", group: "internal_component", kinds: ["other", "booth_component", "construction"], isActive: true, sortOrder: 460 },
  // Technický bod
  { id: "point-electricity", name: "Elektro bod", group: "technical_point", kinds: ["technical_point"], serviceCategory: "electricity", isActive: true, sortOrder: 510 },
  { id: "point-internet", name: "Internetový bod", group: "technical_point", kinds: ["technical_point"], serviceCategory: "internet", isActive: true, sortOrder: 520 },
  { id: "point-water", name: "Vodní bod", group: "technical_point", kinds: ["technical_point"], serviceCategory: "water", isActive: true, sortOrder: 530 },
  { id: "point-other", name: "Ostatní technické body", group: "technical_point", kinds: ["technical_point"], serviceCategory: "other", isActive: true, sortOrder: 540 },
];

export function findCategory(registry: readonly CatalogCategoryDef[], id: string | null | undefined): CatalogCategoryDef | undefined {
  return id ? registry.find((category) => category.id === id) : undefined;
}

/** Categories offered for a group: active ones, ordered. */
export function categoriesForGroup(registry: readonly CatalogCategoryDef[], group: ComponentGroup): readonly CatalogCategoryDef[] {
  return registry.filter((category) => category.group === group && category.isActive).slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "cs"));
}

/**
 * Pricing classification a category implies. Electricity services → "electricity"; every other
 * billed group → "standard" (base sale price list). A technical point is never billed on its own,
 * so it implies nothing (the stored value is left as it is).
 */
export function derivedPriceCategory(category: CatalogCategoryDef): "standard" | "electricity" | undefined {
  if (category.group === "technical_point") return undefined;
  return category.priceCategory ?? "standard";
}

/** Internal type/kind of a card moved into a category: keeps its current kind when the category allows it. */
export function classificationTarget(category: CatalogCategoryDef, currentKind: CatalogItemKind): Readonly<{ itemType: CatalogItemType; kind: CatalogItemKind }> {
  return {
    itemType: COMPONENT_GROUP_TARGETS[category.group].itemType,
    kind: category.kinds.includes(currentKind) ? currentKind : category.kinds[0]!,
  };
}

/**
 * Why a combination is invalid, or undefined when valid. Used by the form AND the server (a direct
 * API call cannot store e.g. Technická služba + Židle). BOOTH/KIT cards keep their own rules.
 */
export function classificationIssue(registry: readonly CatalogCategoryDef[], card: Readonly<{ itemType: CatalogItemType; kind: CatalogItemKind; category: string | null }>, options: Readonly<{ requireActive?: boolean }> = {}): string | undefined {
  const group = groupOfCard(card.itemType, card.kind);
  if (group === "booth" || group === "kit") return undefined;
  if (!COMPONENT_GROUP_TARGETS[group].kinds.includes(card.kind)) return `Druh „${COMPONENT_GROUP_LABELS_CS[group]}“ nepovoluje interní druh „${card.kind}“.`;
  if (!card.category) return `Vyberte kategorii pro druh „${COMPONENT_GROUP_LABELS_CS[group]}“.`;
  const category = findCategory(registry, card.category);
  if (!category) return `Kategorie „${card.category}“ není v registru kategorií.`;
  if (category.group !== group) return `Kategorie „${category.name}“ patří k druhu „${COMPONENT_GROUP_LABELS_CS[category.group]}“, ne „${COMPONENT_GROUP_LABELS_CS[group]}“.`;
  if (!category.kinds.includes(card.kind)) return `Kategorie „${category.name}“ nepovoluje interní druh „${card.kind}“.`;
  if (options.requireActive && !category.isActive) return `Kategorie „${category.name}“ je neaktivní — vyberte jinou.`;
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Registry administration (input validation)
// ---------------------------------------------------------------------------------------------

export class InvalidCatalogCategoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCatalogCategoryError";
  }
}

const CATEGORY_ID_PATTERN = /^[\p{L}\p{N}][\p{L}\p{N} ./_-]{0,63}$/u;

/** "Barové židle" → "barove-zidle". */
export function slugifyCategoryId(name: string): string {
  return name.normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 60);
}

export function parseCatalogCategoryInput(raw: unknown): CatalogCategoryDef {
  if (!raw || typeof raw !== "object") throw new InvalidCatalogCategoryError("Chybí údaje kategorie.");
  const input = raw as Record<string, unknown>;
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name || name.length > 80) throw new InvalidCatalogCategoryError("Název kategorie je povinný (nejvýše 80 znaků).");
  const id = typeof input.id === "string" && input.id.trim() ? input.id.trim() : slugifyCategoryId(name);
  if (!CATEGORY_ID_PATTERN.test(id)) throw new InvalidCatalogCategoryError("Identifikátor kategorie smí obsahovat písmena, číslice, mezery a . / _ - (nejvýše 64 znaků).");
  if (!isComponentGroup(input.group)) throw new InvalidCatalogCategoryError("Zvolte druh komponenty kategorie.");
  const allowedKinds = COMPONENT_GROUP_TARGETS[input.group].kinds;
  const kinds = Array.isArray(input.kinds) ? [...new Set(input.kinds.filter((kind): kind is CatalogItemKind => typeof kind === "string" && allowedKinds.includes(kind as CatalogItemKind)))] : [];
  if (kinds.length === 0) throw new InvalidCatalogCategoryError("Kategorie musí povolit aspoň jeden interní druh daného druhu komponenty.");
  const description = typeof input.description === "string" && input.description.trim() ? input.description.trim().slice(0, 300) : undefined;
  const serviceCategory = typeof input.serviceCategory === "string" && input.serviceCategory ? input.serviceCategory : undefined;
  if (serviceCategory && (!isKnownTechnicalServiceCategory(serviceCategory) || (input.group !== "technical_service" && input.group !== "technical_point"))) {
    throw new InvalidCatalogCategoryError("Technickou kategorii lze nastavit jen u technické služby nebo technického bodu.");
  }
  const priceCategory = input.priceCategory === "electricity" || input.priceCategory === "standard" ? input.priceCategory : undefined;
  if (priceCategory === "electricity" && input.group !== "technical_service") throw new InvalidCatalogCategoryError("Ceník elektřiny lze přiřadit jen technické službě.");
  const sortOrder = typeof input.sortOrder === "number" && Number.isFinite(input.sortOrder) ? Math.round(input.sortOrder) : 1000;
  let recommendedParameters: readonly RecommendedParameter[];
  try {
    recommendedParameters = parseRecommendedParameters(input.recommendedParameters);
  } catch (error) {
    throw new InvalidCatalogCategoryError(error instanceof Error ? error.message : "Neplatné doporučené parametry.");
  }
  return {
    id,
    name,
    group: input.group,
    kinds,
    ...(description ? { description } : {}),
    isActive: input.isActive !== false,
    sortOrder,
    ...(serviceCategory ? { serviceCategory } : {}),
    ...(priceCategory ? { priceCategory } : {}),
    ...(recommendedParameters.length ? { recommendedParameters } : {}),
  };
}

/** A category that cards already use keeps its group and the kinds those cards have. */
export function categoryChangeIssue(previous: CatalogCategoryDef | undefined, next: CatalogCategoryDef, usedByKinds: readonly CatalogItemKind[]): string | undefined {
  if (!previous) return undefined;
  if (usedByKinds.length === 0) return undefined;
  if (previous.group !== next.group) return `Kategorii „${previous.name}“ už používají karty — druh komponenty jí nelze změnit.`;
  const dropped = usedByKinds.filter((kind) => !next.kinds.includes(kind));
  if (dropped.length) return `Kategorii „${previous.name}“ používají karty s interním druhem ${[...new Set(dropped)].join(", ")} — ten nelze odebrat.`;
  return undefined;
}
