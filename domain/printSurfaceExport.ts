/**
 * Tiskové plochy V3 — export history + the export VIEW MODEL (spec sections 10/15/16/17). Still
 * no real PDF renderer — the A4 layout is built as printable HTML (see
 * PrintSurfaceExportPanel.tsx) that the browser's own print-to-PDF handles; this module only
 * computes the fully-resolved, presentation-ready DATA that layout renders, so the print HTML
 * builder never re-derives dimension/type-label/grouping/pricing logic itself.
 *
 * V4 (pricing): pricing is entirely optional and driven by the caller — this module never
 * resolves prices itself, it only formats whatever PrintSurfacePriceResolution the editor already
 * computed (see domain/printSurfacePricing.ts) into row/footer labels, and only when the caller's
 * `showPrices` is true (spec section 9.9's "[ ] Zobrazit ceny", default false — the production PDF
 * stays price-free unless the flag is on).
 */

import {
  findPreset,
  printSurfacePresetDisplayName,
  type PrintSurfacePreset,
} from "./printSurfacePreset.ts";
import {
  findPrintSurfaceView,
  formatPrintSurfaceItemDimension,
  itemForPlacement,
  placementsForItem,
  placementsForView,
  resolvePrintSurfaceItemDimension,
  resolvePrintSurfaceItemQuantity,
  type PrintSurfaceProject,
} from "./printSurfaceProject.ts";
import { formatPrintSurfacePriceStatus, sumPrintSurfacePrices, type PrintSurfacePriceResolution } from "./printSurfacePricing.ts";
import { printSurfaceTypeLabel, type PrintSurfaceTypeId } from "./printSurfaceTypeCatalog.ts";
import type { PrintSurfaceProductionDimension } from "./printSurfaceProductionDimension.ts";
import type { EventBranding } from "./eventBranding.ts";
import { resolveGraphicsInstructions, type GraphicsInstructions } from "./graphicsInstructions.ts";
import type { RealizationCompany } from "./realizationCompany.ts";
import { sanitizeFileNameSegment } from "./graphicsFileNaming.ts";

/** A closed union, not a boolean — room to add "outlook_draft" etc. later without redesigning the table (spec section 15/16). */
export const PRINT_SURFACE_EXPORT_TYPES = ["pdf_overview"] as const;
export type PrintSurfaceExportType = (typeof PRINT_SURFACE_EXPORT_TYPES)[number];

export type PrintSurfaceExportRecord = Readonly<{
  id: string;
  projectId: string;
  exportType: PrintSurfaceExportType;
  createdBy?: string;
  createdAt: string;
  // Reserved — never set just because a draft/preview was opened (see printSurfaceProject.ts's markPrintSurfaceProjectSent doc).
  sentAt?: string;
  sentBy?: string;
  recipient?: string;
  language?: string;
  fileStorageKey?: string;
}>;

export type PrintSurfaceExportCreateInput = Readonly<{
  projectId: string;
  exportType: PrintSurfaceExportType;
  createdBy?: string;
  /** Set only when a real PDF artifact (lib/printSurfacePdf.ts) was generated AND uploaded successfully — "PDF vytvořen" never implies "e-mail odeslán" (spec section 14), so this is written at create time, independent of markSent below. */
  fileStorageKey?: string;
}>;

/** "E-mail odeslán" is a SEPARATE, later action on an EXISTING export record — never bundled into create() (spec section 14: "Nespojuj 'PDF vytvořeno' automaticky s 'email odeslán'"). Only ever called from an explicit, user-confirmed action — see PrintSurfaceExportPanel.tsx's "Potvrdit jako odesláno". */
export type PrintSurfaceExportMarkSentInput = Readonly<{
  recipient?: string;
  language?: string;
  sentBy?: string;
}>;

export interface PrintSurfaceExportRepository {
  list(projectId: string): Promise<readonly PrintSurfaceExportRecord[]>;
  create(input: PrintSurfaceExportCreateInput): Promise<PrintSurfaceExportRecord>;
  markSent(id: string, input: PrintSurfaceExportMarkSentInput): Promise<PrintSurfaceExportRecord>;
}

/** Revision is simply "how many exports of this project already exist, plus this one" — no separate versioning model (spec section 12: keep it simple). */
export function nextPrintSurfaceExportRevision(existingExportCount: number): number {
  return existingExportCount + 1;
}

