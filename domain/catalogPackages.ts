/**
 * BOOTH package contents — booth -> item -> quantity -> included_in_package (table
 * catalog_item_package_items). Pure, no I/O.
 *
 * A package (today P86 / T-typovky, later E/K stánky) can reference ANY other catalog item —
 * including a base typovka — by its stable catalog_items.id. An included line is physically used
 * and counted (quantity), but is never charged to the customer again: its price is the
 * package's own price. This reuses the existing PricingEntryMode "included" semantics
 * (domain/models.ts) — never a parallel pricing model.
 */
import type { PricingEntryMode } from "./models.ts";

export type CatalogPackageItem = Readonly<{
  id: string;
  packageItemId: string;
  childItemId: string;
  quantity: number;
  includedInPackage: boolean;
  sortOrder: number;
  note: string | null;
}>;

/** One line of an admin "save package contents" request — the full desired set, replacing the stored one. */
export type CatalogPackageItemInput = Readonly<{
  childItemId: string;
  quantity: number;
  includedInPackage: boolean;
  note?: string;
}>;

export class InvalidCatalogPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCatalogPackageError";
  }
}

const MAX_PACKAGE_LINES = 200;
const NOTE_MAX_LENGTH = 500;

/** Whitelists a raw request body into package lines. Throws InvalidCatalogPackageError on anything malformed — never silently drops a line the admin meant to save. */
export function parseCatalogPackageItemsInput(raw: unknown): readonly CatalogPackageItemInput[] {
  if (!Array.isArray(raw)) throw new InvalidCatalogPackageError("Obsah balíčku musí být seznam položek.");
  if (raw.length > MAX_PACKAGE_LINES) throw new InvalidCatalogPackageError(`Balíček může mít nejvýše ${MAX_PACKAGE_LINES} položek.`);
  return raw.map((entry, index) => {
    if (!entry || typeof entry !== "object") throw new InvalidCatalogPackageError(`Řádek ${index + 1}: neplatná položka.`);
    const candidate = entry as Record<string, unknown>;
    if (typeof candidate.childItemId !== "string" || !candidate.childItemId) {
      throw new InvalidCatalogPackageError(`Řádek ${index + 1}: chybí vybraná katalogová položka.`);
    }
    if (typeof candidate.quantity !== "number" || !Number.isFinite(candidate.quantity) || candidate.quantity <= 0) {
      throw new InvalidCatalogPackageError(`Řádek ${index + 1}: množství musí být kladné číslo.`);
    }
    const note = typeof candidate.note === "string" && candidate.note.trim() ? candidate.note.trim().slice(0, NOTE_MAX_LENGTH) : undefined;
    return {
      childItemId: candidate.childItemId,
      quantity: candidate.quantity,
      // Default true: the whole point of a package line is "part of the package price".
      includedInPackage: candidate.includedInPackage !== false,
      ...(note ? { note } : {}),
    };
  });
}

/**
 * Validates a desired package content set against the catalog: the package itself must exist,
 * no line may reference the package itself, every child must exist, no child may repeat, and no
 * cycle may appear through nested packages (a package containing a typovka that contains this
 * package again). Archived children are allowed — archival never breaks an existing package.
 */
export function assertValidPackageContents(
  packageItemId: string,
  lines: readonly CatalogPackageItemInput[],
  knownItemIds: ReadonlySet<string>,
  existingLinks: readonly Pick<CatalogPackageItem, "packageItemId" | "childItemId">[],
): void {
  if (!knownItemIds.has(packageItemId)) throw new InvalidCatalogPackageError("Balíček (stánek) nebyl v katalogu nalezen.");
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.childItemId === packageItemId) throw new InvalidCatalogPackageError("Stánek nemůže obsahovat sám sebe.");
    if (!knownItemIds.has(line.childItemId)) throw new InvalidCatalogPackageError("Vybraná položka balíčku neexistuje v katalogu.");
    if (seen.has(line.childItemId)) throw new InvalidCatalogPackageError("Stejná položka je v balíčku vícekrát — upravte raději množství.");
    seen.add(line.childItemId);
  }
  // Cycle check over the graph AFTER this save: other packages' links stay as stored, this
  // package's links are replaced by `lines`.
  const graph = new Map<string, string[]>();
  for (const link of existingLinks) {
    if (link.packageItemId === packageItemId) continue;
    graph.set(link.packageItemId, [...(graph.get(link.packageItemId) ?? []), link.childItemId]);
  }
  graph.set(packageItemId, lines.map((line) => line.childItemId));
  const visiting = new Set<string>();
  const done = new Set<string>();
  function visit(node: string): void {
    if (done.has(node)) return;
    if (visiting.has(node)) throw new InvalidCatalogPackageError("Obsah balíčku by vytvořil cyklus (balíček by nepřímo obsahoval sám sebe).");
    visiting.add(node);
    for (const child of graph.get(node) ?? []) visit(child);
    visiting.delete(node);
    done.add(node);
  }
  visit(packageItemId);
}

