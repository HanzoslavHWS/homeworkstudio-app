"use client";

import { technicalServiceCategoryLabel } from "../../../domain/technicalServiceCatalog";
import { effectiveServicePlacements, type TechnicalRasterImport, type TechnicalService, type TechnicalStand } from "../../../domain/technicalRaster";
import { resolveTechnicalServicePresentation } from "../../../domain/technicalRasterServicePresentation";
import { resolveNextPlacementTarget } from "../../../domain/technicalRasterWorkQueue";
import { resolveTechnicalRealizationGroup, technicalRealizationGroupInfo } from "../../../domain/technicalRasterRealization";

/**
 * Detail stánku (spec section 23) — services grouped by category, notes, and the ZDROJE list so
 * every value is traceable back to its source PDF (spec section 32) — never just a number with no
 * provenance.
 *
 * Terminology (spec batch 3/7, UI section 1/3/4/9): the top status badge is SPÁROVÁNÍ — whether
 * this TechnicalStand is matched to a position in the raster PDF. Each service row below shows its
 * OWN, separate UMÍSTĚNÍ status — a technical service's physical placement point(s) within the
 * stand's own floor plan, now backed by the real TechnicalServicePlacement[] data (spec batch 7).
 * "point" services show "Umístěno N/qty"/"Neumístěno" with [Umístit]/[Přemístit]/[Odstranit]
 * actions; "informational" services show a plain hint, never a canvas action; "none" services
 * (e.g. úklid) show nothing extra at all — never reuse "(ne)přiřazeno" for either SPÁROVÁNÍ or
 * UMÍSTĚNÍ.
 */