/**
 * One current/latest PDF per project (real-usage follow-up) — one human-readable, STABLE filename
 * shared by every place a print-surfaces PDF is referenced: the download, the StoredAsset
 * (fileStorageKey's display name), and the email handoff's attachment filename. Reuses the SAME
 * diacritics/invalid-char/whitespace sanitizer Graphics Export already established
 * (domain/graphicsFileNaming.ts) rather than a second ad-hoc sanitizer.
 *
 * Deliberately based on the project's own NAME, not companyName (spec: "Použij název uloženého
 * PrintSurfaceProject, ne companyName") and deliberately carries NO revision — every regeneration
 * of the SAME project produces the exact same filename, which is what makes "one current PDF
 * artifact per project" (see PrintSurfaceLatestPdf in domain/printSurfaceProject.ts) a stable,
 * recognizable file rather than a new name each time. `revision`/`realizationCompanyName` still
 * exist on PrintSurfaceExportViewModel for export-history/internal tracking purposes, but
 * lib/printSurfacePdf.ts's drawMetadataGrid no longer renders either one — a real-usage follow-up
 * removed both "Realizační firma" and "Revize" from the customer-facing document entirely.
 */
export function buildPrintSurfaceExportFileName(input: Readonly<{ eventName?: string; projectName?: string }>): string {
  const segments = [
    "Tiskove_plochy",
    input.eventName ? sanitizeFileNameSegment(input.eventName) : undefined,
    input.projectName ? sanitizeFileNameSegment(input.projectName) : undefined,
  ].filter((segment): segment is string => Boolean(segment));
  return `${segments.join("_")}.pdf`;
}

export type PrintSurfaceExportMarker = Readonly<{
  id: string;
  label: string;
  xNormalized: number;
  yNormalized: number;
}>;

export type PrintSurfaceExportImage = Readonly<{
  viewId: string;
  viewLabel: string;
  imageUrl?: string;
  markers: readonly PrintSurfaceExportMarker[];
}>;

export type PrintSurfaceExportRow = Readonly<{
  label: string;
  typeLabel: string;
  surfaceName: string;
  dimensionLabel: string;
  quantity: number;
  note: string;
  /** The view(s) this physical item is pinned on, joined with ", " — only meaningful (and only shown as a table column) once the project has more than one view (spec section 8). A surface pinned on 2 views still gets exactly ONE row here (spec section 9: billed/listed once). */
  viewLabel: string;
  /** Per-piece unit + amount, e.g. "2.223 m²" or "5 bm" — set only when showPrices and the item is included in the calculation with a resolvable dimension. */
  priceQuantityLabel?: string;
  /** e.g. "450 CZK / m²" — set only when a real PricingEntry rate was found. */
  priceRateLabel?: string;
  /** The row's total price, or a status message like "Cena není v ceníku definována" — set only when showPrices and the item is included in the calculation. */
  priceLabel?: string;
}>;

const SUMMARY_GROUPS: readonly Readonly<{ id: string; labelCz: string; typeIds: readonly PrintSurfaceTypeId[] }>[] = [
  { id: "panel", labelCz: "Panely", typeIds: ["panel", "panel_above_door"] },
  { id: "fascia", labelCz: "Límce", typeIds: ["fascia"] },
  { id: "counter", labelCz: "Pulty", typeIds: ["counter_front", "counter_side"] },
  { id: "showcase", labelCz: "Vitríny", typeIds: ["showcase"] },
  { id: "custom", labelCz: "Jiné plochy", typeIds: ["custom"] },
];

export type PrintSurfaceExportSummaryGroup = Readonly<{ id: string; labelCz: string; count: number }>;

export type PrintSurfaceExportSummary = Readonly<{
  total: number;
  groups: readonly PrintSurfaceExportSummaryGroup[];
}>;

/** Coarser than the toolbar's product groups (domain/printSurfaceProductGroup.ts) — Pult and Pultová vitrína are ONE "Pulty" bucket here, matching spec section 4D's 5-group summary, never re-deriving the finer toolbar grouping for this different purpose. Only groups with at least one item are included — "skupiny přizpůsob podle skutečných dat". */
function summarizeItemsByGroup(items: readonly Readonly<{ typeId: PrintSurfaceTypeId }>[]): readonly PrintSurfaceExportSummaryGroup[] {
  return SUMMARY_GROUPS
    .map((group) => ({ id: group.id, labelCz: group.labelCz, count: items.filter((item) => (group.typeIds as readonly string[]).includes(item.typeId)).length }))
    .filter((group) => group.count > 0);
}

export type PrintSurfaceExportViewModel = Readonly<{
  projectName: string;
  companyName: string;
  eventName?: string;
  realizationCompanyName?: string;
  createdBy?: string;
  generatedAt: string;
  revision: number;
  images: readonly PrintSurfaceExportImage[];
  summary: PrintSurfaceExportSummary;
  rows: readonly PrintSurfaceExportRow[];
  /** Only true once the project actually has more than one view — the table's "Pohled" column is otherwise pure noise (spec section 8). */
  showViewColumn: boolean;
  /** Mirrors the export panel's "[ ] Zobrazit ceny" checkbox (spec section 9.9) — false by default, keeping the production PDF price-free. */
  showPrices: boolean;
  /** Sum of every row's resolved price (items with includeInCalculation=false or an unresolved price contribute 0 — see sumPrintSurfacePrices). Only rendered as a footer when showPrices is true. */
  totalPrice: number;
  /** Event branding for the header logo (spec sections 1-6) — see domain/eventBranding.ts. Never resolved here (no I/O in this module); falls back to a text-only {displayName: eventName} when the caller only passed the plain eventName string. */
  eventBranding: EventBranding;
  /** "Pokyny pro přípravu grafiky" block (spec section 7) — see domain/graphicsInstructions.ts. */
  graphicsInstructions: GraphicsInstructions;
}>;

