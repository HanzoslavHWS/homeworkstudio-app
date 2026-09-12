"use client";

import { sortStandNumbersNatural } from "../../../domain/technicalStandNumber";
import { computeStandPlacementProgress, computeTechnicalRasterPlacementSummary, groupStandsByPlacementWorkQueue } from "../../../domain/technicalRasterWorkQueue";
import type { TechnicalStand } from "../../../domain/technicalRaster";

/**
 * Placement work queue + pairing buffer (originally "ZÁSOBNÍK" — that label is gone, manual
 * acceptance batch section 9: "Slovo Zásobník může klidně zmizet", now that explicit K UMÍSTĚNÍ/
 * HOTOVO/BEZ BODOVÝCH SLUŽEB/PROBLÉMOVÉ/NESPÁROVANÉ section headers make the old umbrella title
 * redundant). Nespárované (+ Problémové/ambiguous, same manual-assignment action but "matched to
 * >1 raster label" never "matched to 0") stay exactly as before. The old flat "SPÁROVANÉ" list is
 * gone — spárováno stands are now split by PLACEMENT work state (spec batch 8 section 1: "nechci
 * jeden dlouhý seznam všech spárovaných stánků"): K UMÍSTĚNÍ (at least one point service still
 * missing a point), HOTOVO (every point service fully placed — collapsed by default, spec section
 * 3), and BEZ BODOVÝCH SLUŽEB (no point services at all, so it belongs in neither of the first two
 * — spec section 1's optional third group, included so such a stand is never simply invisible
 * here). This split is a pure VIEW derived from domain/technicalRasterWorkQueue.ts every render —
 * never a stored status (spec section 4): removing a placement elsewhere moves a stand back to K
 * UMÍSTĚNÍ purely because this recomputes from the live project.stands on every render.
 *
 * Group ORDER (manual acceptance batch section 5): the right panel's new priority puts placement
 * WORK (K umístění / Hotovo / Bez bodových služeb) ahead of STAND PAIRING (Problémové /
 * Nespárované) — matching/spárování is still the same feature, just no longer the first thing this
 * panel shows once most stands are already paired and the remaining work is placing points.
 *
 * Terminology (spec batch 3, UI section 1/2): "spárováno/nespárováno" always means the STAND is
 * matched to a raster position — a completely different concept from UMÍSTĚNÍ (a technical
 * SERVICE's own physical placement point), which K UMÍSTĚNÍ/HOTOVO now surface here directly (spec
 * batch 8), worded distinctly from "spárováno" throughout.
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
  // CORRECTIVE BATCH (multi-hall imports) section 6/10 — a valid record this raster's own hall
  // simply doesn't own (domain/technicalRasterHallScope.ts) — informational, never mixed into
  // Nespárované/Problémové, never fed into the placement work queue below.
  const outsideCurrentRaster = sortStandNumbersNatural(stands.filter((stand) => stand.placement.status === "outside_current_raster"), (stand) => stand.standNumber);

  const queue = groupStandsByPlacementWorkQueue(assigned);
  const placementSummary = computeTechnicalRasterPlacementSummary(assigned);

  return (
    <div className="workflowCard technicalStandBuffer">
      <div className="technicalStandBufferCounts">
        <span>Nespárované <strong>{unassigned.length}</strong></span>
        <span>Spárované <strong>{assigned.length}</strong></span>
        <span className={ambiguous.length > 0 ? "technicalStandBufferAmbiguousCount" : undefined}>Problémové <strong>{ambiguous.length}</strong></span>
        {outsideCurrentRaster.length > 0 && (
          <span className="technicalStandBufferOutsideRasterCount">Mimo aktuální rastr <strong>{outsideCurrentRaster.length}</strong></span>
        )}
      </div>
      {assigned.length > 0 && (
        <div className="technicalRasterPlacementSummary">
          <span>Technické body <strong>{placementSummary.placedPointCount}/{placementSummary.totalPointCount}</strong> umístěno</span>
          <span>Stánky <strong>{placementSummary.doneStandCount}/{placementSummary.standCountWithPointServices}</strong> hotovo</span>
        </div>
      )}

      {/* Placement WORK queue first (manual acceptance batch section 5/9) — K UMÍSTĚNÍ / HOTOVO /
          BEZ BODOVÝCH SLUŽEB are the panel's new top priority, ahead of stand PAIRING below. */}
      <TechnicalStandGroup
        title="K UMÍSTĚNÍ"
        stands={queue.toPlace}
        numbered={false}
        selectedStandId={selectedStandId}
        activeAssignmentStandId={activeAssignmentStandId}
        onSelectStand={onSelectStand}
        subtitle={(stand) => {
          const progress = computeStandPlacementProgress(stand);
          return `${progress.placedCount} / ${progress.totalCount} bodů`;
        }}
      />
      <TechnicalStandGroup
        title="HOTOVO"
        stands={queue.done}
        numbered={false}
        selectedStandId={selectedStandId}
        activeAssignmentStandId={activeAssignmentStandId}
        onSelectStand={onSelectStand}
        subtitle={() => "✓ Hotovo"}
        subtitleClassName="technicalStandBufferDoneSubtitle"
        collapsedByDefault
      />
      {queue.noPointServices.length > 0 && (
        <TechnicalStandGroup
          title="BEZ BODOVÝCH SLUŽEB"
          stands={queue.noPointServices}
          numbered={false}
          selectedStandId={selectedStandId}
          activeAssignmentStandId={activeAssignmentStandId}
          onSelectStand={onSelectStand}
          collapsedByDefault
        />
      )}

      {/* Stand PAIRING (spárování) below the placement work queue — same feature as before, just no longer first. */}
      {ambiguous.length > 0 && (
        <TechnicalStandGroup title="PROBLÉMOVÉ" stands={ambiguous} numbered={false} showCandidateHint selectedStandId={selectedStandId} activeAssignmentStandId={activeAssignmentStandId} onSelectStand={onSelectStand} />
      )}
      <TechnicalStandGroup title="NESPÁROVANÉ" stands={unassigned} numbered selectedStandId={selectedStandId} activeAssignmentStandId={activeAssignmentStandId} onSelectStand={onSelectStand} />

      {/* CORRECTIVE BATCH (multi-hall imports) section 10/11 — a SEPARATE, collapsed-by-default,
          visually informational group (never styled like PROBLÉMOVÉ's error treatment above) — a
          combined report's 50 foreign-hall rows stay inspectable without dumping 50 warning blocks
          into the primary workflow. Manual pairing is still fully available from here (section 7):
          selecting one of these stands opens the SAME detail panel/"Spárovat kliknutím do rastru"
          action as any other stand — an explicit manual match always overrides this automatic
          classification, exactly like it already overrides ordinary unassigned/ambiguous stands. */}
      {outsideCurrentRaster.length > 0 && (
        <TechnicalStandGroup
          title="MIMO AKTUÁLNÍ RASTR"
          stands={outsideCurrentRaster}
          numbered={false}
          selectedStandId={selectedStandId}
          activeAssignmentStandId={activeAssignmentStandId}
          onSelectStand={onSelectStand}
          collapsedByDefault
          informational
        />
      )}
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
  subtitle,
  subtitleClassName,
  collapsedByDefault,
  informational,
}: {
  title: string;
  stands: readonly TechnicalStand[];
  numbered: boolean;
  /** Ambiguous group only: shows "nalezeno Nx" instead of the company name — spec batch 3 UI section 9, "1A01: Nejednoznačné — nalezeno 2×". */
  showCandidateHint?: boolean;
  selectedStandId: string | undefined;
  activeAssignmentStandId?: string;
  onSelectStand: (standId: string) => void;
  /** A second, compact status line under the stand number/company name (spec batch 8 section 6: e.g. "3 / 4 bodů" or "✓ Hotovo") — omitted for groups that don't need it (NESPÁROVANÉ/PROBLÉMOVÉ keep their existing single-line layout untouched). */
  subtitle?: (stand: TechnicalStand) => string;
  subtitleClassName?: string;
  /** HOTOVO/BEZ BODOVÝCH SLUŽEB render as a native <details>, closed by default (spec batch 8 section 3: "sekce může být defaultně collapsed") — never hides the stand's OWN data, only this group's visibility. */
  collapsedByDefault?: boolean;
  /** CORRECTIVE BATCH (multi-hall imports) section 10 — MIMO AKTUÁLNÍ RASTR only: a visually secondary/informational treatment, deliberately never the PROBLÉMOVÉ/ambiguous error styling. */
  informational?: boolean;
}) {
  if (stands.length === 0) return null;

  const list = (
    <ul>
      {stands.map((stand, index) => (
        <li key={stand.id}>
          <button
            type="button"
            className={[
              "technicalStandBufferItem",
              subtitle ? "stacked" : "",
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
            {subtitle && <span className={subtitleClassName ?? "fieldHint technicalStandBufferSubtitle"}>{subtitle(stand)}</span>}
          </button>
        </li>
      ))}
    </ul>
  );

  const groupClassName = ["technicalStandBufferGroup", informational ? "informational" : ""].filter(Boolean).join(" ");

  if (collapsedByDefault) {
    return (
      <details className={`${groupClassName} collapsible`}>
        <summary><h4>{title} <span className="technicalStandBufferGroupCount">{stands.length}</span></h4></summary>
        {list}
      </details>
    );
  }

  return (
    <div className={groupClassName}>
      <h4>{title} <span className="technicalStandBufferGroupCount">{stands.length}</span></h4>
      {list}
    </div>
  );
}