export function TechnicalStandDetailPanel({
  stand,
  imports,
  onAssign,
  onClearAssignment,
  onPlaceService,
  onMovePlacement,
  onRemovePlacement,
  onPlaceMissingSequentially,
  placementModeActive,
  onSetRealizationCompany,
}: {
  stand: TechnicalStand | undefined;
  imports: readonly TechnicalRasterImport[];
  onAssign?: (standId: string) => void;
  onClearAssignment?: (standId: string) => void;
  /** Starts placement mode for the NEXT empty point of this service (spec section 6) — omitted entirely (no button rendered) when the caller doesn't support it, e.g. a read-only context. */
  onPlaceService?: (standId: string, serviceId: string) => void;
  /** Starts "move" mode for one EXISTING placement (spec section 9: "Přemístit" — same placement id, new coordinates on the next canvas click). */
  onMovePlacement?: (standId: string, serviceId: string, placementId: string) => void;
  /** Removes ONE placement — never the service itself (spec section 9: "Odstranit umístění"). */
  onRemovePlacement?: (standId: string, serviceId: string, placementId: string) => void;
  /** "Umístit chybějící postupně" (spec batch 8 section 8) — starts the SAME auto-advance sequence the editor already runs after every individual placement, just beginning on whichever point service is missing first. */
  onPlaceMissingSequentially?: (standId: string) => void;
  /** True while the user is already placing/moving a DIFFERENT point somewhere — disables every Umístit/Přemístit button here so a second placement can never start mid-flow (the active one's own Zrušit lives in the canvas sidebar banner, not here). */
  placementModeActive?: boolean;
  /**
   * Corrective batch section 9/10 — manual entry point for a stand's raw "R:" realization text,
   * until a real supplemental-catalog PDF parser exists to fill this in automatically (see
   * domain/technicalRasterReconciliation.ts's own doc for why that parser isn't built yet — no real
   * fixture file was available). Passing `undefined` clears it. Omitted entirely hides the field.
   */
  onSetRealizationCompany?: (standId: string, value: string | undefined) => void;
}) {
  if (!stand) {
    return (
      <aside className="workflowCard technicalStandDetailPanel">
        <div className="workflowCardHeader"><div><span>DETAIL</span></div></div>
        <p className="workspaceEmpty">Vyberte stánek v zásobníku nebo v rastru.</p>
      </aside>
    );
  }

  const servicesByCategory = new Map<string, TechnicalService[]>();
  for (const service of stand.services) {
    if (!servicesByCategory.has(service.category)) servicesByCategory.set(service.category, []);
    servicesByCategory.get(service.category)!.push(service);
  }

  const sourceFilenames = [...new Set(stand.sourceImportIds
    .map((importId) => imports.find((entry) => entry.id === importId)?.filename)
    .filter((filename): filename is string => Boolean(filename)))];

  const ambiguousLabel = stand.placement.candidateCount !== undefined
    ? `Nejednoznačné — nalezeno ${stand.placement.candidateCount}×`
    : "Nejednoznačné (více shod v rastru)";
  const placementLabel: Record<string, string> = {
    unassigned: "Nespárováno",
    matched_auto: "✓ Spárováno automaticky",
    matched_manual: "✓ Spárováno ručně",
    ambiguous: ambiguousLabel,
    // CORRECTIVE BATCH (multi-hall imports) — informational, never worded like an error/problem.
    outside_current_raster: "Mimo aktuální rastr",
  };

  return (
    <aside className="workflowCard technicalStandDetailPanel">
      <div className="workflowCardHeader">
        <div>
          <span>STÁNEK</span>
          <strong>{stand.standNumber}</strong>
        </div>
      </div>
      {stand.companyName && <p className="fieldHint">{stand.companyName}</p>}
      <p className={`stageBadge technicalStandPlacementBadge ${stand.placement.status}`}>{placementLabel[stand.placement.status] ?? stand.placement.status}</p>

      {onPlaceMissingSequentially && resolveNextPlacementTarget(stand) && (
        <button type="button" className="textButton" disabled={placementModeActive} onClick={() => onPlaceMissingSequentially(stand.id)}>
          Umístit chybějící postupně
        </button>
      )}

      {[...servicesByCategory.entries()].map(([category, services]) => (
        <div key={category} className="technicalStandDetailSection">
          <h4>{technicalServiceCategoryLabel(category).toLocaleUpperCase("cs")}</h4>
          {services.map((service) => {
            const presentation = resolveTechnicalServicePresentation(service.category, service.externalLabel);
            const placements = effectiveServicePlacements(service);
            const canPlaceMore = presentation.placementBehavior === "point" && placements.length < service.quantity;
            return (
              <div key={service.id} className="technicalStandServiceRow">
                <div className="technicalStandServiceRowMain">
                  <span>{service.externalLabel}</span>
                  <strong>{service.quantity}×</strong>
                </div>

                {presentation.placementBehavior === "informational" && (
                  <p className="fieldHint technicalStandServiceInformationalHint">Bez umístění</p>
                )}

                {presentation.placementBehavior === "point" && (
                  <>
                    <p className={placements.length > 0 ? "fieldHint technicalStandServicePlacementStatus placed" : "fieldHint technicalStandServicePlacementStatus unplaced"}>
                      {placements.length === 0 ? "Neumístěno" : `Umístěno ${placements.length}/${service.quantity}`}
                    </p>
                    {placements.map((placement, index) => (
                      <div key={placement.id} className="technicalStandServicePointRow">
                        <span>Bod {index + 1}</span>
                        <div className="technicalStandServicePlacementActions">
                          {onMovePlacement && (
                            <button type="button" className="textButton" disabled={placementModeActive} onClick={() => onMovePlacement(stand.id, service.id, placement.id)}>Přemístit</button>
                          )}
                          {onRemovePlacement && (
                            <button type="button" className="textButton" disabled={placementModeActive} onClick={() => onRemovePlacement(stand.id, service.id, placement.id)}>Odstranit umístění</button>
                          )}
                        </div>
                      </div>
                    ))}
                    {canPlaceMore && onPlaceService && (
                      <div className="technicalStandServicePlacementActions">
                        <button type="button" className="textButton" disabled={placementModeActive} onClick={() => onPlaceService(stand.id, service.id)}>
                          {placements.length > 0 ? "Umístit další bod" : "Umístit"}
                        </button>
                      </div>
                    )}
                  </>
                )}

                {service.status === "unresolved_product" && <p className="fieldHint technicalStandUnresolvedBadge">Neznámý produkt</p>}
              </div>
            );
          })}
        </div>
      ))}

      {stand.notes.length > 0 && (
        <div className="technicalStandDetailSection">
          <h4>POZNÁMKA</h4>
          {stand.notes.map((note) => <p key={note.id} className="fieldHint">{note.text}</p>)}
        </div>
      )}

      {onSetRealizationCompany && (
        <div className="technicalStandDetailSection">
          <h4>REALIZACE</h4>
          <input
            type="text"
            className="technicalStandRealizationInput"
            placeholder="Realizační firma (R:)"
            defaultValue={stand.realizationCompany ?? ""}
            key={stand.id}
            onBlur={(event) => {
              const value = event.target.value.trim();
              onSetRealizationCompany(stand.id, value ? value : undefined);
            }}
          />
          <p className="fieldHint">
            Skupina: <strong style={{ color: technicalRealizationGroupInfo(resolveTechnicalRealizationGroup(stand.realizationCompany)).color }}>
              {technicalRealizationGroupInfo(resolveTechnicalRealizationGroup(stand.realizationCompany)).label}
            </strong>
          </p>
        </div>
      )}

      {sourceFilenames.length > 0 && (
        <div className="technicalStandDetailSection">
          <h4>ZDROJE</h4>
          {sourceFilenames.map((filename) => <p key={filename} className="fieldHint">{filename}</p>)}
        </div>
      )}

      <div className="technicalStandDetailActions">
        {onAssign && stand.placement.status !== "matched_manual" && (
          <button type="button" className="textButton" onClick={() => onAssign(stand.id)}>Spárovat kliknutím do rastru</button>
        )}
        {onClearAssignment && stand.placement.status !== "unassigned" && stand.placement.status !== "outside_current_raster" && (
          <button type="button" className="textButton" onClick={() => onClearAssignment(stand.id)}>Zrušit spárování</button>
        )}
      </div>
    </aside>
  );
}
