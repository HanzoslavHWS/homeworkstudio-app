/**
 * Technické rastry — placement keyboard shortcuts (production-workflow batch, part B):
 *   U      -> start the next relevant placement (TechnicalRasterEditorPage's handleStartNextPlacement)
 *   Escape -> cancel the active placement/move (the SAME handleCancelPlacement the
 *             "Zrušit umisťování" button calls — one cancellation path)
 *
 * Pure decision function so the editor's single window keydown listener stays trivial and this can
 * be unit-tested without a DOM. Never fires while the user is typing (input/textarea/select/
 * contenteditable, including fields inside dialogs), never with Ctrl/Meta/Alt (browser/system
 * shortcuts stay untouched), never on auto-repeat or IME composition, never on an event another
 * handler already consumed.
 */

export type PlacementShortcutAction = "startNextPlacement" | "cancelPlacement";

/** Structural subset of KeyboardEvent — lets tests pass plain objects. */
export type ShortcutKeyEvent = Readonly<{
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
  defaultPrevented?: boolean;
  target?: unknown;
}>;

type ElementLike = Readonly<{
  tagName?: unknown;
  isContentEditable?: unknown;
  closest?: unknown;
}>;

const EDITABLE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);

/** True when a keystroke aimed at `target` belongs to text entry / a form control, not to the canvas workflow. */
export function isEditableShortcutTarget(target: unknown): boolean {
  if (!target || typeof target !== "object") return false;
  const element = target as ElementLike;
  if (typeof element.tagName === "string" && EDITABLE_TAGS.has(element.tagName.toUpperCase())) return true;
  if (element.isContentEditable === true) return true;
  if (typeof element.closest === "function") {
    const editableAncestor = (element.closest as (selector: string) => unknown)("[contenteditable]:not([contenteditable='false'])");
    if (editableAncestor) return true;
  }
  return false;
}

export function resolvePlacementShortcut(
  event: ShortcutKeyEvent,
  context: Readonly<{ placementActive: boolean; shortcutsEnabled: boolean }>,
): PlacementShortcutAction | undefined {
  if (!context.shortcutsEnabled) return undefined;
  if (event.defaultPrevented || event.isComposing) return undefined;
  if (event.ctrlKey || event.metaKey || event.altKey) return undefined;
  if (isEditableShortcutTarget(event.target)) return undefined;
  if (event.key === "Escape") return context.placementActive ? "cancelPlacement" : undefined;
  if (event.key === "u" || event.key === "U") {
    if (event.repeat || context.placementActive) return undefined;
    return "startNextPlacement";
  }
  return undefined;
}
