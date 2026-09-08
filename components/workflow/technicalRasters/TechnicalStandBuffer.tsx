"use client";

import { sortStandNumbersNatural } from "../../../domain/technicalStandNumber";
import type { TechnicalStand } from "../../../domain/technicalRaster";

/**
 * ZÁSOBNÍK (spec section 17/18/20): three groups — Nespárované (+ Problémové/ambiguous shown
 * separately, since both need the SAME manual-assignment action but "ambiguous" means "matched
 * to >1 raster label", never "matched to 0") and Spárované — each natural-sorted by stand number
 * (never plain string sort — spec section 17). Unassigned/ambiguous entries get a throwaway
 * "pracovní pořadové číslo" (spec section 18) that is ONLY ever a UI display convenience
 * recomputed from the current sorted position — never persisted, never used as a real identifier
 * (standNumber stays the only real key).
 *
 * Terminology (spec batch 3, UI section 1/2): "spárováno/nespárováno" always means the STAND is
 * matched to a raster position — a completely different concept from a technical SERVICE's own
 * "umístění" (physical placement point), which this component never shows. See
 * TechnicalStandDetailPanel.tsx for where that second concept is surfaced, worded distinctly.
 */
export function TechnicalStandBuffer({
  stands,
  selectedStandId,
  onSelectStand,
  activeAssignmentStandId,
}: {
  stands: readonly TechnicalStand[];
  selectedStandId: string | undefined;
  onSelectStand: (standId: string) => void;
  /** The stand currently in "click into the raster to assign" mode — highlighted distinctly from a merely-selected/viewed stand. */
  activeAssignmentStandId?: string;
}) {
  const unassigned = sortStandNumbersNatural(stands.filter((stand) => stand.placement.status === "unassigned"), (stand) => stand.standNumber);
  const ambiguous = sortStandNumbersNatural(stands.filter((stand) => stand.placement.status === "ambiguous"), (stand) => stand.standNumber);
  const assigned = sortStandNumbersNatural(stands.filter((stand) => stand.placement.status === "matched_auto" || stand.placement.status === "matched_manual"), (stand) => stand.standNumber);

  return (
    <div className="workflowCard technicalStandBuffer">
      <div className="workflowCardHeader"><div><span>ZÁSOBNÍK</span></div></div>
      <div className="technicalStandBufferCounts">
        <span>Nespárované <strong>{unassigned.length}</strong></span>
        <span>Spárované <strong>{assigned.length}</strong></span>
        <span className={ambiguous.length > 0 ? "technicalStandBufferAmbiguousCount" : undefined}>Problémové <strong>{ambiguous.length}</strong></span>
      </div>

      {ambiguous.length > 0 && (
        <TechnicalStandGroup title="PROBLÉMOVÉ" stands={ambiguous} numbered={false} showCandidateHint selectedStandId={selectedStandId} activeAssignmentStandId={activeAssignmentStandId} onSelectStand={onSelectStand} />
      )}
      <TechnicalStandGroup title="NESPÁROVANÉ" stands={unassigned} numbered selectedStandId={selectedStandId} activeAssignmentStandId={activeAssignmentStandId} onSelectStand={onSelectStand} />
      <TechnicalStandGroup title="SPÁROVANÉ" stands={assigned} numbered={false} selectedStandId={selectedStandId} activeAssignmentStandId={activeAssignmentStandId} onSelectStand={onSelectStand} />
    </div>
  );
}

function TechnicalStandGroup({
  title,
  stands,
  numbered,
  showCandidateHint,
  selectedStandId,
  activeAssignmentStandId,
  onSelectStand,
}: {
  title: string;
  stands: readonly TechnicalStand[];
  numbered: boolean;
  /** Ambiguous group only: shows "nalezeno Nx" instead of the company name — spec batch 3 UI section 9, "1A01: Nejednoznačné — nalezeno 2×". */
  showCandidateHint?: boolean;
  selectedStandId: string | undefined;
  activeAssignmentStandId?: string;
  onSelectStand: (standId: string) => void;
}) {
  if (stands.length === 0) return null;
  return (
    <div className="technicalStandBufferGroup">
      <h4>{title}</h4>
      <ul>
        {stands.map((stand, index) => (
          <li key={stand.id}>
            <button
              type="button"
              className={[
                "technicalStandBufferItem",
                stand.id === selectedStandId ? "selected" : "",
                stand.id === activeAssignmentStandId ? "activeAssignment" : "",
              ].filter(Boolean).join(" ")}
              onClick={() => onSelectStand(stand.id)}
            >
              {numbered && <span className="technicalStandBufferOrdinal">{String(index + 1).padStart(3, "0")}</span>}
              <span className="technicalStandBufferNumber">{stand.standNumber}</span>
              {showCandidateHint && stand.placement.candidateCount !== undefined
                ? <span className="fieldHint technicalStandBufferAmbiguousHint">nalezeno {stand.placement.candidateCount}×</span>
                : stand.companyName && <span className="fieldHint">{stand.companyName}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
