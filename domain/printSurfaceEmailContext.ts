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
 */
import type { PrintSurfaceItem } from "./printSurfaceProject.ts";
import { printSurfaceItemSurfaceName } from "./printSurfaceProject.ts";
import type { PrintSurfacePreset } from "./printSurfacePreset.ts";
import type { PrintSurfaceItemDimensionResolution } from "./printSurfaceProject.ts";
import { formatPrintSurfaceItemDimension } from "./printSurfaceProject.ts";

/**
 * Name of the system EmailTemplate seeded for print-surfaces handoff (see the migration) — used
 * to auto-preselect it in EmailsPage. EmailTemplate (domain/emailTemplate.ts) has no stable
 * internalCode-style key the way catalog items do, only a free-text `name`; a lookup by name is
 * therefore the best available match, with a graceful no-op fallback (template simply isn't
 * preselected — freeText/eventId still prefill fine) if this exact system template was renamed or
 * never migrated into a given environment — never a hard failure.
 */
export const PRINT_SURFACE_EMAIL_TEMPLATE_NAME = "Podklady k tiskovým plochám" as const;

export type PrintSurfaceEmailContext = Readonly<{
  companyName: string;
  eventId?: string;
  eventName?: string;
  realizationCompanyName?: string;
  projectName: string;
  itemCount: number;
  itemSummaries: readonly string[];
  revision: number;
  languageCode: string;
  /** Reference to the already-uploaded PDF (StoredAsset), when export/upload succeeded — see domain/printSurfaceExport.ts's PrintSurfaceExportRecord.fileStorageKey. mailto: links cannot carry an actual attachment (spec section 10) — this is surfaced to the user as "attach this file yourself", never auto-attached. */
  attachmentFileName?: string;
  attachmentAvailable: boolean;
}>;

export function buildPrintSurfaceEmailContext(input: Readonly<{
  companyName: string;
  eventId?: string;
  eventName?: string;
  realizationCompanyName?: string;
  projectName: string;
  items: readonly PrintSurfaceItem[];
  presets: readonly PrintSurfacePreset[];
  resolveDimension: (item: PrintSurfaceItem) => PrintSurfaceItemDimensionResolution;
  revision: number;
  languageCode?: string;
  attachmentFileName?: string;
}>): PrintSurfaceEmailContext {
  const itemSummaries = input.items.map((item) => {
    const dimension = formatPrintSurfaceItemDimension(input.resolveDimension(item));
    return `${item.label} — ${printSurfaceItemSurfaceName(item, input.presets)} — ${dimension}`;
  });
  return {
    companyName: input.companyName,
    eventId: input.eventId,
    eventName: input.eventName,
    realizationCompanyName: input.realizationCompanyName,
    projectName: input.projectName,
    itemCount: input.items.length,
    itemSummaries,
    revision: input.revision,
    languageCode: input.languageCode ?? "cs",
    attachmentFileName: input.attachmentFileName,
    attachmentAvailable: Boolean(input.attachmentFileName),
  };
}

/**
 * The raw seed text for EmailsPage's "Co chcete napsat?" free-text field — plain facts, not
 * prose; the AI generator (steered by the print-surfaces system template's aiInstruction) turns
 * this into the actual polished email. Deliberately includes the attachment caveat so the AI
 * (and the user reviewing its output) never implies the PDF was actually sent/attached when it
 * wasn't (spec section 10).
 */
export function buildPrintSurfaceEmailFreeText(context: PrintSurfaceEmailContext): string {
  const lines = [
    `Zasíláme podklady k tiskovým plochám pro stánek "${context.projectName}"${context.companyName ? ` (${context.companyName})` : ""}${context.eventName ? ` na akci ${context.eventName}` : ""}.`,
    `Přehled obsahuje ${context.itemCount} tiskových ploch s výrobními rozměry (revize R${context.revision}).`,
  ];
  if (context.itemSummaries.length > 0) {
    lines.push("Tiskové plochy:", ...context.itemSummaries.map((summary) => `- ${summary}`));
  }
  lines.push(
    context.attachmentAvailable
      ? `V příloze prosím ručně přiložte vygenerovaný soubor: ${context.attachmentFileName}.`
      : "PDF přehled prosím vygenerujte a přiložte ručně před odesláním.",
  );
  return lines.join("\n");
}
