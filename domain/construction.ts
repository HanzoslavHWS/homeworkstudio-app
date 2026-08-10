import type {
  BoothType,
  ConstructionPart,
  PlanViewType,
} from "./models.ts";

export type ConstructionVisibility = Readonly<Record<string, boolean>>;

export type ConstructionPlanGroups = Readonly<{
  ground: readonly ConstructionPart[];
  overhead: readonly ConstructionPart[];
}>;

export function groupConstructionParts(
  parts: readonly ConstructionPart[],
): ConstructionPlanGroups {
  return {
    ground: parts.filter((part) => part.planViewType === "ground"),
    overhead: parts.filter((part) => part.planViewType === "overhead"),
  };
}

export function isConstructionPartVisible(
  part: ConstructionPart,
  visibility: ConstructionVisibility,
  assemblyVisible = true,
): boolean {
  return assemblyVisible && (visibility[part.id] ?? part.visible);
}

export function getVisiblePlanConstructionParts(
  booth: BoothType,
  planViewType: PlanViewType,
  visibility: ConstructionVisibility,
  assemblyVisible = true,
): readonly ConstructionPart[] {
  if (!assemblyVisible) {
    return [];
  }

  return booth.constructionParts.filter(
    (part) =>
      part.planViewType === planViewType &&
      isConstructionPartVisible(part, visibility, assemblyVisible),
  );
}
