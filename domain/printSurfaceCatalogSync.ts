/**
 * Tiskové plochy — safe catalog synchronization (V1-DATA-02, design B1 in
 * docs/DEV_DATA_IMPORT_PLAN.md). Replaces the old delete-everything-then-insert `replaceAll`,
 * which detached tasks from their firm (`on delete set null`), failed once a print-surface project
 * referenced a firm, and left an empty catalog when the insert failed after the delete.
 *
 * Rules:
 *   - Nothing is deleted. Firms, presets and production dimensions are only inserted or updated.
 *   - An Excel column header is matched to an EXISTING firm first (by id, then by its working /
 *     legal / ABRA name or an active alias), so a renamed header never creates a second record of
 *     the same firm. Two firms matching one header is a blocking issue, never a guess.
 *   - An existing firm card is never overwritten by the Excel header (the card is edited in
 *     Administrace → Realizační firmy); a sync only creates firms that do not exist yet.
 *   - A preset or dimension that is missing from the file is kept as it is. Deactivating presets or
 *     imported firms that are missing from the file is opt-in and off by default; manually created
 *     firms are never deactivated by a sync.
 *   - Everything is written by one database function in one transaction (all or nothing).
 *
 * This file is pure: it plans, the caller (lib/printSurfaces/printSurfaceCatalogSyncApi.server.ts)
 * shows the plan as a preview and applies it.
 */

import type { PrintSurfaceExcelImportResult } from "./printSurfaceExcelImport.ts";
import type { PrintSurfacePreset } from "./printSurfacePreset.ts";
import type { PrintSurfaceProductionDimension } from "./printSurfaceProductionDimension.ts";
import type { RealizationCompany, RealizationCompanyAlias, RealizationLegacyId } from "./realizationCompany.ts";
import { findCompanyByName, RESERVED_REALIZATION_COMPANY_IDS } from "./realizationCompanyIdentity.ts";

export type PrintSurfaceCatalogSnapshot = Readonly<{
  companies: readonly RealizationCompany[];
  aliases: readonly RealizationCompanyAlias[];
  legacyIds: readonly RealizationLegacyId[];
  presets: readonly PrintSurfacePreset[];
  productionDimensions: readonly PrintSurfaceProductionDimension[];
}>;

export type PrintSurfaceCatalogSyncOptions = Readonly<{
  /** Deactivate presets that the file no longer lists. Default false. */
  deactivateMissingPresets?: boolean;
  /** Deactivate IMPORTED firms that the file no longer lists. Default false. Manual firms are never touched. */
  deactivateMissingCompanies?: boolean;
}>;

export type CompanySyncAction =
  | Readonly<{ excelName: string; action: "create"; id: string }>
  | Readonly<{ excelName: string; action: "existing"; id: string; companyName: string; matchedBy: "id" | "name"; inactive: boolean }>;

export type PrintSurfaceCatalogSyncIssue = Readonly<{
  severity: "error" | "warning";
  code: "IMPORT_HAS_ERRORS" | "AMBIGUOUS_COMPANY" | "RESERVED_COMPANY_ID" | "INACTIVE_COMPANY" | "COMPANY_ID_TAKEN_BY_OTHER_NAME" | "DUPLICATE_COMPANY_COLUMN";
  message: string;
}>;

type ChangeCounts = Readonly<{ create: number; update: number; unchanged: number }>;

export type PrintSurfaceCatalogSyncPayload = Readonly<{
  companies: readonly Readonly<{ id: string; name: string }>[];
  presets: readonly PrintSurfacePreset[];
  productionDimensions: readonly PrintSurfaceProductionDimension[];
  deactivateCompanyIds: readonly string[];
  deactivatePresetIds: readonly string[];
}>;

