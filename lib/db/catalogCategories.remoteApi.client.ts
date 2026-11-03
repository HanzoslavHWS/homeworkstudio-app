"use client";

import { useCallback, useEffect, useState } from "react";
import { BUILT_IN_CATALOG_CATEGORIES, type CatalogCategoryDef } from "../../domain/catalogClassification.ts";

export type CatalogCategoryRegisterState = Readonly<{
  categories: readonly CatalogCategoryDef[];
  /** false = built-in list (migration not applied yet, or the register could not be loaded) — read-only. */
  persisted: boolean;
  /** false = categories migrated, recommended parameters (20261023130000) not yet — templates read-only. */
  parametersMigrated: boolean;
  loaded: boolean;
  error?: string;
}>;

type Register = Readonly<{ categories: readonly CatalogCategoryDef[]; persisted: boolean; parametersMigrated: boolean }>;
let cache: Promise<Register> | undefined;

async function fetchRegister(): Promise<Register> {
  const response = await fetch("/api/catalog-admin/categories", { method: "GET", credentials: "same-origin" });
  const body = (await response.json()) as { categories?: CatalogCategoryDef[]; persisted?: boolean; parametersMigrated?: boolean; error?: string };
  if (!response.ok || !body.categories) throw new Error(body.error ?? "Kategorie se nepodařilo načíst.");
  return { categories: body.categories, persisted: body.persisted === true, parametersMigrated: body.persisted === true && body.parametersMigrated !== false };
}

/** The category register for forms and the category administration. Falls back to the built-in list on any failure. */
export function useCatalogCategories(): CatalogCategoryRegisterState & Readonly<{ reload: () => void }> {
  const [state, setState] = useState<CatalogCategoryRegisterState>({ categories: BUILT_IN_CATALOG_CATEGORIES, persisted: false, parametersMigrated: false, loaded: false });
  const load = useCallback((force: boolean) => {
    if (force || !cache) cache = fetchRegister();
    cache
      .then((register) => setState({ ...register, loaded: true }))
      .catch((error) => {
        cache = undefined;
        setState({ categories: BUILT_IN_CATALOG_CATEGORIES, persisted: false, parametersMigrated: false, loaded: true, error: error instanceof Error ? error.message : "Kategorie se nepodařilo načíst." });
      });
  }, []);
  useEffect(() => { load(false); }, [load]);
  return { ...state, reload: () => load(true) };
}

export async function saveCatalogCategoryRemote(category: CatalogCategoryDef, isNew: boolean): Promise<CatalogCategoryDef> {
  const response = await fetch("/api/catalog-admin/categories", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category, isNew }) });
  const body = (await response.json()) as { category?: CatalogCategoryDef; error?: string };
  if (!response.ok || !body.category) throw new Error(body.error ?? "Kategorii se nepodařilo uložit.");
  cache = undefined;
  return body.category;
}
