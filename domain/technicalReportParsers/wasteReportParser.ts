/** Odpad — spec section 13. Free-text notes ("doobjednáno telefonicky...") found under a stand's row are attached to that stand by buildParsedTechnicalReport's generic note-handling, never dropped. */
import { buildParsedTechnicalReport, type TechnicalReportParser } from "./technicalReportParser.ts";

export const wasteReportParser: TechnicalReportParser = {
  category: "waste",
  detectionHints: ["odpad", "kontejner", "odvoz"],
  parse: (items) => buildParsedTechnicalReport("waste", items),
};