export type PrintSurfaceCatalogSyncPlan = Readonly<{
  companies: readonly CompanySyncAction[];
  presets: ChangeCounts;
  productionDimensions: ChangeCounts;
  /** Kept untouched (or deactivated when the option is on). */
  missingPresetIds: readonly string[];
  missingCompanyIds: readonly string[];
  /** Dimensions in the database the file does not mention — always kept. */
  keptDimensionCount: number;
  issues: readonly PrintSurfaceCatalogSyncIssue[];
  canApply: boolean;
  payload: PrintSurfaceCatalogSyncPayload;
}>;

function dimensionKey(dimension: Pick<PrintSurfaceProductionDimension, "realizationCompanyId" | "presetId">): string {
  return `${dimension.realizationCompanyId}\u0000${dimension.presetId}`;
}

function samePreset(a: PrintSurfacePreset, b: PrintSurfacePreset): boolean {
  return a.typeId === b.typeId
    && a.name === b.name
    && (a.description ?? undefined) === (b.description ?? undefined)
    && a.isActive === b.isActive
    && (a.parentId ?? undefined) === (b.parentId ?? undefined)
    && (a.parentName ?? undefined) === (b.parentName ?? undefined);
}

function sameDimension(a: PrintSurfaceProductionDimension, b: PrintSurfaceProductionDimension): boolean {
  if (a.status !== b.status || (a.note ?? undefined) !== (b.note ?? undefined)) return false;
  if (a.status === "available" && b.status === "available") return a.widthMm === b.widthMm && a.heightMm === b.heightMm;
  return true;
}

