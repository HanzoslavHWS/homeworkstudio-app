/**
 * Technické rastry — HOTFIX-02: the APPROVED technical marker table, transcribed verbatim from
 * `_IMPORT/TECHNICKE_ZNACKY/Generator_ABF_Revize_technickych_znacek.xlsx` (sheet "Technické značky",
 * every row "Schváleno"): B = ABRA name, K = NOVÝ popisek v rastru (identical to L, NOVÝ text v PDF),
 * N = NOVÁ barva (HEX), P = NOVÉ pravidlo počtu bodů.
 *
 * This is REFERENCE data, not configuration: domain/technicalRasterServicePresentation.ts is the
 * implementation, tests/technicalRasterServicePresentation.test.ts asserts it against this table,
 * and scripts/technicalMarkersExcelCheck.ts asserts this table against the real Excel when it is
 * present locally (the Excel itself lives in the git-ignored _IMPORT/ and is never committed).
 * Contains service names only — no exhibitor data.
 */

export type ApprovedMarkerPointRule = "Podle množství" | "Vždy 1 bod";

export type ApprovedTechnicalMarkerRow = Readonly<{
  /** domain/technicalServiceCatalog.ts category id; "other" = the Excel's "Ostatní" example of an unknown category. */
  category: string;
  /** Excel column B. */
  abraName: string;
  /** Excel column K/L — `{mnozstvi}` is the service's own quantity. */
  label: string;
  /** Excel column N. */
  color: string;
  /** Excel column P. */
  rule: ApprovedMarkerPointRule;
}>;

/** Excel column A (Czech category name) -> category id. */
export const APPROVED_MARKER_CATEGORY_IDS: Readonly<Record<string, string>> = {
  "Elektřina": "electricity",
  "Internet": "internet",
  "Voda": "water",
  "Odpad": "waste",
  "Úklid": "cleaning",
  "Ostatní": "other",
};

const row = (category: string, abraName: string, label: string, color: string, rule: ApprovedMarkerPointRule): ApprovedTechnicalMarkerRow => ({ category, abraName, label, color, rule });

export const APPROVED_TECHNICAL_MARKER_ROWS: readonly ApprovedTechnicalMarkerRow[] = [
  row("electricity", "Do 2kW 230V", "2 kW", "#b3261e", "Podle množství"),
  row("electricity", "Do 3kW 230V", "3 kW", "#b3261e", "Podle množství"),
  row("electricity", "Do 5kW 230V", "5 kW", "#b3261e", "Podle množství"),
  row("electricity", "Do 6kW 230V", "6 kW", "#b3261e", "Podle množství"),
  row("electricity", "Do 9kW 400V", "9 kW", "#b3261e", "Podle množství"),
  row("electricity", "Do 15kW 400V", "15 kW", "#b3261e", "Podle množství"),
  row("electricity", "Do 21kW 400V", "21 kW", "#b3261e", "Podle množství"),
  row("electricity", "Do 40kW 400V", "40 kW", "#b3261e", "Podle množství"),
  row("electricity", "Rozvaděč 9-21kW", "El.rozvaděč", "#b3261e", "Podle množství"),
  row("electricity", "EET 0.5KW", "0.5 kW", "#b3261e", "Podle množství"),
  row("electricity", "+ kW", "EL", "#b3261e", "Podle množství"),
  row("electricity", "Vrchní přívod", "Vrch. Přívod", "#b3261e", "Podle množství"),
  row("electricity", "Osvětlení", "OSV", "#b3261e", "Podle množství"),
  row("electricity", "Jistič C", "C", "#b3261e", "Podle množství"),
  row("electricity", "Jistič D", "D", "#b3261e", "Podle množství"),
  row("electricity", "Lednicový okruh", "LED", "#b3261e", "Podle množství"),
  row("electricity", "Non stop", "Non-stop", "#b3261e", "Podle množství"),
  row("internet", "Pevná IP", "IP", "#b8860b", "Podle množství"),
  row("internet", "Internet", "INT", "#b8860b", "Podle množství"),
  row("internet", "Další přípojka", "INT", "#b8860b", "Podle množství"),
  row("internet", "RJ 2 EEt", "INT", "#b8860b", "Podle množství"),
  row("internet", "Router zapůjčení", "Router", "#b8860b", "Podle množství"),
  row("internet", "WIFI", "WiFi", "#b8860b", "Vždy 1 bod"),
  row("internet", "Další WIFI přípojka", "WiFi", "#b8860b", "Vždy 1 bod"),
  row("internet", "WIFI 2 EEt", "WiFi", "#b8860b", "Vždy 1 bod"),
  row("water", "Voda, odpad", "Voda", "#1a7a4c", "Podle množství"),
  row("water", "Bazén - přípojka", "Napuš.Bazén", "#1a7a4c", "Vždy 1 bod"),
  row("water", "Bazén - objem", "{mnozstvi} m³", "#1a7a4c", "Vždy 1 bod"),
  row("waste", "Kontejn 1100 l", "ODP", "#7a5230", "Vždy 1 bod"),
  row("waste", "vana 3 m3", "ODP", "#7a5230", "Vždy 1 bod"),
  row("waste", "Odvoz odpadu", "ODP", "#7a5230", "Vždy 1 bod"),
  row("cleaning", "Denní úklid", "ÚKL", "#6a4c93", "Vždy 1 bod"),
  row("cleaning", "Generální úklid", "ÚKL", "#6a4c93", "Vždy 1 bod"),
  row("other", "Stěhování nábytku (příklad)", "STĚH", "#6b6f72", "Vždy 1 bod"),
];
