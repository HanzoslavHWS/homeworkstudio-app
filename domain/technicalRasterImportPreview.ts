/**
 * Technické rastry — read-only presentation views over parsed/imported technical-service data
 * (spec batch 3, UI section 10-15). Deliberately NOT part of the parser or the merge pipeline
 * (domain/technicalRaster.ts's mergeTechnicalRasterImport) — every function here only PROJECTS
 * data that already exists, grouped/sorted for display, never computing a new match, resolving a
 * new product, or mutating anything. Two independent sources feed the SAME output shape
 * (TechnicalImportPreviewStandGroup), so one presentational component
 * (components/workflow/technicalRasters/TechnicalImportParsedDataList.tsx) can render both:
 *  - groupParsedReportByStand: a PDF just parsed, not yet imported (TechnicalServiceImportPanel's
 *    preview, before "Potvrdit import").
 *  - groupImportedStandsByImport: an already-merged historical import, read back out of the
 *    project's own stands[] by provenance (sourceImportId) — the raw ParsedTechnicalReport isn't
 *    persisted, only its effect on stands[] is.
 */
import { sortStandNumbersNatural } from "./technicalStandNumber.ts";
import type { ParsedTechnicalReport, TechnicalServiceStatus, TechnicalStand } from "./technicalRaster.ts";

export type TechnicalImportPreviewServiceRow = Readonly<{
  externalLabel: string;
  quantity: number;
  /** True when this exact service (category + externalLabel) could not be resolved to an internal catalog product — spec batch 3 UI section 3/12: a THIRD, separate concept from stand↔raster spárování and service umístění, never worded as "(ne)přiřazeno". */
  isUnknownProduct: boolean;
}>;

export type TechnicalImportPreviewStandGroup = Readonly<{
  standNumber: string;
  companyName?: string;
  services: readonly TechnicalImportPreviewServiceRow[];
  notes: readonly string[];
}>;

export type TechnicalImportPreviewSummary = Readonly<{
  standCount: number;
  serviceCount: number;
  warningCount: number;
  unknownProductCount: number;
}>;

/** Groups one just-parsed report's rows by stand number, natural-sorted (spec section 17 discipline reused here too — never plain string sort). `standNumber` is intentionally the RAW, not-yet-normalized value the parser produced, same as the existing pre-import "Nalezeno stánků" count this preview sits alongside — grouping never changes what gets counted. */
export function groupParsedReportByStand(
  report: ParsedTechnicalReport,
  resolveProductStatus: (category: string, externalLabel: string) => TechnicalServiceStatus,
): readonly TechnicalImportPreviewStandGroup[] {
  const groups = report.rows.map((row): TechnicalImportPreviewStandGroup => ({
    standNumber: row.standNumber,
    companyName: row.companyName,
    services: row.services.map((service) => ({
      externalLabel: service.externalLabel,
      quantity: service.quantity,
      isUnknownProduct: resolveProductStatus(service.category, service.externalLabel) === "unresolved_product",
    })),
    notes: row.notes.map((note) => note.text),
  }));
  return sortStandNumbersNatural(groups, (group) => group.standNumber);
}

/** Same counting rules the existing pre-import preview already used (Set of raw row.standNumber, sum of services.length) — extracted verbatim so introducing this summary never changes what gets shown. */
export function summarizeParsedReport(
  report: ParsedTechnicalReport,
  resolveProductStatus: (category: string, externalLabel: string) => TechnicalServiceStatus,
): TechnicalImportPreviewSummary {
  const standNumbers = new Set<string>();
  let serviceCount = 0;
  let unknownProductCount = 0;
  for (const row of report.rows) {
    standNumbers.add(row.standNumber);
    for (const service of row.services) {
      serviceCount += 1;
      if (resolveProductStatus(service.category, service.externalLabel) === "unresolved_product") unknownProductCount += 1;
    }
  }
  return { standCount: standNumbers.size, serviceCount, warningCount: report.warnings.length, unknownProductCount };
}

/**
 * Reconstructs one historical import's grouped-by-stand view from the project's CURRENT stands[]
 * (spec section 15: "stejná prezentace jako preview před importem", reusing the same output shape)
 * — filtered purely by provenance (service.sourceImportId / note.sourceImportId), the same
 * traceability discipline domain/technicalRaster.ts already establishes (spec section 32). A stand
 * with none of this import's services/notes left (e.g. every one of them was later superseded) is
 * omitted, never shown as an empty group.
 */
export function groupImportedStandsByImport(stands: readonly TechnicalStand[], importId: string): readonly TechnicalImportPreviewStandGroup[] {
  const groups: TechnicalImportPreviewStandGroup[] = [];
  for (const stand of stands) {
    const services = stand.services.filter((service) => service.sourceImportId === importId);
    const notes = stand.notes.filter((note) => note.sourceImportId === importId);
    if (services.length === 0 && notes.length === 0) continue;
    groups.push({
      standNumber: stand.standNumber,
      companyName: stand.companyName,
      services: services.map((service) => ({
        externalLabel: service.externalLabel,
        quantity: service.quantity,
        isUnknownProduct: service.status === "unresolved_product",
      })),
      notes: notes.map((note) => note.text),
    });
  }
  return sortStandNumbersNatural(groups, (group) => group.standNumber);
}

function normalizedForSearch(value: string | undefined): string {
  return (value ?? "").normalize("NFD").replace(/[̀-ͯ]/gu, "").toLowerCase();
}

/** Diacritics-insensitive substring match against stand number + company name — same normalization convention as domain/search.ts's other matchesXSearch helpers, kept local here since this view lives in its own module. */
export function matchesTechnicalImportPreviewSearch(group: TechnicalImportPreviewStandGroup, query: string): boolean {
  const needle = normalizedForSearch(query.trim());
  if (!needle) return true;
  return [group.standNumber, group.companyName].some((value) => normalizedForSearch(value).includes(needle));
}
