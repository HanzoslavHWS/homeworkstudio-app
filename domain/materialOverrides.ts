import type { FinishVariant, PartDefinition } from "./models.ts";

export type MaterialOverrideInstruction = Readonly<{
  nodeName: string;
  swatchColor: string;
  materialRole: FinishVariant["materialRole"];
}>;

export function constructionMaterialOverrides(
  parts: readonly PartDefinition[],
  finish: FinishVariant | undefined,
): readonly MaterialOverrideInstruction[] {
  if (!finish?.swatchColor) return [];
  return parts
    .filter(
      (part) =>
        (part.role === "frame" || part.role === "post") &&
        (part.materialRole === "OCTANORM_WHITE" ||
          part.materialRole === "OCTANORM_BLACK"),
    )
    .map((part) => ({
      nodeName: part.nodeName,
      swatchColor: finish.swatchColor!,
      materialRole: finish.materialRole,
    }));
}
