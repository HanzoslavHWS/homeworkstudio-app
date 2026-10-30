/**
 * ABRA order import — NON-DESTRUCTIVE reconciliation with the project's existing technical services.
 *
 * The order form is the primary source, but it never deletes or rewrites what earlier sources (the
 * per-category reports, an earlier order import) put into the raster. Every source keeps its own
 * evidence: the order import's lines are stored on its own import record
 * (TechnicalRasterImport.orderLines); the drawn services carry their sources
 * (TechnicalService.sources). Per stand and per service identity (category + variant of the approved
 * marker table — the same identity the markers and the re-import use) the orders are compared with the
 * services already in the raster:
 *
 *   matched          same total quantity            -> nothing new drawn; the orders are added as a source
 *   new              only in the orders             -> "Nová služba k doplnění" — added only when confirmed
 *   onlyExisting     only in the raster             -> kept untouched, listed: "Služba je v předchozím
 *                                                     technickém výjezdu, ale v nových objednávkách chybí."
 *   quantityDiff     both, different total quantity -> both quantities + difference shown; the raster
 *                                                     changes only when confirmed
 * L63 "BEZ ELEKTRICKÉ ENERGIE" is reconciled with the red "BEZ elektriky" X the same way (offer / match /
 * keep + warn), and an order that has L63 AND an electricity connection is a conflict to review.
 * Placements are never moved; a confirmed quantity decrease is the only thing that can drop surplus
 * points, and the preview says how many.
 */
import type { AbraOrderTechnicalImport, AbraOrderTechnicalLine } from "./abraOrderTechnicalImport.ts";
import {
  ABRA_ORDER_IMPORT_CATEGORY,
  ABRA_ORDER_TECHNICAL_CATEGORIES,
  UNASSIGNED_PLACEMENT,
  effectiveServicePlacements,
  effectiveServiceSources,
  rematchStands,
  requiredPlacementCount,
  type PlacementLossItem,
  type TechnicalImportServiceDiff,
  type TechnicalRasterImport,
  type TechnicalRasterProject,
  type TechnicalService,
  type TechnicalServiceChange,
  type TechnicalServiceSource,
  type TechnicalStand,
} from "./technicalRaster.ts";
import { resolveServiceIdentityKey } from "./technicalRasterReconciliation.ts";
import { resolveTechnicalServicePresentation } from "./technicalRasterServicePresentation.ts";
import { technicalServiceCategoryLabel } from "./technicalServiceCatalog.ts";
import { normalizeStandNumber, sortStandNumbersNatural } from "./technicalStandNumber.ts";

export type ReconciliationKind = "matched" | "new" | "onlyExisting" | "quantityDiff";

/** One existing service in the raster, with where it comes from. */
export type ExistingServiceRef = Readonly<{
  serviceId: string;
  quantity: number;
  placementCount: number;
  externalLabel: string;
  /** Human-readable sources, e.g. "Výjezd Elektrická energie (elektro.pdf) 2×", "Objednávky ABRA — předchozí import (…) 1×". */
  sourceLabels: readonly string[];
}>;

export type ServiceReconciliationItem = Readonly<{
  /** Stable id for the user's decision checkboxes. */
  id: string;
  kind: ReconciliationKind;
  standNumber: string;
  category: string;
  /** The marker text ("3 kW", "El.rozvaděč"). */
  displayLabel: string;
  externalLabel: string;
  existing: readonly ExistingServiceRef[];
  orderLines: readonly AbraOrderTechnicalLine[];
  existingQuantity: number;
  orderQuantity: number;
  /** Placements a confirmed quantity decrease would drop (0 for everything else). */
  placementsDroppedIfApplied: number;
}>;

export type NoElectricityReconciliationItem = Readonly<{
  id: string;
  kind: "new" | "matched" | "onlyExisting" | "conflict";
  standNumber: string;
  orderNumbers: readonly string[];
  /** Where the existing "BEZ elektriky" X comes from, when there is one. */
  existingSource?: "report" | "abra-orders" | "manual";
  message: string;
}>;

