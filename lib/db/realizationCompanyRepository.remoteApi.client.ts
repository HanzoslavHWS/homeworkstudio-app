"use client";

import type {
  RealizationCompany,
  RealizationCompanyAlias,
  RealizationCompanyAliasInput,
  RealizationCompanyCardInput,
  RealizationCompanyRepository,
  RealizationLegacyId,
} from "../../domain/realizationCompany.ts";
import type { PrintSurfaceCatalogSyncOptions, PrintSurfaceCatalogSyncPlan } from "../../domain/printSurfaceCatalogSync.ts";
import type { PrintSurfaceExcelImportResult } from "../../domain/printSurfaceExcelImport.ts";
import { RemoteApiUnavailableError } from "./projectRepository.remoteApi.client.ts";

async function throwForFailedResponse(response: Response, fallbackMessage: string): Promise<never> {
  let message = fallbackMessage;
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // response body wasn't JSON — keep the fallback message
  }
  throw new RemoteApiUnavailableError(response.status, message);
}

async function postJson<T>(url: string, body: unknown, fallbackMessage: string): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) await throwForFailedResponse(response, fallbackMessage);
  return (await response.json()) as T;
}

/** Browser-side read of the firm register, through the shared print-surface catalog route (tasks, print surfaces and the generator only need the list). */
export class RemoteApiRealizationCompanyRepository implements RealizationCompanyRepository {
  async list(): Promise<readonly RealizationCompany[]> {
    const response = await fetch("/api/print-surfaces/catalog", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst realizační společnosti z databáze.");
    const body = (await response.json()) as { companies: readonly RealizationCompany[] };
    return body.companies;
  }
}

export type RealizationCompanyRegister = Readonly<{
  companies: readonly RealizationCompany[];
  aliases: readonly RealizationCompanyAlias[];
  legacyIds: readonly RealizationLegacyId[];
}>;

/** Administrace → Realizační firmy (app/api/realization-companies). */
export const realizationCompanyAdminApi = {
  async load(): Promise<RealizationCompanyRegister> {
    const response = await fetch("/api/realization-companies", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Realizační firmy se nepodařilo načíst.");
    return (await response.json()) as RealizationCompanyRegister;
  },
  async create(card: RealizationCompanyCardInput, aliases: readonly RealizationCompanyAliasInput[]): Promise<RealizationCompany> {
    const body = await postJson<{ company: RealizationCompany }>("/api/realization-companies", { card, aliases }, "Firmu se nepodařilo založit.");
    return body.company;
  },
  async update(id: string, card: RealizationCompanyCardInput, aliases: readonly RealizationCompanyAliasInput[]): Promise<RealizationCompany> {
    const body = await postJson<{ company: RealizationCompany }>("/api/realization-companies/update", { id, card, aliases }, "Kartu firmy se nepodařilo uložit.");
    return body.company;
  },
};

/** Tiskové plochy — preview and apply of the non-destructive catalog sync (app/api/print-surfaces/catalog/sync). */
export const printSurfaceCatalogSyncApi = {
  async preview(imported: PrintSurfaceExcelImportResult, options: PrintSurfaceCatalogSyncOptions): Promise<PrintSurfaceCatalogSyncPlan> {
    const body = await postJson<{ plan: PrintSurfaceCatalogSyncPlan }>("/api/print-surfaces/catalog/sync", { mode: "preview", imported, options }, "Náhled synchronizace se nepodařilo připravit.");
    return body.plan;
  },
  async apply(imported: PrintSurfaceExcelImportResult, options: PrintSurfaceCatalogSyncOptions): Promise<PrintSurfaceCatalogSyncPlan> {
    const body = await postJson<{ plan: PrintSurfaceCatalogSyncPlan }>("/api/print-surfaces/catalog/sync", { mode: "apply", imported, options }, "Synchronizace katalogu tiskových ploch selhala, nic nebylo změněno.");
    return body.plan;
  },
};
