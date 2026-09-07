/**
 * Print Surfaces V5 (spec sections 9/11) — the handoff context passed from the print-surfaces
 * editor into the EXISTING "E-maily" module (EmailsPage.tsx), never a second composer. Mirrors
 * domain/emailEventContext.ts's own discipline: a small, hand-enumerated type, never `Pick<...>`
 * of the full project/event shapes, so this can never accidentally carry pricing/internal-notes
 * fields the email flow has no business seeing.
 *
 * `freeText` built here becomes EmailsPage's raw compose input (the same field a human would type
 * by hand) — it is NOT the final email body. The actual wording/tone is still produced by the
 * existing AI generate endpoint (/api/emails/ai-generate), steered by the print-surfaces system
 * EmailTemplate's `aiInstruction` (seeded in supabase/migrations — see that file's comment for the
 * exact CZ intent from the spec). This module never writes literal email prose into a component,
 * per spec section 11's explicit instruction.
 *
 * PDF FINAL DESIGN + AI EMAIL WORKFLOW (this phase, spec sections 13/24): `surfaces` is built by
 * the caller directly from the SAME PrintSurfaceExportViewModel.rows used to render the PDF (see
 * PrintSurfaceExportPanel.tsx's handleEmailHandoff) — never re-derived independently from
 * project.items — so the email can never state a dimension/label that disagrees with the attached
 * PDF (spec section 24: "PDF říká A = 950 × 2340, email context říká jiné číslo" must never
 * happen). `projectId` doubles as the "return to project" reference (spec section 22's
 * sourceProjectId) — no separate field, since it's the exact same id.
 *
 * Real-usage follow-up: `surfaces` is kept as STRUCTURED data for AI grounding
 * (buildPrintSurfaceEmailAdditionalContext feeds it to the AI generator's separate
 * `additionalContext` channel — domain/emailAiPrompt.ts — never mixed into the visible compose
 * text) but `buildPrintSurfaceEmailFreeText` below deliberately no longer lists surfaces or
 * mentions manual attachment — the list already lives in the PDF, and "please attach the file
 * yourself" is a UI-only fact (EmailsPage's attachment card), never part of the email body itself.
 */
import type { PrintSurfaceExportRow } from "./printSurfaceExport.ts";

/**
 * Name of the system EmailTemplate seeded for print-surfaces handoff (see the migration) — used
 * to auto-preselect it in EmailsPage. EmailTemplate (domain/emailTemplate.ts) has no stable
 * internalCode-style key the way catalog items do, only a free-text `name`; a lookup by name is
 * therefore the best available match, with a graceful no-op fallback (template simply isn't
 * preselected — freeText/eventId still prefill fine) if this exact system template was renamed or
 * never migrated into a given environment — never a hard failure.
 */
export const PRINT_SURFACE_EMAIL_TEMPLATE_NAME = "Podklady k tiskovým plochám" as const;

/** One physical print surface's facts, as they appear in the attached PDF's table row (spec section 13) — never a placement (a surface pinned on 2 views is still exactly one entry here, same dedup as the PDF table). */
export type PrintSurfaceEmailSurface = Readonly<{
  label: string;
  type: string;
  displayName: string;
  productionDimension: string;
  quantity: number;
  note: string;
}>;

export type PrintSurfaceEmailContext = Readonly<{
  projectId: string;
  projectName: string;
  companyName: string;
  eventId?: string;
  eventName?: string;
  realizationCompanyName?: string;
  revision: number;
  /** The export history record this handoff was built from (domain/printSurfaceExport.ts's PrintSurfaceExportRecord.id) — lets a later "Potvrdit jako odesláno" or audit trail tie back to exactly this PDF. */
  exportId?: string;
  /** StoredAsset reference for the already-uploaded PDF (fileStorageKey) — used by EmailsPage's attachment card to offer a real download, never auto-attached (mailto: cannot carry attachments — spec section 18/19). */
  pdfAssetStorageKey?: string;
  pdfFileName?: string;
  numberOfSurfaces: number;
  surfaces: readonly PrintSurfaceEmailSurface[];
  languageCode: string;
  attachmentAvailable: boolean;
}>;

export function buildPrintSurfaceEmailContext(input: Readonly<{
  projectId: string;
  companyName: string;
  eventId?: string;
  eventName?: string;
  realizationCompanyName?: string;
  projectName: string;
  rows: readonly PrintSurfaceExportRow[];
  revision: number;
  exportId?: string;
  pdfAssetStorageKey?: string;
  pdfFileName?: string;
  languageCode?: string;
}>): PrintSurfaceEmailContext {
  const surfaces: readonly PrintSurfaceEmailSurface[] = input.rows.map((row) => ({
    label: row.label,
    type: row.typeLabel,
    displayName: row.surfaceName,
    productionDimension: row.dimensionLabel,
    quantity: row.quantity,
    note: row.note,
  }));
  return {
    projectId: input.projectId,
    companyName: input.companyName,
    eventId: input.eventId,
    eventName: input.eventName,
    realizationCompanyName: input.realizationCompanyName,
    projectName: input.projectName,
    numberOfSurfaces: surfaces.length,
    surfaces,
    revision: input.revision,
    exportId: input.exportId,
    pdfAssetStorageKey: input.pdfAssetStorageKey,
    pdfFileName: input.pdfFileName,
    languageCode: input.languageCode ?? "cs",
    attachmentAvailable: Boolean(input.pdfFileName),
  };
}

/**
 * The raw seed text for EmailsPage's "Co chcete napsat?" free-text field — plain facts, not
 * prose; the AI generator (steered by the print-surfaces system template's aiInstruction) turns
 * this into the actual polished email. Deliberately SHORT: no per-surface list (already in the
 * PDF — see module doc), no "please attach the file yourself" instruction (that belongs only in
 * EmailsPage's UI, never in the email body itself — spec: manual-attach is a UI hint, not text a
 * recipient should ever read).
 */
export function buildPrintSurfaceEmailFreeText(context: PrintSurfaceEmailContext): string {
  return [
    `Zasíláme podklady k tiskovým plochám pro stánek "${context.projectName}"${context.companyName ? ` (${context.companyName})` : ""}${context.eventName ? ` na akci ${context.eventName}` : ""}.`,
    "V příloze naleznete přehled jednotlivých tiskových ploch včetně výrobních rozměrů.",
  ].join("\n");
}

/**
 * Structured per-surface facts for the AI generator's `additionalContext` grounding channel
 * (domain/emailAiPrompt.ts) — available to the model for accuracy, but explicitly instructed
 * there not to be listed out unless the user's own text asks for it. Never mixed into
 * buildPrintSurfaceEmailFreeText's visible seed above.
 */
export function buildPrintSurfaceEmailAdditionalContext(context: PrintSurfaceEmailContext): readonly string[] {
  return context.surfaces.map((surface) => {
    const quantitySuffix = surface.quantity > 1 ? `, ${surface.quantity} ks` : "";
    const noteSuffix = surface.note ? `, poznámka: ${surface.note}` : "";
    return `${surface.label} — ${surface.displayName} (${surface.type}) — ${surface.productionDimension}${quantitySuffix}${noteSuffix}`;
  });
}
