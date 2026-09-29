/**
 * Úkoly — architecture for AUTOMATIC tasks. A rule looks at existing generator data and proposes
 * candidates; planAutomaticTasks drops every candidate whose automation key already exists, and
 * taskService.createAutomaticTasks persists the rest with is_automatic = true.
 *
 * Adding a rule = one pure function returning AutomaticTaskCandidate[] with a STABLE automation key
 * (rule id + the record it is about), so re-running never duplicates a task.
 *
 * Not scheduled anywhere yet — nothing runs rules automatically in this first version. The one
 * rule below (technical raster: ordered but unplaced services) is implemented and tested as the
 * reference example. Planned next rules (from the spec): print surfaces without uploaded graphics
 * -> "Vyžádat grafické podklady"; graphics ready but PDF not marked sent -> "Odeslat tisková data";
 * approaching graphics deadline -> "Zkontrolovat chybějící grafické podklady".
 */
import { effectiveServicePlacements, requiredPlacementCount, type TechnicalRasterProject } from "./technicalRaster.ts";
import { resolveTechnicalServicePresentation } from "./technicalRasterServicePresentation.ts";
import type { TaskInput } from "./tasks.ts";

export type AutomaticTaskCandidate = Readonly<{
  ruleId: string;
  /** Stable, unique per rule + record — stored in tasks.automation_key. */
  automationKey: string;
  input: TaskInput;
}>;

export type AutomaticTaskRule<Context> = Readonly<{
  id: string;
  label: string;
  evaluate: (context: Context) => readonly AutomaticTaskCandidate[];
}>;

/** Candidates that don't exist yet, first occurrence of each key only. */
export function planAutomaticTasks(candidates: readonly AutomaticTaskCandidate[], existingKeys: ReadonlySet<string>): readonly AutomaticTaskCandidate[] {
  const seen = new Set(existingKeys);
  const result: AutomaticTaskCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.automationKey)) continue;
    seen.add(candidate.automationKey);
    result.push(candidate);
  }
  return result;
}

const PLACE_TITLES: Readonly<Record<string, { title: string; categoryId: string }>> = {
  electricity: { title: "Umístit elektrickou přípojku", categoryId: "electricity" },
  internet: { title: "Umístit internet", categoryId: "internet" },
  water: { title: "Umístit vodu", categoryId: "water_waste" },
  waste: { title: "Umístit odpad", categoryId: "water_waste" },
};

/**
 * Reference rule: a MATCHED stand in a technical raster has an ordered point service that still
 * needs placements (same requiredPlacementCount rule the raster editor uses) -> one task per stand
 * + category, e.g. "Umístit internet · 3B24".
 */
export const technicalRasterUnplacedServicesRule: AutomaticTaskRule<TechnicalRasterProject> = {
  id: "technical-raster-unplaced-services",
  label: "Objednaná technika není umístěná v technickém rastru",
  evaluate(project) {
    const candidates: AutomaticTaskCandidate[] = [];
    for (const stand of project.stands) {
      if (stand.placement.status !== "matched_auto" && stand.placement.status !== "matched_manual") continue;
      const missingCategories = new Set<string>();
      for (const service of stand.services) {
        if (resolveTechnicalServicePresentation(service.category, service.externalLabel).placementBehavior !== "point") continue;
        if (effectiveServicePlacements(service).length < requiredPlacementCount(service)) missingCategories.add(service.category);
      }
      for (const category of missingCategories) {
        const known = PLACE_TITLES[category];
        candidates.push({
          ruleId: this.id,
          automationKey: `${this.id}:${project.id}:${stand.standNumber}:${category}`,
          input: {
            title: known?.title ?? `Umístit technickou službu (${category})`,
            categoryId: known?.categoryId ?? "technical",
            priority: "normal",
            eventId: project.eventId,
            companyName: stand.companyName,
            standNumber: stand.standNumber,
            sourceType: "technical_raster_project",
            sourceId: project.id,
          },
        });
      }
    }
    return candidates;
  },
};