export type AbraOrderReconciliation = Readonly<{
  services: readonly ServiceReconciliationItem[];
  noElectricity: readonly NoElectricityReconciliationItem[];
  counts: Readonly<{ matched: number; new: number; onlyExisting: number; quantityDiff: number; noElectricityNew: number; noElectricityConflicts: number; noElectricityOnlyExisting: number }>;
  /** The decisions pre-selected in the preview: every new service and every new "BEZ elektriky"; no quantity change. */
  defaultAcceptedIds: ReadonlySet<string>;
}>;

export const ONLY_EXISTING_MESSAGE = "Služba je v předchozím technickém výjezdu, ale v nových objednávkách chybí.";

function sourceLabel(project: TechnicalRasterProject, source: TechnicalServiceSource): string {
  const record = project.imports.find((existing) => existing.id === source.importId);
  if (!record) return `Neznámý zdroj ${source.quantity}×`;
  const kind = record.category === ABRA_ORDER_IMPORT_CATEGORY
    ? `Objednávky ABRA${record.supersededByImportId ? " — předchozí import" : ""}${source.orderNumber ? ` ${source.orderNumber}` : ""}`
    : `Výjezd ${technicalServiceCategoryLabel(record.category)}`;
  return `${kind} (${record.filename}) ${source.quantity}×`;
}

function existingRef(project: TechnicalRasterProject, service: TechnicalService): ExistingServiceRef {
  return {
    serviceId: service.id,
    quantity: service.quantity,
    placementCount: effectiveServicePlacements(service).length,
    externalLabel: service.externalLabel,
    sourceLabels: effectiveServiceSources(service).map((source) => sourceLabel(project, source)),
  };
}

const sum = (values: readonly number[]) => Math.round(values.reduce((total, value) => total + value, 0) * 1000) / 1000;

/** Placements dropped when the group's total quantity is lowered to `target` (applied to the services in order). */
function droppedPlacements(services: readonly TechnicalService[], target: number): number {
  return adjustGroupQuantity(services, target).reduce((dropped, change) => dropped + change.droppedPlacements, 0);
}

/** The largest cut (≤ `limit`, in 0.001 steps) that still leaves room for every point already placed on the service. */
function cutKeepingPlacements(service: TechnicalService, limit: number): number {
  const placed = effectiveServicePlacements(service).length;
  let low = 0;
  let high = Math.round(limit * 1000);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (requiredPlacementCount({ ...service, quantity: service.quantity - middle / 1000 }) >= placed) low = middle;
    else high = middle - 1;
  }
  return low / 1000;
}

/**
 * New quantities for a group so its total becomes `target`. An increase goes to the first service. A
 * decrease removes NOT-YET-PLACED points first, on every service of the group; only what is still left
 * after that cuts into placed points (services in order).
 */
function adjustGroupQuantity(services: readonly TechnicalService[], target: number): { service: TechnicalService; quantity: number; droppedPlacements: number }[] {
  let delta = Math.round((target - sum(services.map((service) => service.quantity))) * 1000) / 1000;
  const quantities = services.map((service) => service.quantity);
  if (delta > 0 && quantities.length > 0) quantities[0] = quantities[0]! + delta;
  if (delta < 0) {
    services.forEach((service, index) => {
      const cut = cutKeepingPlacements(service, Math.min(quantities[index]!, -delta));
      quantities[index] = quantities[index]! - cut;
      delta = Math.round((delta + cut) * 1000) / 1000;
    });
    services.forEach((_, index) => {
      const cut = Math.min(quantities[index]!, -delta);
      quantities[index] = quantities[index]! - cut;
      delta = Math.round((delta + cut) * 1000) / 1000;
    });
  }
  return services.map((service, index) => {
    const quantity = Math.round(quantities[index]! * 1000) / 1000;
    const required = requiredPlacementCount({ ...service, quantity });
    return { service, quantity, droppedPlacements: Math.max(0, effectiveServicePlacements(service).length - required) };
  });
}