export function planPrintSurfaceCatalogSync(
  imported: PrintSurfaceExcelImportResult,
  current: PrintSurfaceCatalogSnapshot,
  options: PrintSurfaceCatalogSyncOptions = {},
): PrintSurfaceCatalogSyncPlan {
  const issues: PrintSurfaceCatalogSyncIssue[] = [];
  if (imported.counts.errors > 0) {
    issues.push({ severity: "error", code: "IMPORT_HAS_ERRORS", message: "Excel obsahuje chyby — opravte je a nahrajte soubor znovu." });
  }

  // --- firms: header → existing id, or a new one -------------------------------------------
  const reserved = new Set([...RESERVED_REALIZATION_COMPANY_IDS, ...current.legacyIds.map((legacy) => legacy.legacyId)]);
  const companyActions: CompanySyncAction[] = [];
  const idByImportedId = new Map<string, string>();
  for (const importedCompany of imported.companies) {
    const byId = current.companies.find((company) => company.id === importedCompany.id);
    const byName = findCompanyByName(importedCompany.name, current.companies, current.aliases);

    if (byName.kind === "ambiguous") {
      issues.push({
        severity: "error",
        code: "AMBIGUOUS_COMPANY",
        message: `Sloupec „${importedCompany.name}“ odpovídá více firmám (${byName.companies.map((company) => company.name).join(", ")}). Upravte názvy nebo alternativní názvy firem.`,
      });
      continue;
    }
    if (byName.kind === "one" && byId && byName.company.id !== byId.id) {
      issues.push({
        severity: "error",
        code: "COMPANY_ID_TAKEN_BY_OTHER_NAME",
        message: `Sloupec „${importedCompany.name}“ má ID ${importedCompany.id} firmy „${byId.name}“, ale názvem odpovídá firmě „${byName.company.name}“.`,
      });
      continue;
    }
    const existing = byId ?? (byName.kind === "one" ? byName.company : undefined);
    const resolvedId = existing?.id ?? importedCompany.id;
    const otherColumn = companyActions.find((action) => action.id === resolvedId);
    if (otherColumn) {
      issues.push({ severity: "error", code: "DUPLICATE_COMPANY_COLUMN", message: `Sloupce „${otherColumn.excelName}“ a „${importedCompany.name}“ patří stejné firmě. Ponechte v Excelu jen jeden.` });
      continue;
    }
    if (existing) {
      idByImportedId.set(importedCompany.id, existing.id);
      companyActions.push({ excelName: importedCompany.name, action: "existing", id: existing.id, companyName: existing.name, matchedBy: byId ? "id" : "name", inactive: !existing.isActive });
      if (!existing.isActive) {
        issues.push({ severity: "warning", code: "INACTIVE_COMPANY", message: `Firma „${existing.name}“ je neaktivní. Rozměry se uloží, firmu aktivujte v Administraci, pokud ji chcete znovu nabízet.` });
      }
      continue;
    }
    if (reserved.has(importedCompany.id)) {
      issues.push({ severity: "error", code: "RESERVED_COMPANY_ID", message: `Sloupec „${importedCompany.name}“ by dostal vyhrazené ID ${importedCompany.id}. Přejmenujte sloupec v Excelu.` });
      continue;
    }
    idByImportedId.set(importedCompany.id, importedCompany.id);
    companyActions.push({ excelName: importedCompany.name, action: "create", id: importedCompany.id });
  }

  // --- presets ------------------------------------------------------------------------------
  const currentPresets = new Map(current.presets.map((preset) => [preset.id, preset] as const));
  const presetCounts = { create: 0, update: 0, unchanged: 0 };
  for (const preset of imported.presets) {
    const existing = currentPresets.get(preset.id);
    if (!existing) presetCounts.create += 1;
    else if (samePreset(existing, preset)) presetCounts.unchanged += 1;
    else presetCounts.update += 1;
  }
  const importedPresetIds = new Set(imported.presets.map((preset) => preset.id));
  const missingPresetIds = current.presets.filter((preset) => !importedPresetIds.has(preset.id)).map((preset) => preset.id);

  // --- production dimensions (re-keyed onto the resolved firm ids) ----------------------------
  const dimensions = imported.productionDimensions
    .filter((dimension) => idByImportedId.has(dimension.realizationCompanyId))
    .map((dimension) => ({ ...dimension, realizationCompanyId: idByImportedId.get(dimension.realizationCompanyId)! }) as PrintSurfaceProductionDimension);
  const currentDimensions = new Map(current.productionDimensions.map((dimension) => [dimensionKey(dimension), dimension] as const));
  const dimensionCounts = { create: 0, update: 0, unchanged: 0 };
  for (const dimension of dimensions) {
    const existing = currentDimensions.get(dimensionKey(dimension));
    if (!existing) dimensionCounts.create += 1;
    else if (sameDimension(existing, dimension)) dimensionCounts.unchanged += 1;
    else dimensionCounts.update += 1;
  }
  const importedDimensionKeys = new Set(dimensions.map(dimensionKey));
  const keptDimensionCount = current.productionDimensions.filter((dimension) => !importedDimensionKeys.has(dimensionKey(dimension))).length;

  // --- firms missing from the file -----------------------------------------------------------
  const resolvedIds = new Set(idByImportedId.values());
  const missingCompanyIds = current.companies.filter((company) => !resolvedIds.has(company.id)).map((company) => company.id);
  const deactivateCompanyIds = options.deactivateMissingCompanies
    ? current.companies.filter((company) => missingCompanyIds.includes(company.id) && company.isActive && (company.source ?? "import") === "import").map((company) => company.id)
    : [];
  const deactivatePresetIds = options.deactivateMissingPresets
    ? current.presets.filter((preset) => missingPresetIds.includes(preset.id) && preset.isActive).map((preset) => preset.id)
    : [];

  const canApply = !issues.some((issue) => issue.severity === "error");
  return {
    companies: companyActions,
    presets: presetCounts,
    productionDimensions: dimensionCounts,
    missingPresetIds,
    missingCompanyIds,
    keptDimensionCount,
    issues,
    canApply,
    payload: {
      companies: companyActions.filter((action) => action.action === "create").map((action) => ({ id: action.id, name: action.excelName })),
      presets: imported.presets,
      productionDimensions: dimensions,
      deactivateCompanyIds,
      deactivatePresetIds,
    },
  };
}
