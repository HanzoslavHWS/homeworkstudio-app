import type { CatalogCategory, ComponentDefinition } from "./models.ts";

export const catalogCategories: readonly CatalogCategory[] = [
  { id: "chairs", name: "Židle", active: true, order: 10 },
  { id: "furniture", name: "Nábytek", active: true, order: 20 },
  { id: "services", name: "Služby", active: true, order: 30 },
];

export function categoryOptions(
  items: readonly Pick<ComponentDefinition, "category" | "sceneLayer">[],
  definitions: readonly CatalogCategory[] = catalogCategories,
): readonly CatalogCategory[] {
  const ids = new Set(
    items
      .filter((item) => item.sceneLayer === "furniture")
      .map((item) => item.category),
  );
  return [...definitions, ...[...ids]
    .filter((id) => !definitions.some((definition) => definition.id === id))
    .map((id, index) => ({ id, name: id, active: true, order: 100 + index }))]
    .filter((category) => category.active)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

export function filterCatalogCategory<T extends Pick<ComponentDefinition, "category" | "sceneLayer">>(
  items: readonly T[],
  categoryId: string,
): readonly T[] {
  return items.filter(
    (item) =>
      item.sceneLayer === "furniture" &&
      (!categoryId || item.category === categoryId),
  );
}
