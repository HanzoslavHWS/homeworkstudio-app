/**
 * Visualization v3 — scene metadata curation + the AI prompt builder. Pure domain, no THREE/DOM.
 *
 * Privacy (report sections 11/38): `BuildSceneMetadataInput` is a deliberately HAND-ENUMERATED
 * field list, not derived from ProjectRecord via a wide Pick<> — this is stronger than narrowing
 * an existing large type, since there is no risk of a future ProjectRecord field ever leaking in
 * through an accidentally-widened Pick. Pricing, contact (email/phone), and internal notes are
 * simply not fields this type can ever carry. The caller (UI) is responsible for extracting only
 * these specific values from the live project before calling buildSceneMetadataForAi.
 *
 * Prompt engineering is explicitly the SECONDARY protection layer (report section 12) — the real
 * guarantee is domain/visualizationCompositing.ts's pixel-level mask. This module never claims
 * to guarantee geometry by describing it in text.
 */
import type { ProtectedCategory } from "./visualizationSemantics.ts";
import {
  ENVIRONMENT_PRESET_LABELS,
  LIGHTING_PRESET_LABELS,
  PEOPLE_PRESET_LABELS,
  type EnvironmentPreset,
  type LightingPreset,
  type PeoplePreset,
} from "./visualizationAi.ts";

export type CuratedAiSceneMetadata = Readonly<{
  cameraSummary: string;
  footprintMm: Readonly<{ widthMm: number; depthMm: number }>;
  eventName?: string;
  objectCategoryCounts: Readonly<Record<ProtectedCategory, number>>;
  floorType: string;
  materialsSummary: readonly string[];
  protectedObjectCount: number;
  /** Optional, user-authored free text only — never derived from any project field. */
  environmentIntent?: string;
}>;

export type BuildSceneMetadataInput = Readonly<{
  eventName?: string;
  footprintMm: Readonly<{ widthMm: number; depthMm: number }>;
  cameraPosition: readonly [number, number, number];
  cameraTarget: readonly [number, number, number];
  /** Display name of the booth's finish/floor (e.g. carpet variant name), never an internal id. */
  floorType: string;
  materialsSummary: readonly string[];
  objectCategoryCounts: Readonly<Record<ProtectedCategory, number>>;
  environmentIntent?: string;
}>;

export function buildSceneMetadataForAi(input: BuildSceneMetadataInput): CuratedAiSceneMetadata {
  const protectedObjectCount = Object.values(input.objectCategoryCounts).reduce((sum: number, count) => sum + (count as number), 0);
  return {
    cameraSummary: `camera at (${input.cameraPosition.map((n) => n.toFixed(2)).join(", ")}) looking toward (${input.cameraTarget.map((n) => n.toFixed(2)).join(", ")})`,
    footprintMm: input.footprintMm,
    eventName: input.eventName,
    objectCategoryCounts: input.objectCategoryCounts,
    floorType: input.floorType,
    materialsSummary: input.materialsSummary,
    protectedObjectCount,
    environmentIntent: input.environmentIntent,
  };
}

export type StructuredAiPrompt = Readonly<{
  goal: string;
  lockedContent: string;
  editableContent: string;
  style: string;
  camera: string;
}>;

/**
 * Report section 12's structure verbatim (GOAL / LOCKED CONTENT / EDITABLE CONTENT / STYLE /
 * CAMERA). This is a systematic builder, never free-form string concatenation in React.
 *
 * v3.3b: wording strengthened per the first real-render smoke test's feedback (still the SAME 5
 * fields, same builder, no architecture change) — photorealistic professional trade-show hall,
 * exact camera perspective match, natural booth integration, believable ambient light/contact
 * shadows around the footprint, and an explicit no-redesign/duplicate/move/alter instruction.
 */
export function buildEnvironmentPrompt(input: Readonly<{
  metadata: CuratedAiSceneMetadata;
  environmentPreset: EnvironmentPreset;
  peoplePreset: PeoplePreset;
  lightingPreset: LightingPreset;
}>): StructuredAiPrompt {
  const { metadata } = input;
  const footprint = `${metadata.footprintMm.widthMm}×${metadata.footprintMm.depthMm} mm`;

  return {
    goal: "Create a photorealistic environment for a professional trade-show hall around the supplied locked booth.",
    lockedContent: `The supplied booth geometry, furniture, artwork, logos, text, colors and perspective are authoritative and must not be redesigned, resized, repositioned, duplicated, or otherwise altered. Booth footprint: ${footprint}. Protected object count: ${metadata.protectedObjectCount}.`,
    editableContent: `Exhibition hall, surrounding floor beyond the booth footprint, distant booths, people (${PEOPLE_PRESET_LABELS[input.peoplePreset]}), ambient lighting and environmental atmosphere. Integrate the booth naturally into the surrounding hall, with realistic ambient illumination and believable contact shadows around the booth footprint. People must remain in the surrounding environment only, never inside or overlapping the booth.`,
    style: [
      ENVIRONMENT_PRESET_LABELS[input.environmentPreset],
      `${LIGHTING_PRESET_LABELS[input.lightingPreset]} lighting`,
      metadata.floorType ? `hall floor transitioning realistically from the booth's own ${metadata.floorType}` : undefined,
      metadata.environmentIntent,
    ].filter(Boolean).join(". "),
    camera: `Match the exact camera perspective of the input booth. Preserve the supplied framing and perspective exactly — ${metadata.cameraSummary}. Never reframe, crop, or change the field of view.`,
  };
}
