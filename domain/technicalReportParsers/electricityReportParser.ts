/**
 * Elektrická energie — spec section 11. Columns vary (Rozvaděč 9-21 kW, EET 0.5 kW, Do 2/3/5/6/9/
 * 15/21/40 kW, Jistič C/D, Osvětlení, Non stop, ...); this parser never hardcodes which columns
 * exist — buildParsedTechnicalReport reads whatever header row the PDF actually has. Internal
 * "Lxx" product codes are resolved later against the real catalog (domain/
 * technicalServiceProductMapping.ts), never guessed here.
 */
import { buildParsedTechnicalReport, type TechnicalReportParser } from "./technicalReportParser.ts";

export const electricityReportParser: TechnicalReportParser = {
  category: "electricity",
  detectionHints: ["elektrick", "elektro", "rozvaděč", "jistič"],
  parse: (items) => buildParsedTechnicalReport("electricity", items),
};