/** Placed points the accepted order decisions would remove — the confirm button requires an explicit "yes" when this is not empty. */
export function placementLossOfOrderDecisions(reconciliation: AbraOrderReconciliation, acceptedIds: ReadonlySet<string>): readonly PlacementLossItem[] {
  return reconciliation.services
    .filter((item) => item.kind === "quantityDiff" && item.placementsDroppedIfApplied > 0 && acceptedIds.has(item.id))
    .map((item) => ({ standNumber: item.standNumber, externalLabel: item.externalLabel, previousQuantity: item.existingQuantity, quantity: item.orderQuantity, placementCount: item.placementsDroppedIfApplied }));
}

function findStand(project: TechnicalRasterProject, standNumber: string): TechnicalStand | undefined {
  const key = normalizeStandNumber(standNumber);
  return project.stands.find((stand) => normalizeStandNumber(stand.standNumber) === key);
}

/** Compares the orders with the raster — pure, nothing is changed. */
export function reconcileAbraOrdersWithProject(project: TechnicalRasterProject, orderImport: AbraOrderTechnicalImport): AbraOrderReconciliation {
  const services: ServiceReconciliationItem[] = [];
  const linesByStand = new Map<string, AbraOrderTechnicalLine[]>();
  for (const line of orderImport.importedLines) {
    const key = normalizeStandNumber(line.standNumber!);
    linesByStand.set(key, [...(linesByStand.get(key) ?? []), line]);
  }
  const standKeys = new Set<string>([...linesByStand.keys()]);
  for (const stand of project.stands) {
    if (stand.placement.status === "outside_current_raster") continue;
    if (stand.services.some((service) => ABRA_ORDER_TECHNICAL_CATEGORIES.includes(service.category))) standKeys.add(normalizeStandNumber(stand.standNumber));
  }

  for (const standKey of sortStandNumbersNatural([...standKeys], (key) => key)) {
    const stand = findStand(project, standKey);
    const lines = linesByStand.get(standKey) ?? [];
    const standNumber = stand?.standNumber ?? lines[0]!.standNumber!;
    const groups = new Map<string, { category: string; externalLabel: string; existing: TechnicalService[]; lines: AbraOrderTechnicalLine[] }>();
    const groupOf = (category: string, externalLabel: string) => {
      const key = resolveServiceIdentityKey(category, externalLabel);
      const group = groups.get(key) ?? { category, externalLabel, existing: [], lines: [] };
      groups.set(key, group);
      return group;
    };
    for (const service of stand?.services ?? []) if (ABRA_ORDER_TECHNICAL_CATEGORIES.includes(service.category)) groupOf(service.category, service.externalLabel).existing.push(service);
    for (const line of lines) groupOf(line.category, line.externalLabel).lines.push(line);

    for (const [key, group] of groups) {
      const existingQuantity = sum(group.existing.map((service) => service.quantity));
      const orderQuantity = sum(group.lines.map((line) => line.quantity ?? 0));
      const kind: ReconciliationKind = group.existing.length === 0 ? "new" : group.lines.length === 0 ? "onlyExisting" : existingQuantity === orderQuantity ? "matched" : "quantityDiff";
      const displayQuantity = group.lines[0]?.quantity ?? group.existing[0]?.quantity;
      services.push({
        id: `${kind}:${standKey}:${key}`,
        kind,
        standNumber,
        category: group.category,
        displayLabel: resolveTechnicalServicePresentation(group.category, group.existing[0]?.externalLabel ?? group.externalLabel, displayQuantity).displayLabel ?? group.externalLabel,
        externalLabel: group.existing[0]?.externalLabel ?? group.externalLabel,
        existing: group.existing.map((service) => existingRef(project, service)),
        orderLines: group.lines,
        existingQuantity,
        orderQuantity,
        placementsDroppedIfApplied: kind === "quantityDiff" ? droppedPlacements(group.existing, orderQuantity) : 0,
      });
    }
  }

  // "BEZ elektriky" (L63)
  const noElectricity: NoElectricityReconciliationItem[] = [];
  const l63ByStand = new Map<string, string[]>();
  for (const line of orderImport.noElectricityLines) {
    if (!line.standNumber) continue;
    const key = normalizeStandNumber(line.standNumber);
    l63ByStand.set(key, [...(l63ByStand.get(key) ?? []), line.orderNumber]);
  }
  for (const [standKey, orderNumbers] of l63ByStand) {
    const stand = findStand(project, standKey);
    const standNumber = stand?.standNumber ?? orderImport.noElectricityLines.find((line) => line.standNumber && normalizeStandNumber(line.standNumber) === standKey)!.standNumber!;
    const has = stand?.hasNoElectricityAssignment === true;
    noElectricity.push(has
      ? { id: `l63-matched:${standKey}`, kind: "matched", standNumber, orderNumbers, existingSource: stand?.noElectricitySource ?? "report", message: "BEZ elektriky je v objednávkách i v rastru." }
      : { id: `l63-new:${standKey}`, kind: "new", standNumber, orderNumbers, message: "Objednávka uvádí L63 BEZ ELEKTRICKÉ ENERGIE — doplnit červené X „BEZ elektriky“." });
    const orderedElectricity = (linesByStand.get(standKey) ?? []).filter((line) => line.category === "electricity");
    const existingElectricity = (stand?.services ?? []).filter((service) => service.category === "electricity");
    if (orderedElectricity.length > 0 || existingElectricity.length > 0) {
      noElectricity.push({
        id: `l63-conflict:${standKey}`, kind: "conflict", standNumber, orderNumbers,
        message: `Rozpor: L63 BEZ ELEKTRICKÉ ENERGIE, ale stánek má elektrickou přípojku (${[...orderedElectricity.map((line) => `${line.code} v objednávce ${line.orderNumber}`), ...existingElectricity.map((service) => `${service.externalLabel} v rastru`)].join(", ")}).`,
      });
    }
  }
  for (const stand of project.stands) {
    if (!stand.hasNoElectricityAssignment || l63ByStand.has(normalizeStandNumber(stand.standNumber)) || stand.placement.status === "outside_current_raster") continue;
    noElectricity.push({ id: `l63-only:${normalizeStandNumber(stand.standNumber)}`, kind: "onlyExisting", standNumber: stand.standNumber, orderNumbers: [], existingSource: stand.noElectricitySource ?? "report", message: "BEZ elektriky je v rastru, ale v nových objednávkách chybí L63 — ponecháno." });
  }

  const count = (kind: ReconciliationKind) => services.filter((item) => item.kind === kind).length;
  return {
    services,
    noElectricity,
    counts: {
      matched: count("matched"), new: count("new"), onlyExisting: count("onlyExisting"), quantityDiff: count("quantityDiff"),
      noElectricityNew: noElectricity.filter((item) => item.kind === "new").length,
      noElectricityConflicts: noElectricity.filter((item) => item.kind === "conflict").length,
      noElectricityOnlyExisting: noElectricity.filter((item) => item.kind === "onlyExisting").length,
    },
    defaultAcceptedIds: new Set([...services.filter((item) => item.kind === "new").map((item) => item.id), ...noElectricity.filter((item) => item.kind === "new").map((item) => item.id)]),
  };
}

