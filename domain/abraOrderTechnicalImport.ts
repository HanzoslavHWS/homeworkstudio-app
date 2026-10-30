/**
 * ABRA order form ("3. Formulář objednávky přijaté ABF") -> technical raster services, plus the
 * control overview shown before confirming.
 *
 * Services are recognized ONLY by ABF code, through the approved marker table
 * (domain/technicalMarkerApprovedTable.ts, 31 codes). Names are never used to guess a code. A matched
 * item becomes a service with the approved table's ABRA name as `externalLabel`, so it gets exactly
 * the same marker, color, point rule and identity as the same service from a per-category report —
 * that is what lets an order import take over the placements of earlier reports.
 *
 * Order rules (stand number × technical service):
 *   no stand,  no service  -> ignored
 *   stand,     no service  -> ignored (furniture, registration, parking, … are never markers)
 *   no stand,  service     -> listed for review ("Služby bez čísla stánku"), NOT put into the raster
 *   stand,     service     -> imported
 * One stand may have several orders, one order may repeat an item: every item line stays its own
 * service (with its order number, printed name and notes). Decimal quantities are kept ("1,8 m³").
 * A zero price is a valid service. A cancellation fee (R99 STORNOPOPLATEK) does not cancel anything:
 * the order is listed for review and its services are imported as printed.
 */
import type { AbraAmbiguousPage, AbraOrder, AbraOrderItem, ParsedAbraOrderForm } from "./abraOrderForm.ts";
import { APPROVED_TECHNICAL_MARKER_ROWS } from "./technicalMarkerApprovedTable.ts";
import { ABRA_ORDER_IMPORT_CATEGORY, type ParsedTechnicalReport, type ParsedTechnicalServiceRow } from "./technicalRaster.ts";
import { resolveTechnicalServicePresentation } from "./technicalRasterServicePresentation.ts";
import { normalizeStandNumber } from "./technicalStandNumber.ts";

export type AbraTechnicalCodeMapping = Readonly<{ abfCode: string; category: string; externalLabel: string }>;

/** ABF code -> approved technical service (only the 31 rows that have a code). */
export const ABRA_TECHNICAL_CODE_MAP: ReadonlyMap<string, AbraTechnicalCodeMapping> = new Map(
  APPROVED_TECHNICAL_MARKER_ROWS.filter((row) => row.abfCode && row.category !== "other").map((row) => [row.abfCode!, { abfCode: row.abfCode!, category: row.category, externalLabel: row.abraName }]),
);

/** ABF code families of the technical services (every approved code starts with one of these). An unmapped code from these families is listed as "neznámý kód" — never imported, never guessed. */
const TECHNICAL_CODE_FAMILIES = new Set([...ABRA_TECHNICAL_CODE_MAP.keys()].map((code) => code[0]!));

export const ABRA_CANCELLATION_FEE_CODE = "R99";
/**
 * L63 "BEZ ELEKTRICKÉ ENERGIE" — not an electricity connection: it means the stand has NO electricity,
 * i.e. the existing red "BEZ elektriky" X (TechnicalStand.hasNoElectricityAssignment). Never a marker
 * service; reconciled separately (domain/abraOrderReconciliation.ts).
 */
export const ABRA_NO_ELECTRICITY_CODE = "L63";

export type AbraOrderTechnicalLine = Readonly<{
  orderNumber: string;
  standNumber?: string;
  companyName?: string;
  customerNumber?: string;
  code: string;
  name: string;
  quantity?: number;
  quantityRaw: string;
  unit: string;
  notes: readonly string[];
  page: number;
  category: string;
  externalLabel: string;
}>;

export type AbraOrderReviewItem = Readonly<{
  kind: "cancellationFee" | "unreadableQuantity" | "nonPositiveQuantity" | "fractionalQuantity" | "unknownTechnicalCode" | "uncodedItem" | "noElectricityWithElectricity";
  orderNumber: string;
  standNumber?: string;
  companyName?: string;
  code: string;
  name: string;
  quantityRaw: string;
  unit: string;
  /** The item's own note lines, verbatim. */
  notes: readonly string[];
  message: string;
}>;

/** An L63 "BEZ ELEKTRICKÉ ENERGIE" item of an order. */
export type AbraNoElectricityLine = Readonly<{ orderNumber: string; standNumber?: string; companyName?: string; notes: readonly string[] }>;

