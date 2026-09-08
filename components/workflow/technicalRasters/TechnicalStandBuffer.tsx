"use client";

import { sortStandNumbersNatural } from "../../../domain/technicalStandNumber";
import type { TechnicalStand } from "../../../domain/technicalRaster";

/**
 * ZÁSOBNÍK (spec section 17/18/20): three groups — Nepřiřazené (+ Problematické/ambiguous shown
 * together as "needs attention", since both need the SAME manual-assignment action) and
 * Přiřazené — each natural-sorted by stand number (never plain string sort — spec section 17).
 * Unassigned/ambiguous entries get a throwaway "pracovní pořadové číslo" (spec section 18) that
 * is ONLY ever a UI display convenience recomputed from the current sorted position — never
 * persisted, never used as a real identifier (standNumber stays the only real key).
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
        <span>Nepřiřazené <strong>{unassigned.length}</strong></span>
        <span>Přiřazené <strong>{assigned.length}</strong></span>
        <span className={ambiguous.length > 0 ? "technicalStandBufferAmbiguousCount" : undefined}>Problematické <strong>{ambiguous.length}</strong></span>
      </div>

      {ambiguous.length > 0 && (
        <TechnicalStandGroup title="PROBLÉMOVÉ / AMBIGUOUS" stands={ambiguous} numbered={false} selectedStandId={selectedStandId} activeAssignmentStandId={activeAssignmentStandId} onSelectStand={onSelectStand} />
      )}
      <TechnicalStandGroup title="NEPŘIŘAZENÉ" stands={unassigned} numbered selectedStandId={selectedStandId} activeAssignmentStandId={activeAssignmentStandId} onSelectStand={onSelectStand} />
      <TechnicalStandGroup title="PŘIŘAZENÉ" stands={assigned} numbered={false} selectedStandId={selectedStandId} activeAssignmentStandId={activeAssignmentStandId} onSelectStand={onSelectStand} />
    </div>
  );
}

function TechnicalStandGroup({
  title,
  stands,
  numbered,
  selectedStandId,
  activeAssignmentStandId,
  onSelectStand,
}: {
  title: string;
  stands: readonly TechnicalStand[];
  numbered: boolean;
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
              {stand.companyName && <span className="fieldHint">{stand.companyName}</span>}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