function orderSource(importId: string, line: AbraOrderTechnicalLine): TechnicalServiceSource {
  return { importId, quantity: line.quantity ?? 0, abfCode: line.code, orderNumber: line.orderNumber, itemName: line.name, ...(line.notes.length > 0 ? { notes: line.notes } : {}) };
}

/**
 * Applies a confirmed order import: stores the import with its own lines, adds the orders as a source of
 * matched services, adds ONLY the accepted new services / quantity changes / "BEZ elektriky" marks.
 * Nothing that is not accepted changes; no existing service is ever removed. The previous order import
 * is marked superseded (history); its services stay.
 */
export function applyAbraOrderImport(
  project: TechnicalRasterProject,
  importRecord: TechnicalRasterImport,
  orderImport: AbraOrderTechnicalImport,
  acceptedIds: ReadonlySet<string>,
): Readonly<{ project: TechnicalRasterProject; diff: TechnicalImportServiceDiff; reconciliation: AbraOrderReconciliation }> {
  const reconciliation = reconcileAbraOrdersWithProject(project, orderImport);
  const changes: TechnicalServiceChange[] = [];
  const updates = new Map<string, Partial<TechnicalService>>();
  const additions = new Map<string, TechnicalService[]>();
  const noElectricityStands = new Set<string>();
  const previousOrderImportIds = new Set(project.imports.filter((existing) => existing.category === ABRA_ORDER_IMPORT_CATEGORY).map((existing) => existing.id));
  /** The service's sources without any earlier order import, plus this import's lines (an order-only service with no line left keeps its history). */
  const withOrderEvidence = (service: TechnicalService, lines: readonly AbraOrderTechnicalLine[]) => {
    const sources = [...effectiveServiceSources(service).filter((source) => !previousOrderImportIds.has(source.importId)), ...lines.map((line) => orderSource(importRecord.id, line))];
    if (sources.length > 0) updates.set(service.id, { ...updates.get(service.id), sources });
  };
  /**
   * The group's order lines spread over its drawn services: each line goes to the service of the same
   * ABRA order and code first, then to a service that has no line yet, else to the first one.
   */
  const distributeOrderLines = (groupServices: readonly TechnicalService[], lines: readonly AbraOrderTechnicalLine[]) => {
    const assigned = new Map<string, AbraOrderTechnicalLine[]>(groupServices.map((service) => [service.id, []]));
    for (const line of lines) {
      const target = groupServices.find((service) => assigned.get(service.id)!.length === 0 && service.sourceOrderNumber === line.orderNumber && service.abfCode === line.code)
        ?? groupServices.find((service) => assigned.get(service.id)!.length === 0)
        ?? groupServices[0]!;
      assigned.get(target.id)!.push(line);
    }
    for (const service of groupServices) withOrderEvidence(service, assigned.get(service.id)!);
  };

  for (const item of reconciliation.services) {
    const stand = findStand(project, item.standNumber);
    const groupServices = (stand?.services ?? []).filter((service) => item.existing.some((ref) => ref.serviceId === service.id));
    if (item.kind === "matched" || item.kind === "quantityDiff") {
      // The orders become a source of the drawn services (one drawn service, several sources) — nothing new drawn.
      distributeOrderLines(groupServices, item.orderLines);
      if (item.kind === "quantityDiff" && acceptedIds.has(item.id)) {
        for (const adjusted of adjustGroupQuantity(groupServices, item.orderQuantity)) {
          if (adjusted.quantity === adjusted.service.quantity) continue;
          const placements = effectiveServicePlacements(adjusted.service);
          const keptPlacements = placements.slice(0, requiredPlacementCount({ ...adjusted.service, quantity: adjusted.quantity }));
          updates.set(adjusted.service.id, { ...updates.get(adjusted.service.id), quantity: adjusted.quantity, ...(placements.length > 0 ? { placements: keptPlacements } : {}) });
          changes.push({ kind: adjusted.quantity > adjusted.service.quantity ? "quantityIncreased" : "quantityDecreased", standNumber: item.standNumber, category: item.category, externalLabel: adjusted.service.externalLabel, serviceId: adjusted.service.id, previousQuantity: adjusted.service.quantity, quantity: adjusted.quantity, removedPlacementCount: placements.length - keptPlacements.length });
        }
      }
    } else if (item.kind === "new" && acceptedIds.has(item.id)) {
      const key = normalizeStandNumber(item.standNumber);
      for (const line of item.orderLines) {
        const created: TechnicalService = {
          id: crypto.randomUUID(),
          category: line.category,
          externalLabel: line.externalLabel,
          quantity: line.quantity ?? 0,
          rawValue: line.quantityRaw,
          sourceImportId: importRecord.id,
          sourcePage: line.page,
          rawRow: `${line.orderNumber} · ${line.code} ${line.name} · ${line.quantityRaw} ${line.unit}`.trim(),
          status: "unresolved_product",
          abfCode: line.code,
          sourceOrderNumber: line.orderNumber,
          sourceItemName: line.name,
          ...(line.notes.length > 0 ? { itemNotes: line.notes } : {}),
          sources: [orderSource(importRecord.id, line)],
        };
        additions.set(key, [...(additions.get(key) ?? []), created]);
        changes.push({ kind: "added", standNumber: item.standNumber, category: created.category, externalLabel: created.externalLabel, serviceId: created.id, previousQuantity: 0, quantity: created.quantity, removedPlacementCount: 0 });
      }
    }
  }
  for (const item of reconciliation.noElectricity) if (item.kind === "new" && acceptedIds.has(item.id)) noElectricityStands.add(normalizeStandNumber(item.standNumber));

  // Stands the orders bring that the project does not have yet (only when something accepted lands on them).
  let stands = [...project.stands];
  const companyByStand = new Map(orderImport.importedLines.map((line) => [normalizeStandNumber(line.standNumber!), line.companyName]));
  for (const key of new Set([...additions.keys(), ...noElectricityStands])) {
    if (stands.some((stand) => normalizeStandNumber(stand.standNumber) === key)) continue;
    stands.push({ id: crypto.randomUUID(), standNumber: key, companyName: companyByStand.get(key), services: [], notes: [], placement: UNASSIGNED_PLACEMENT, sourceImportIds: [] });
  }
  stands = stands.map((stand) => {
    const key = normalizeStandNumber(stand.standNumber);
    const added = additions.get(key) ?? [];
    const touched = added.length > 0 || noElectricityStands.has(key) || stand.services.some((service) => updates.has(service.id));
    if (!touched) return stand;
    return {
      ...stand,
      services: [...stand.services.map((service) => (updates.has(service.id) ? { ...service, ...updates.get(service.id) } : service)), ...added],
      sourceImportIds: added.length > 0 || stand.services.some((service) => updates.has(service.id)) ? [...new Set([...stand.sourceImportIds, importRecord.id])] : stand.sourceImportIds,
      ...(noElectricityStands.has(key) ? { hasNoElectricityAssignment: true, noElectricitySource: "abra-orders" as const } : {}),
    };
  });

  const diff: TechnicalImportServiceDiff = {
    unchanged: reconciliation.counts.matched,
    added: changes.filter((change) => change.kind === "added").length,
    removed: 0,
    quantityIncreased: changes.filter((change) => change.kind === "quantityIncreased").length,
    quantityDecreased: changes.filter((change) => change.kind === "quantityDecreased").length,
    changes: sortStandNumbersNatural(changes, (change) => change.standNumber),
  };
  const record: TechnicalRasterImport = {
    ...importRecord,
    serviceDiff: diff,
    orderLines: orderImport.importedLines.map((line) => ({ orderNumber: line.orderNumber, standNumber: line.standNumber, companyName: line.companyName, abfCode: line.code, itemName: line.name, category: line.category, externalLabel: line.externalLabel, quantity: line.quantity ?? 0, notes: line.notes })),
  };
  const imports = [
    ...project.imports.map((existing) => (existing.category === ABRA_ORDER_IMPORT_CATEGORY && !existing.supersededByImportId ? { ...existing, supersededByImportId: importRecord.id } : existing)),
    record,
  ];
  return { project: rematchStands({ ...project, imports, stands, updatedAt: new Date().toISOString() }), diff, reconciliation };
}
