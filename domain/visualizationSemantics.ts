/**
 * Visualization v3 — the semantic category contract for the object/segmentation-ID control pass.
 * Pure types/constants only, no THREE/DOM. The actual per-object category RESOLUTION happens in
 * components/configurator/BoothCadViewer.tsx (needs a live Object3D/userData), but the contract
 * — which categories exist, and which existing identifier each one maps to — lives here so it's
 * documented and testable independent of WebGL.
 *
 * Deliberately generic: nothing here or in the resolution logic it documents may ever branch on
 * a specific booth/product id (no "if P86", no "if koje-2x2") — every category is resolved from
 * identifiers that already exist for ANY booth (GLB assembly node names, PlacedComponent ids,
 * the print-artwork overlay marker, the carpet mesh), so a future booth type works automatically.
 *
 * `editable-environment` is deliberately NOT a member of this enum — there is no environment
 * geometry in the scene today (confirmed: BoothCadViewer's `content` group only ever holds the
 * carpet, the booth GLTF, and furniture — nothing else). "Editable" is defined as the complement
 * of the protected mask at compositing time (domain/visualizationCompositing.ts), never
 * enumerated as scene geometry — enumerating it would mean inventing fictitious categories with
 * no scene-graph backing.
 */

/**
 * `panels` (mentioned in the original spec as its own category) intentionally collapses into
 * `booth-construction` — BoothAssemblyDefinition (domain/models.ts) carries only `id` /
 * `constructionPartId` / `defaultVisible`, no field distinguishing a "panel" assembly from any
 * other construction assembly. Since both are equally protected, splitting them would only ever
 * change reporting granularity, never the protection guarantee — not worth inventing a
 * distinction the data doesn't support.
 */
export type ProtectedCategory = "booth-construction" | "artwork" | "furniture" | "booth-floor";

export const PROTECTED_CATEGORIES: readonly ProtectedCategory[] = [
  "booth-construction",
  "artwork",
  "furniture",
  "booth-floor",
];

/**
 * Flat RGB colors for the object/semantic-ID control pass — each protected category gets a
 * distinct, high-contrast, unambiguous color; anything NOT in {@link PROTECTED_CATEGORIES}
 * (i.e. editable-environment) renders as pure black (0,0,0), never one of these colors. Values
 * chosen to be maximally separated in a flat 0-255 RGB cube so a naive nearest-color classifier
 * (used by tests and any future debug tooling) never confuses two categories.
 */
export const SEMANTIC_CATEGORY_COLORS: Readonly<Record<ProtectedCategory, Readonly<{ r: number; g: number; b: number }>>> = {
  "booth-construction": { r: 255, g: 0, b: 0 },
  artwork: { r: 0, g: 255, b: 0 },
  furniture: { r: 0, g: 0, b: 255 },
  "booth-floor": { r: 255, g: 255, b: 0 },
};

export const EDITABLE_ENVIRONMENT_COLOR = { r: 0, g: 0, b: 0 } as const;

/**
 * The `userData` key BoothCadViewer.tsx writes for the two categories that had no existing
 * identifier suitable for classification (furniture instances and the carpet/floor mesh — see
 * the contract table below). `booth-construction` and `artwork` need NO new tagging: they're
 * already resolvable from identifiers that exist for other reasons (see SEMANTIC_TAGGING_CONTRACT).
 */
export const SEMANTIC_CATEGORY_USERDATA_KEY = "hwsSemanticCategory";

/**
 * Documents exactly which pre-existing (or, for furniture/booth-floor, newly one-line-tagged)
 * identifier each category resolves from. This is the single source of truth
 * BoothCadViewer.tsx's actual traversal/classification code must follow — kept here as data
 * (not executable, since resolution needs a live THREE.Object3D) so the contract itself is
 * reviewable and testable independent of any WebGL context.
 */
export type SemanticTaggingRule = Readonly<{
  category: ProtectedCategory;
  identifier: string;
  source: string;
  isNewTagging: boolean;
}>;

export const SEMANTIC_TAGGING_CONTRACT: readonly SemanticTaggingRule[] = [
  {
    category: "booth-construction",
    identifier: "GLB node name === BoothAssemblyDefinition.id",
    source: "domain/cad3d.ts applyBoothAssemblyVisibility (root.getObjectByName(assembly.id)) — already name-addressable for constructionVisibility",
    isNewTagging: false,
  },
  {
    category: "artwork",
    identifier: `mesh.userData[PRINT_ARTWORK_OVERLAY_MARKER]`,
    source: "lib/printArtworkOverlays.ts findPrintArtworkOverlays(scene) — reused verbatim, never reimplemented",
    isNewTagging: false,
  },
  {
    category: "furniture",
    identifier: `instance.userData[${JSON.stringify(SEMANTIC_CATEGORY_USERDATA_KEY)}] === "furniture"`,
    source: "one new line next to the existing instance.name = component.id (BoothCadViewer.tsx) — instance.name is an identity, not a category, so a small explicit tag avoids cross-referencing project.sceneObjects during a render pass",
    isNewTagging: true,
  },
  {
    category: "booth-floor",
    identifier: `carpet.userData[${JSON.stringify(SEMANTIC_CATEGORY_USERDATA_KEY)}] === "booth-floor"`,
    source: "one new line next to content.add(carpet) (BoothCadViewer.tsx) — replaces fragile 'Carpet <finishName>' / 'Floor (no finish)' name-string matching with an exact, non-parsing check",
    isNewTagging: true,
  },
];

export function isProtectedCategory(value: string): value is ProtectedCategory {
  return (PROTECTED_CATEGORIES as readonly string[]).includes(value);
}
