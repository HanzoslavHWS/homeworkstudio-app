/** Internet / WiFi — spec section 12. Quantity is a real number (a stand can order e.g. 2 extra WiFi connections), never reduced to a boolean. */
import { buildParsedTechnicalReport, type TechnicalReportParser } from "./technicalReportParser.ts";

export const internetReportParser: TechnicalReportParser = {
  category: "internet",
  detectionHints: ["internet", "wifi", "wi-fi", "pevná ip", "router"],
  parse: (items) => buildParsedTechnicalReport("internet", items),
};
