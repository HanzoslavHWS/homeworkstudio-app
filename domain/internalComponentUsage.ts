/**
 * "Použití komponenty" (V1-INTERNAL-01) — a secondary choice INSIDE Interní komponenta, never a
 * sixth component group and never a new data type. It only picks one of the two existing kinds the
 * category register already allows:
 *
 *   booth_component  Samostatný prvek generátoru — placed on its own in the individual booth;
 *                    readiness needs GLB + SketchUp source (domain/catalogReadiness.ts).
 *   construction     Konstrukční díl / součást kompletu — e.g. a post inside kit P86; no own 3D
 *                    model required, never offered as a standalone placeable 3D object.
 *
 * Which modes a card may choose comes from its category's `kinds` (catalog_categories), so a
 * category allowing only one of them never shows an invalid choice. Pure, no I/O.
 */
import type { CatalogCategoryDef } from "./catalogClassification.ts";
import type { CatalogItemKind } from "./models.ts";

export type InternalComponentUsage = Extract<CatalogItemKind, "booth_component" | "construction">;

export const INTERNAL_COMPONENT_USAGES: readonly InternalComponentUsage[] = ["booth_component", "construction"];

export const INTERNAL_COMPONENT_USAGE_LABELS_CS: Readonly<Record<InternalComponentUsage, string>> = {
  booth_component: "Samostatný prvek generátoru",
  construction: "Konstrukční díl / součást kompletu",
};

export const INTERNAL_COMPONENT_USAGE_HINTS_CS: Readonly<Record<InternalComponentUsage, string>> = {
  booth_component: "Komponentu lze samostatně vložit do návrhu stánku. Současný generátor vyžaduje GLB a zdrojový SKP.",
  construction: "Interní konstrukční komponenta používaná například v kompletu stánku. Vlastní 3D model není povinný.",
};

export function isInternalComponentUsage(kind: CatalogItemKind | string | undefined): kind is InternalComponentUsage {
  return (INTERNAL_COMPONENT_USAGES as readonly string[]).includes(kind ?? "");
}

/** Usages the category allows, in a fixed display order (A, then B). Empty for non-internal categories. */
export function usagesForCategory(category: Pick<CatalogCategoryDef, "group" | "kinds"> | undefined): readonly InternalComponentUsage[] {
  if (!category || category.group !== "internal_component") return [];
  return INTERNAL_COMPONENT_USAGES.filter((usage) => category.kinds.includes(usage));
}

/** What changing the usage of an existing card means — shown before the user saves. */
export function usageChangeWarningCs(from: CatalogItemKind, to: CatalogItemKind): string | undefined {
  if (from === to) return undefined;
  if (from === "booth_component") return "Komponenta přestane být nabízena jako samostatný prvek v generátoru. Soubory (GLB, SKP, PDF) zůstanou zachované.";
  if (to === "booth_component") return "Komponenta bude nabízena jako samostatný prvek generátoru — k aktivaci bude potřebovat GLB a zdrojový SKP.";
  return undefined;
}

/** Server rule: a booth_component already placed in a project cannot stop being one. */
export function boothComponentUsageChangeIssue(referencingProjects: readonly string[]): string | undefined {
  if (referencingProjects.length === 0) return undefined;
  const names = referencingProjects.slice(0, 5).join(", ");
  return `Komponentu už používají projekty (${names}${referencingProjects.length > 5 ? ", …" : ""}). Změna na konstrukční díl by ji z jejich návrhu vyřadila z nabídky generátoru — použití nelze změnit.`;
}
