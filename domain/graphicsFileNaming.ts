/**
 * Graphics Export v1 — surface-based human-readable naming for uploaded artwork. Reuses
 * StoredAsset's EXISTING originalFileName/displayName pair (domain/assets.ts) rather than
 * inventing new naming metadata: the real uploaded filename ("01.png") always stays in
 * originalFileName; this module only computes what goes into displayName. Generic over any
 * PrintSurface (group/name/sceneBinding.face) — never keyed off a specific business id string
 * (e.g. never `if (surface.id === "fascia-print")`), so a future printable component (a counter
 * front, ...) is named correctly with zero new code here.
 */
import type { PrintSurface, PrintSurfaceFace } from "./models.ts";

export const FACE_LABEL_CS: Readonly<Record<PrintSurfaceFace, string>> = {
  front: "Přední",
  back: "Zadní",
};

/**
 * Filesystem-safe: strips Czech (and other Latin) diacritics to plain ASCII via Unicode NFD
 * decomposition + combining-mark removal ("ě"/"í" -> "e"/"i", never dropped outright), removes
 * the characters invalid on Windows/most filesystems (`/ \ : * ? " < > |`), collapses whitespace
 * and dashes into single underscores. Never adds a random UUID — see
 * domain/graphicsExport.ts's collision handling for the deterministic-suffix case instead.
 */
export function sanitizeFileNameSegment(text: string): string {
  const withoutDiacritics = text.normalize("NFD").replace(/[̀-ͯ]/gu, "");
  const withoutInvalidChars = withoutDiacritics.replace(/[/\\:*?"<>|]/gu, "");
  const withUnderscores = withoutInvalidChars.trim().replace(/[\s\-‒-―]+/gu, "_");
  return withUnderscores.replace(/_+/gu, "_").replace(/^_+|_+$/gu, "");
}

/** "Panel 1" -> "Panel_1" -> zero-padded "Panel_01" (>=2 digits); a label with no trailing number ("Límec", a future "Čelo") is returned unchanged. */
function zeroPadTrailingNumber(text: string): string {
  return text.replace(/(\d+)$/u, (digits) => digits.padStart(2, "0"));
}

/**
 * Generic, catalog-metadata-driven human label parts for a print surface — group name (the
 * logical component, e.g. "Zadní stěna"/"Límec"), panel name (surface.name with any trailing
 * " FRONT"/" BACK" authoring suffix stripped, e.g. "Panel 1"), and face (from
 * sceneBinding.face, defaulting to "front" the same way the rest of this app already treats a
 * missing face — see domain/printSurfaces.ts). A surface whose panel label already equals its
 * group label (fascia: group "Límec", surface.name "Límec") is not repeated.
 */
export function printSurfaceHumanLabelParts(surface: PrintSurface): Readonly<{ groupLabel: string; panelLabel: string; faceLabel: string }> {
  const groupLabel = surface.group?.name ?? surface.name;
  const panelLabel = surface.name.replace(/\s+(FRONT|BACK)$/iu, "").trim() || groupLabel;
  const faceLabel = FACE_LABEL_CS[surface.sceneBinding?.face ?? "front"];
  return { groupLabel, panelLabel, faceLabel };
}

/** Full human-readable label for on-screen use, e.g. "Zadní stěna – Panel 1 – Přední". */
export function printSurfaceHumanLabel(surface: PrintSurface): string {
  const { groupLabel, panelLabel, faceLabel } = printSurfaceHumanLabelParts(surface);
  return panelLabel === groupLabel ? `${groupLabel} – ${faceLabel}` : `${groupLabel} – ${panelLabel} – ${faceLabel}`;
}

/**
 * Graphics Production Package v1: the SAME collapse-when-equal label rule printSurfaceHumanLabel
 * already applies, but for callers that only have already-built row primitives (groupName/name/
 * face — e.g. GraphicsExportRow-derived readiness rows), never the original PrintSurface object.
 * Never a second copy of the collapse logic — this is the one place it lives.
 */
export function graphicsRowHumanLabel(row: Readonly<{ groupName: string; name: string; face: PrintSurfaceFace }>): string {
  const faceLabel = FACE_LABEL_CS[row.face];
  return row.name === row.groupName ? `${row.groupName} – ${faceLabel}` : `${row.groupName} – ${row.name} – ${faceLabel}`;
}

/**
 * Surface-based filename builder — the reusable helper this session's report calls
 * buildGraphicsFileDisplayName. Produces e.g. "Zadni_stena_Panel_01_Predni.png" for
 * back-wall-01-front, "Limec_Predni.pdf" for fascia-print, purely from generic PrintSurface
 * fields (group/name/face) — never a P86 id lookup table.
 */
export function buildGraphicsFileDisplayName(surface: PrintSurface, extension: string): string {
  const { groupLabel, panelLabel, faceLabel } = printSurfaceHumanLabelParts(surface);
  const sanitizedGroup = sanitizeFileNameSegment(groupLabel);
  const sanitizedPanel = zeroPadTrailingNumber(sanitizeFileNameSegment(panelLabel));
  const sanitizedFace = sanitizeFileNameSegment(faceLabel);
  const segments = sanitizedPanel === sanitizedGroup
    ? [sanitizedGroup, sanitizedFace]
    : [sanitizedGroup, sanitizedPanel, sanitizedFace];
  const base = segments.filter(Boolean).join("_");
  const cleanExtension = extension.replace(/^\.+/u, "").toLowerCase();
  return cleanExtension ? `${base}.${cleanExtension}` : base;
}

/** The real extension of an uploaded/source file (e.g. "01.png" -> "png"), never assumed from the surface. */
export function extensionOf(fileName: string): string {
  const match = /\.([a-z0-9]+)$/iu.exec(fileName);
  return match ? match[1]!.toLowerCase() : "";
}

/**
 * Report section 5: the surface-SPECIFIC export filename for one assignment row — same base
 * naming as buildGraphicsFileDisplayName, but the extension always comes from the REAL source
 * file being exported (so the same graphicsFile used on two surfaces, or a PDF fascia file next
 * to PNG panels, each get a correct, independent name) — never a second copy of the asset.
 */
export function buildSurfaceExportFileName(surface: PrintSurface, sourceFileName: string): string {
  return buildGraphicsFileDisplayName(surface, extensionOf(sourceFileName));
}