/** Deterministic display/processing order: sortOrder, then id. */
export function sortPackageItems<T extends Pick<CatalogPackageItem, "sortOrder" | "id">>(items: readonly T[]): readonly T[] {
  return items.slice().sort((a, b) => a.sortOrder - b.sortOrder || a.id.localeCompare(b.id));
}

export function packageItemsFor(packageItemId: string, links: readonly CatalogPackageItem[]): readonly CatalogPackageItem[] {
  return sortPackageItems(links.filter((link) => link.packageItemId === packageItemId));
}

// ============================================================================
// PRICING — included lines are counted but never re-charged.
// ============================================================================

export type PackageUnitPrice = Readonly<{ priceMode: PricingEntryMode; salePrice?: number }> | undefined;

export type PackagePriceLine = Readonly<{
  childItemId: string;
  quantity: number;
  includedInPackage: boolean;
  /** "included" for every included line, whatever the child's own catalog price would be. */
  status: "included" | "priced" | "individual" | "missing";
  unitPriceNet: number;
  totalNet: number;
}>;

export type PackagePriceResult = Readonly<{
  lines: readonly PackagePriceLine[];
  /** The package's own price (base) + every NON-included, fixed-priced line. */
  totalNet: number;
  /** True when some non-included line has no fixed price yet (individual/missing) — the total is then incomplete and must be quoted. */
  needsQuote: boolean;
}>;

/**
 * Prices a package: the package price covers every included line (unit price 0, status
 * "included"); only non-included (optional extra) lines are priced through `resolveUnitPrice`,
 * which callers back with the existing Event → PriceList → PricingEntry resolution
 * (domain/catalog.ts selectPricingEntry). Quantities are always preserved so the generator can
 * still count/place the physical items.
 */
export function pricePackage(
  packagePriceNet: number,
  lines: readonly Pick<CatalogPackageItem, "childItemId" | "quantity" | "includedInPackage">[],
  resolveUnitPrice: (childItemId: string) => PackageUnitPrice,
): PackagePriceResult {
  let totalNet = packagePriceNet;
  let needsQuote = false;
  const priced = lines.map((line): PackagePriceLine => {
    if (line.includedInPackage) {
      return { childItemId: line.childItemId, quantity: line.quantity, includedInPackage: true, status: "included", unitPriceNet: 0, totalNet: 0 };
    }
    const unit = resolveUnitPrice(line.childItemId);
    if (unit?.priceMode === "included") {
      return { childItemId: line.childItemId, quantity: line.quantity, includedInPackage: false, status: "included", unitPriceNet: 0, totalNet: 0 };
    }
    if (unit?.priceMode === "individual") {
      needsQuote = true;
      return { childItemId: line.childItemId, quantity: line.quantity, includedInPackage: false, status: "individual", unitPriceNet: 0, totalNet: 0 };
    }
    if (unit?.salePrice === undefined) {
      needsQuote = true;
      return { childItemId: line.childItemId, quantity: line.quantity, includedInPackage: false, status: "missing", unitPriceNet: 0, totalNet: 0 };
    }
    const lineTotal = unit.salePrice * line.quantity;
    totalNet += lineTotal;
    return { childItemId: line.childItemId, quantity: line.quantity, includedInPackage: false, status: "priced", unitPriceNet: unit.salePrice, totalNet: lineTotal };
  });
  return { lines: priced, totalNet, needsQuote };
}