export type AbraUnknownCode = Readonly<{ code: string; name: string; itemCount: number; orderNumbers: readonly string[] }>;

export type AbraOrderTechnicalImport = Readonly<{
  /** What goes into the raster — the same shape every report parser produces. */
  report: ParsedTechnicalReport;
  counts: Readonly<{
    orders: number;
    pages: number;
    items: number;
    ordersWithTechnicalServices: number;
    technicalServices: number;
    importedTechnicalServices: number;
    standsWithTechnicalServices: number;
    ordersWithoutStandOrServices: number;
    ordersWithStandWithoutServices: number;
    emptyOrders: number;
  }>;
  /** Technical services of orders without a stand number — shown, never put into the raster. */
  servicesWithoutStand: readonly AbraOrderTechnicalLine[];
  /** Unmapped codes of the technical code families (e.g. L63 "BEZ ELEKTRICKÉ ENERGIE"). */
  unknownTechnicalCodes: readonly AbraUnknownCode[];
  /** Cancellation fees and problematic items — shown for review, nothing is deleted. */
  reviewItems: readonly AbraOrderReviewItem[];
  /** Every line of an order WITH a stand (the candidates for the raster), in order. */
  importedLines: readonly AbraOrderTechnicalLine[];
  /** L63 items — with or without a stand. */
  noElectricityLines: readonly AbraNoElectricityLine[];
  /** PDF pages that could not be assigned to an order (their items were not loaded). */
  ambiguousPages: readonly AbraAmbiguousPage[];
}>;

function technicalLine(order: AbraOrder, item: AbraOrderItem, mapping: AbraTechnicalCodeMapping): AbraOrderTechnicalLine {
  return {
    orderNumber: order.orderNumber,
    standNumber: order.standNumber,
    companyName: order.companyName,
    customerNumber: order.customerNumber,
    code: item.code,
    name: item.name,
    quantity: item.quantity,
    quantityRaw: item.quantityRaw,
    unit: item.unit,
    notes: item.notes,
    page: item.page,
    category: mapping.category,
    externalLabel: mapping.externalLabel,
  };
}