/**
 * Builds the full "Tiskový přehled" content (spec sections 10/17) — project/firma/event/
 * realizačka/datum/vytvořil/revize, every view's image with its OWN markers (never mixed across
 * views), summary counts, and one table row per PHYSICAL ITEM (never per placement — a surface
 * pinned on 2 views is still one row) with its resolved dimension text (catalog AVAILABLE / Límec
 * / Jiná plocha / UNAVAILABLE / NOT_DEFINED all go through the exact same
 * formatPrintSurfaceItemDimension formatter the Inspector and list use — never a second copy of
 * that text here) and, optionally, pricing labels formatted from the caller's own price
 * resolutions (see domain/printSurfacePricing.ts — this module never resolves prices itself).
 */
export function buildPrintSurfaceExportViewModel(input: Readonly<{
  project: PrintSurfaceProject;
  presets: readonly PrintSurfacePreset[];
  productionDimensions: readonly PrintSurfaceProductionDimension[];
  revision: number;
  eventName?: string;
  realizationCompanyName?: string;
  imageUrlsByViewId?: Readonly<Record<string, string>>;
  generatedAt?: string;
  priceResolutions?: ReadonlyMap<string, PrintSurfacePriceResolution>;
  showPrices?: boolean;
  /** Pre-resolved by the caller (async asset URL resolution lives OUTSIDE this pure function — see PrintSurfaceExportPanel.tsx). When absent, falls back to a text-only branding object built from `eventName`. */
  eventBranding?: EventBranding;
  realizationCompany?: Pick<RealizationCompany, "id" | "name">;
}>): PrintSurfaceExportViewModel {
  const showViewColumn = input.project.views.length > 1;
  const showPrices = input.showPrices ?? false;

  const images: PrintSurfaceExportImage[] = input.project.views.map((view) => ({
    viewId: view.id,
    viewLabel: view.label,
    imageUrl: input.imageUrlsByViewId?.[view.id],
    markers: placementsForView(input.project.placements, view.id).map((placement) => {
      const item = itemForPlacement(input.project.items, placement);
      return {
        id: placement.id,
        label: item?.label ?? "?",
        xNormalized: placement.xNormalized,
        yNormalized: placement.yNormalized,
      };
    }),
  }));

  const rows: PrintSurfaceExportRow[] = input.project.items.map((item) => {
    const preset = findPreset(input.presets, item.presetId);
    const resolution = resolvePrintSurfaceItemDimension(item, input.project.realizationCompanyId, input.productionDimensions);
    const viewLabel = placementsForItem(input.project.placements, item.id)
      .map((placement) => findPrintSurfaceView(input.project.views, placement.imageId)?.label ?? "—")
      .join(", ") || "—";

    const priceResolution = input.priceResolutions?.get(item.id);
    const includePrice = showPrices && item.includeInCalculation && priceResolution !== undefined;
    const hasQuantityDetail = includePrice && (priceResolution!.status === "priced" || priceResolution!.status === "price_not_defined");

    return {
      label: item.label,
      typeLabel: printSurfaceTypeLabel(item.typeId),
      surfaceName: preset ? printSurfacePresetDisplayName(preset) : printSurfaceTypeLabel(item.typeId),
      dimensionLabel: formatPrintSurfaceItemDimension(resolution),
      quantity: resolvePrintSurfaceItemQuantity(item),
      note: item.note,
      viewLabel,
      priceQuantityLabel: hasQuantityDetail ? `${priceResolution!.quantityUnit} ${priceResolution!.unitLabel}` : undefined,
      priceRateLabel: includePrice && priceResolution!.status === "priced" ? `${priceResolution!.unitPrice} ${priceResolution!.currency} / ${priceResolution!.unitLabel}` : undefined,
      priceLabel: includePrice ? formatPrintSurfacePriceStatus(priceResolution!) : undefined,
    };
  });

  return {
    projectName: input.project.name,
    companyName: input.project.companyName,
    eventName: input.eventName,
    realizationCompanyName: input.realizationCompanyName,
    createdBy: input.project.createdBy,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    revision: input.revision,
    images,
    summary: { total: input.project.items.length, groups: summarizeItemsByGroup(input.project.items) },
    rows,
    showViewColumn,
    showPrices,
    totalPrice: input.priceResolutions ? sumPrintSurfacePrices([...input.priceResolutions.values()]) : 0,
    eventBranding: input.eventBranding ?? { displayName: input.eventName ?? "", hasCuratedLogo: false },
    graphicsInstructions: resolveGraphicsInstructions(input.realizationCompany),
  };
}
