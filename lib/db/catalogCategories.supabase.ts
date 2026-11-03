import type { SupabaseClient } from "@supabase/supabase-js";
import {
  BUILT_IN_CATALOG_CATEGORIES,
  categoryChangeIssue,
  InvalidCatalogCategoryError,
  isComponentGroup,
  type CatalogCategoryDef,
} from "../../domain/catalogClassification.ts";
import { parseRecommendedParameters, type RecommendedParameter } from "../../domain/catalogParameters.ts";
import type { CatalogItemKind } from "../../domain/models.ts";

const BASE_COLUMNS = "id, name, component_group, kinds, description, is_active, sort_order, service_category, price_category";
/** 20261023130000 (recommended parameters). Reads fall back to BASE_COLUMNS. */
const COLUMNS = `${BASE_COLUMNS}, recommended_parameters`;

type CategoryRow = Readonly<{
  id: string;
  name: string;
  component_group: string;
  kinds: string[] | null;
  description: string | null;
  is_active: boolean;
  sort_order: number;
  service_category: string | null;
  price_category: string | null;
  recommended_parameters?: unknown;
}>;

/** persisted = read from catalog_categories; false = the migration is not applied yet and the built-in register is used (read-only). */
export type CatalogCategoryRegister = Readonly<{ categories: readonly CatalogCategoryDef[]; persisted: boolean; parametersMigrated?: boolean }>;

export class CatalogCategoriesNotMigratedError extends Error {
  constructor(message = "Správa kategorií vyžaduje migraci 20261023120000_catalog_categories. Do té doby platí vestavěný seznam kategorií.") {
    super(message);
    this.name = "CatalogCategoriesNotMigratedError";
  }
}

function isMissingTable(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42P01" || code === "PGRST205";
}

function isMissingColumn(error: unknown): boolean {
  const code = (error as { code?: string } | null)?.code;
  return code === "42703" || code === "PGRST204";
}

function rowToCategory(row: CategoryRow): CatalogCategoryDef | undefined {
  if (!isComponentGroup(row.component_group)) return undefined;
  return {
    id: row.id,
    name: row.name,
    group: row.component_group,
    kinds: (row.kinds ?? []) as CatalogItemKind[],
    ...(row.description ? { description: row.description } : {}),
    isActive: row.is_active,
    sortOrder: row.sort_order,
    ...(row.service_category ? { serviceCategory: row.service_category } : {}),
    ...(row.price_category === "electricity" || row.price_category === "standard" ? { priceCategory: row.price_category } : {}),
    ...recommendedOf(row.recommended_parameters),
  };
}

/** Stored templates, read leniently (an invalid element is skipped, never fatal). */
function recommendedOf(value: unknown): { recommendedParameters?: readonly RecommendedParameter[] } {
  if (!Array.isArray(value) || value.length === 0) return {};
  try {
    const parsed = parseRecommendedParameters(value);
    return parsed.length ? { recommendedParameters: parsed } : {};
  } catch {
    return {};
  }
}

function categoryToRow(category: CatalogCategoryDef) {
  return {
    id: category.id,
    name: category.name,
    component_group: category.group,
    kinds: [...category.kinds],
    description: category.description ?? null,
    is_active: category.isActive,
    sort_order: category.sortOrder,
    service_category: category.serviceCategory ?? null,
    price_category: category.priceCategory ?? null,
    recommended_parameters: [...(category.recommendedParameters ?? [])],
  };
}

export async function readCatalogCategoryRegister(client: SupabaseClient): Promise<CatalogCategoryRegister & Readonly<{ parametersMigrated?: boolean }>> {
  let parametersMigrated = true;
  let { data, error } = await client.from("catalog_categories").select(COLUMNS);
  if (error && isMissingColumn(error)) {
    // Categories migrated, recommended parameters (20261023130000) not yet.
    parametersMigrated = false;
    ({ data, error } = await client.from("catalog_categories").select(BASE_COLUMNS));
  }
  if (error) {
    if (isMissingTable(error)) return { categories: BUILT_IN_CATALOG_CATEGORIES, persisted: false };
    throw error;
  }
  const categories = ((data ?? []) as CategoryRow[]).flatMap((row) => rowToCategory(row) ?? []);
  // The table is seeded by its migration and rows can never be deleted — an empty read means it is not usable yet.
  if (categories.length === 0) return { categories: BUILT_IN_CATALOG_CATEGORIES, persisted: false };
  return { categories: categories.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "cs")), persisted: true, parametersMigrated };
}

/**
 * Inserts a new category or updates an existing one (id never changes). A category already used by
 * cards keeps its group and the internal kinds those cards have — so no card silently becomes invalid.
 */
export async function saveCatalogCategory(client: SupabaseClient, category: CatalogCategoryDef, isNew: boolean): Promise<CatalogCategoryDef> {
  const register = await readCatalogCategoryRegister(client);
  if (!register.persisted) throw new CatalogCategoriesNotMigratedError();
  if (register.parametersMigrated === false && (category.recommendedParameters?.length ?? 0) > 0) throw new CatalogCategoriesNotMigratedError("Doporučené parametry vyžadují migraci 20261023130000_catalog_category_parameters.");
  const previous = register.categories.find((candidate) => candidate.id === category.id);
  if (isNew && previous) throw new InvalidCatalogCategoryError(`Kategorie s identifikátorem „${category.id}“ už existuje.`);
  if (!isNew && !previous) throw new InvalidCatalogCategoryError(`Kategorie „${category.id}“ neexistuje.`);
  const { data: usage, error: usageError } = await client.from("catalog_items").select("kind").eq("category", category.id);
  if (usageError) throw usageError;
  const issue = categoryChangeIssue(previous, category, ((usage ?? []) as { kind: CatalogItemKind }[]).map((row) => row.kind));
  if (issue) throw new InvalidCatalogCategoryError(issue);
  const row: Record<string, unknown> = categoryToRow(category);
  if (register.parametersMigrated === false) delete row.recommended_parameters;
  const { data, error } = isNew
    ? await client.from("catalog_categories").insert(row).select(COLUMNS).single()
    : await client.from("catalog_categories").update(row).eq("id", category.id).select(COLUMNS).single();
  if (error) {
    if ((error as { code?: string }).code === "23505") throw new InvalidCatalogCategoryError(`Kategorie s identifikátorem „${category.id}“ už existuje.`);
    throw error;
  }
  return rowToCategory(data as CategoryRow) ?? category;
}