export function buildAbraOrderTechnicalImport(parsed: ParsedAbraOrderForm): AbraOrderTechnicalImport {
  const servicesWithoutStand: AbraOrderTechnicalLine[] = [];
  const importedLines: AbraOrderTechnicalLine[] = [];
  const reviewItems: AbraOrderReviewItem[] = [];
  const unknown = new Map<string, { code: string; name: string; itemCount: number; orderNumbers: Set<string> }>();
  let ordersWithTechnicalServices = 0;
  let ordersWithoutStandOrServices = 0;
  let ordersWithStandWithoutServices = 0;

  const noElectricityLines: AbraNoElectricityLine[] = [];
  const review = (order: AbraOrder, item: AbraOrderItem, kind: AbraOrderReviewItem["kind"], message: string) => reviewItems.push({
    kind, orderNumber: order.orderNumber, standNumber: order.standNumber, companyName: order.companyName, code: item.code, name: item.name, quantityRaw: item.quantityRaw, unit: item.unit, notes: item.notes, message,
  });

  for (const order of parsed.orders) {
    const lines: AbraOrderTechnicalLine[] = [];
    for (const item of order.items) {
      if (item.code === ABRA_CANCELLATION_FEE_CODE) review(order, item, "cancellationFee", "Stornopoplatek — služby objednávky se nemažou, zkontrolujte objednávku ručně.");
      if (!item.code) {
        review(order, item, "uncodedItem", "Položka bez ABF kódu — do rastru se nepřevádí.");
        continue;
      }
      if (item.code === ABRA_NO_ELECTRICITY_CODE) {
        noElectricityLines.push({ orderNumber: order.orderNumber, standNumber: order.standNumber, companyName: order.companyName, notes: item.notes });
        continue;
      }
      const mapping = ABRA_TECHNICAL_CODE_MAP.get(item.code);
      if (!mapping) {
        if (TECHNICAL_CODE_FAMILIES.has(item.code[0]!)) {
          const entry = unknown.get(item.code) ?? { code: item.code, name: item.name, itemCount: 0, orderNumbers: new Set<string>() };
          entry.itemCount += 1;
          entry.orderNumbers.add(order.orderNumber);
          unknown.set(item.code, entry);
          review(order, item, "unknownTechnicalCode", `Kód ${item.code} není ve schválené tabulce technických značek — nepřevádí se.`);
        }
        continue;
      }
      const line = technicalLine(order, item, mapping);
      lines.push(line);
      if (item.quantity === undefined) review(order, item, "unreadableQuantity", "Nečitelné množství — služba se převede s množstvím 0, zkontrolujte ji.");
      else if (item.quantity <= 0) review(order, item, "nonPositiveQuantity", "Nulové nebo záporné množství — zkontrolujte položku.");
      else if (!Number.isInteger(item.quantity) && resolveTechnicalServicePresentation(mapping.category, mapping.externalLabel, item.quantity).placementCardinality === "perQuantity") {
        review(order, item, "fractionalQuantity", "Desetinné množství u služby, která se umisťuje po kusech — počet bodů se zaokrouhlí nahoru.");
      }
    }
    const orderHasNoElectricity = order.items.some((item) => item.code === ABRA_NO_ELECTRICITY_CODE);
    if (orderHasNoElectricity && lines.some((line) => line.category === "electricity")) {
      const l63 = order.items.find((item) => item.code === ABRA_NO_ELECTRICITY_CODE)!;
      review(order, l63, "noElectricityWithElectricity", "Objednávka má L63 „BEZ ELEKTRICKÉ ENERGIE“ a zároveň objednanou elektrickou přípojku — rozpor, zkontrolujte objednávku.");
    }
    if (lines.length === 0) {
      if (orderHasNoElectricity) { ordersWithTechnicalServices += 1; continue; }
      if (order.standNumber) ordersWithStandWithoutServices += 1;
      else ordersWithoutStandOrServices += 1;
      continue;
    }
    ordersWithTechnicalServices += 1;
    if (order.standNumber) importedLines.push(...lines);
    else servicesWithoutStand.push(...lines);
  }

  // One raster row per stand, items in order: several orders of one stand are merged, every item stays its own service.
  const rows = new Map<string, { standNumber: string; companyName?: string; services: ParsedTechnicalServiceRow["services"][number][] }>();
  for (const line of importedLines) {
    const key = normalizeStandNumber(line.standNumber!);
    const row = rows.get(key) ?? { standNumber: line.standNumber!, companyName: line.companyName, services: [] };
    row.services.push({
      category: line.category,
      externalLabel: line.externalLabel,
      quantity: line.quantity ?? 0,
      rawValue: line.quantityRaw,
      sourcePage: line.page,
      rawRow: `${line.orderNumber} · ${line.code} ${line.name} · ${line.quantityRaw} ${line.unit}`.trim(),
      abfCode: line.code,
      sourceOrderNumber: line.orderNumber,
      sourceItemName: line.name,
      ...(line.notes.length > 0 ? { itemNotes: line.notes } : {}),
    });
    rows.set(key, row);
  }

  const report: ParsedTechnicalReport = {
    category: ABRA_ORDER_IMPORT_CATEGORY,
    rows: [...rows.values()].map((row) => ({ standNumber: row.standNumber, companyName: row.companyName, services: row.services, notes: [] })),
    warnings: parsed.warnings.map((warning) => ({ message: warning.orderNumber ? `${warning.orderNumber}: ${warning.message}` : warning.message, page: warning.page, rawText: warning.rawText })),
  };

  return {
    report,
    counts: {
      orders: parsed.orders.length,
      pages: parsed.pageCount,
      items: parsed.orders.reduce((sum, order) => sum + order.items.length, 0),
      ordersWithTechnicalServices,
      technicalServices: importedLines.length + servicesWithoutStand.length,
      importedTechnicalServices: importedLines.length,
      standsWithTechnicalServices: rows.size,
      ordersWithoutStandOrServices,
      ordersWithStandWithoutServices,
      emptyOrders: parsed.orders.filter((order) => order.items.length === 0).length,
    },
    servicesWithoutStand,
    unknownTechnicalCodes: [...unknown.values()].map((entry) => ({ code: entry.code, name: entry.name, itemCount: entry.itemCount, orderNumbers: [...entry.orderNumbers] })).sort((a, b) => a.code.localeCompare(b.code)),
    reviewItems,
    importedLines,
    noElectricityLines,
    ambiguousPages: parsed.ambiguousPages,
  };
}
