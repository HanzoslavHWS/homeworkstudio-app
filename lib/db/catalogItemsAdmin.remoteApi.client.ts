"use client";

import type { BulkLifecycleOutcome, BulkLifecycleRequest, CatalogItemAdmin, CatalogItemAdminCreateInput, CatalogItemAdminEdit } from "../../domain/catalogItemsAdmin.ts";
import type { CatalogPackageItem, CatalogPackageItemInput } from "../../domain/catalogPackages.ts";
import type { CatalogItemAlias, CatalogItemAliasInput } from "../../domain/catalogItemAliases.ts";
import type { CatalogUnit } from "../../domain/catalogUnits.ts";
import type { CatalogVariantSet, CatalogVariantSetInput } from "../../domain/catalogVariants.ts";
import type { RealizationCompany } from "../../domain/realizationCompany.ts";
import { ConcurrencyConflictError } from "./concurrency.ts";
import { RemoteApiUnavailableError } from "./projectRepository.remoteApi.client.ts";

export type CatalogAliasRegister = Readonly<{ aliases: readonly CatalogItemAlias[]; companies: readonly RealizationCompany[]; units: readonly CatalogUnit[] }>;

async function throwForFailedResponse(response: Response, fallbackMessage: string): Promise<never> {
  let message = fallbackMessage;
  try {
    const body = (await response.json()) as { error?: string; issues?: unknown };
    if (body.error) message = body.error;
    // Kit and swatch-book validation report every problem at once — show them all, not just the first.
    const issues = Array.isArray(body.issues) ? body.issues.filter((issue): issue is string => typeof issue === "string") : [];
    if (issues.length > 1) message = issues.join("\n");
  } catch {
    // response body wasn't JSON — keep the fallback message
  }
  throw new RemoteApiUnavailableError(response.status, message);
}

/**
 * Browser-side counterpart to lib/db/catalogItemsAdmin.supabase.ts — full admin read/write,
 * unlike RemoteApiCatalogPricingRepository (lib/db/catalogPricing.remoteApi.client.ts), which
 * is a narrow read-only customer-safe summary for technical-service pricing only.
 */
export class RemoteApiCatalogItemsAdminRepository {
  async list(): Promise<readonly CatalogItemAdmin[]> {
    const response = await fetch("/api/catalog-admin/items", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst katalogové položky z databáze.");
    const body = (await response.json()) as { catalogItems: readonly CatalogItemAdmin[] };
    return body.catalogItems;
  }

  async create(input: CatalogItemAdminCreateInput): Promise<CatalogItemAdmin> {
    const response = await fetch("/api/catalog-admin/items/create", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ create: input }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Vytvoření katalogové položky selhalo.");
    const body = (await response.json()) as { catalogItem: CatalogItemAdmin };
    return body.catalogItem;
  }

  async save(id: string, edit: CatalogItemAdminEdit, expectedUpdatedAt: string | null): Promise<CatalogItemAdmin> {
    const response = await fetch("/api/catalog-admin/items/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, edit, expectedUpdatedAt }),
    });
    if (response.status === 409) {
      // 409 is either a concurrency conflict or a domain conflict (duplicate ABF/internal code,
      // schema not migrated) — only the former has no specific server message worth showing.
      let message: string | undefined;
      try {
        message = ((await response.clone().json()) as { error?: string }).error;
      } catch {
        message = undefined;
      }
      if (message && !message.startsWith("Data byla mezitím změněna")) throw new RemoteApiUnavailableError(409, message);
      throw new ConcurrencyConflictError("catalog_item", id);
    }
    if (!response.ok) await throwForFailedResponse(response, "Uložení katalogové položky do databáze selhalo.");
    const body = (await response.json()) as { catalogItem: CatalogItemAdmin };
    return body.catalogItem;
  }

  async duplicate(id: string): Promise<CatalogItemAdmin> {
    const response = await fetch("/api/catalog-admin/items/duplicate", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Duplikace katalogové položky selhala.");
    const body = (await response.json()) as { catalogItem: CatalogItemAdmin };
    return body.catalogItem;
  }

  async bulkLifecycle(request: BulkLifecycleRequest): Promise<Readonly<{ outcomes: readonly BulkLifecycleOutcome[]; items: readonly CatalogItemAdmin[] }>> {
    const response = await fetch("/api/catalog-admin/items/lifecycle", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request),
    });
    if (!response.ok) await throwForFailedResponse(response, "Hromadná akce selhala.");
    return (await response.json()) as { outcomes: readonly BulkLifecycleOutcome[]; items: readonly CatalogItemAdmin[] };
  }

  async savePackage(packageItemId: string, items: readonly CatalogPackageItemInput[]): Promise<Readonly<{ packageItems: readonly CatalogPackageItem[]; warnings: readonly string[] }>> {
    const response = await fetch("/api/catalog-admin/items/package", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packageItemId, items }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Uložení obsahu kompletu selhalo.");
    const body = (await response.json()) as { packageItems: readonly CatalogPackageItem[]; warnings?: readonly string[] };
    return { packageItems: body.packageItems, warnings: body.warnings ?? [] };
  }

  /** Swatch books with all variants (V1-DATA-04). */
  async loadVariantSets(): Promise<readonly CatalogVariantSet[]> {
    const response = await fetch("/api/catalog-admin/variant-sets", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Vzorníky se nepodařilo načíst.");
    return ((await response.json()) as { variantSets: readonly CatalogVariantSet[] }).variantSets;
  }

  /** Saves one swatch book (variants are never deleted, only deactivated). */
  async saveVariantSet(variantSet: CatalogVariantSetInput): Promise<CatalogVariantSet> {
    const response = await fetch("/api/catalog-admin/variant-sets", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ variantSet }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Vzorník se nepodařilo uložit.");
    return ((await response.json()) as { variantSet: CatalogVariantSet }).variantSet;
  }

  /** Aliases of every item + the unit register + realization companies (V1-DATA-03). */
  async loadAliases(): Promise<CatalogAliasRegister> {
    const response = await fetch("/api/catalog-admin/items/aliases", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Aliasy se nepodařilo načíst.");
    return (await response.json()) as CatalogAliasRegister;
  }

  /** Replaces one item's alias list (removed aliases are deactivated, never deleted). */
  async saveAliases(catalogItemId: string, aliases: readonly CatalogItemAliasInput[]): Promise<readonly CatalogItemAlias[]> {
    const response = await fetch("/api/catalog-admin/items/aliases", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ catalogItemId, aliases }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Aliasy se nepodařilo uložit.");
    return ((await response.json()) as { aliases: readonly CatalogItemAlias[] }).aliases;
  }

  /** KODY.xlsm import — mode "preview" never writes; "apply" re-plans on the server and writes. */
  async abfImport<T>(file: File, mode: "preview" | "apply", linkConfirmations: Readonly<Record<string, string>>): Promise<T> {
    const form = new FormData();
    form.append("file", file);
    form.append("mode", mode);
    form.append("linkConfirmations", JSON.stringify(linkConfirmations));
    const response = await fetch("/api/catalog-admin/abf-import", { method: "POST", credentials: "same-origin", body: form });
    if (!response.ok) await throwForFailedResponse(response, mode === "preview" ? "Náhled importu selhal." : "Import selhal.");
    const body = (await response.json()) as { preview?: T; result?: T };
    return (mode === "preview" ? body.preview : body.result) as T;
  }
}
