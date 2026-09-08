/** Úklid — spec section 14. "Denní úklid: 40" — 40 is kept as-is (quantity + rawValue); this parser never guesses what the number means beyond what the product catalog itself defines. */
import { buildParsedTechnicalReport, type TechnicalReportParser } from "./technicalReportParser.ts";

export const cleaningReportParser: TechnicalReportParser = {
  category: "cleaning",
  detectionHints: ["úklid", "uklid"],
  parse: (items) => buildParsedTechnicalReport("cleaning", items),
};
