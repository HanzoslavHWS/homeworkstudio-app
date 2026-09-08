/**
 * Technické rastry — parser registry (spec section 40). Adding a new technical-report category
 * later means adding one new parser file + one line here — nothing else in the module changes.
 */
import { electricityReportParser } from "./electricityReportParser.ts";
import { internetReportParser } from "./internetReportParser.ts";
import { waterReportParser } from "./waterReportParser.ts";
import { wasteReportParser } from "./wasteReportParser.ts";
import { cleaningReportParser } from "./cleaningReportParser.ts";
import type { TechnicalReportParser } from "./technicalReportParser.ts";

export type { TechnicalReportParser } from "./technicalReportParser.ts";
export { buildParsedTechnicalReport } from "./technicalReportParser.ts";

export const TECHNICAL_REPORT_PARSERS: readonly TechnicalReportParser[] = [
  electricityReportParser,
  internetReportParser,
  waterReportParser,
  wasteReportParser,
  cleaningReportParser,
];

export function getTechnicalReportParser(category: string): TechnicalReportParser | undefined {
  return TECHNICAL_REPORT_PARSERS.find((parser) => parser.category === category);
}

/** Best-effort "autodetected as: X" hint only — NEVER the sole way a category is chosen (spec section 8: "nesmí být jediný způsob"); the user's own explicit category selection always wins. */
export function detectLikelyTechnicalReportCategory(sampleText: string): string | undefined {
  const normalized = sampleText.toLocaleLowerCase("cs");
  for (const parser of TECHNICAL_REPORT_PARSERS) {
    if (parser.detectionHints.some((hint) => normalized.includes(hint))) return parser.category;
  }
  return undefined;
}
