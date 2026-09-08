/** Voda / voda a odpad — spec section 8 ("Voda / voda a odpad" is listed as its own known category alongside Odpad). */
import { buildParsedTechnicalReport, type TechnicalReportParser } from "./technicalReportParser.ts";

export const waterReportParser: TechnicalReportParser = {
  category: "water",
  detectionHints: ["voda", "vodovodní", "přípojka vody"],
  parse: (items) => buildParsedTechnicalReport("water", items),
};
