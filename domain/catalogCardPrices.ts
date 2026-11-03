import {
  findSaleEntry,
  resolveAmount,
  type PriceListKind,
  type PriceListVersion,
  type PurchasePriceEntry,
  type SalePriceEntry,
  type VersionedPriceList,
} from "./priceVersions.ts";

/**
 * Catalog card → section "Ceny" (read-only overview). The card describes the component; the
 * versioned price lists (V1-DATA-05) hold its prices. Everything here is a pure read of ONE chosen
 * version: nothing is stored on the card, no list, version, event assignment or project changes.
 */

export type CardPriceStatus = "priced" | "missing" | "individual" | "included";

export type CardPriceCell = Readonly<{ status: CardPriceStatus; amount?: number }>;

export type CardSalePrices = Readonly<{
  /** A row for this card exists in the version (item-wide row; variant rows are listed separately in the price list). */
  hasEntry: boolean;
  czk: CardPriceCell;
  eurSk: CardPriceCell & Readonly<{
    /** derived = CZK converted with the version's rate; manual = exception set in the price list. */
    source?: "derived" | "manual";
    /** The rate of THIS version (never a constant). */
    rate: number;
    /** For a manual exception: what the conversion would have given. */
    derivedAmount?: number;
  }>;
  eurWorld: CardPriceCell;
  unitCode?: string;
}>;

/** The three sale prices of a card in one version. A missing price is "missing" (shown "K nacenění"), never 0. */
export function cardSalePrices(version: PriceListVersion, entries: readonly SalePriceEntry[], catalogItemId: string): CardSalePrices {
  const entry = findSaleEntry(entries.filter((candidate) => candidate.versionId === version.id), catalogItemId);
  const rate = version.eurRate;
  if (!entry) return { hasEntry: false, czk: { status: "missing" }, eurSk: { status: "missing", rate }, eurWorld: { status: "missing" } };
  const unit = entry.unitCode ? { unitCode: entry.unitCode } : {};
  if (entry.priceMode !== "fixed") {
    const status: CardPriceStatus = entry.priceMode;
    return { hasEntry: true, czk: { status }, eurSk: { status, rate }, eurWorld: { status }, ...unit };
  }
  const source = { czk: entry.saleCzk, eurMode: entry.eurMode, eur: entry.saleEur, eurWorld: entry.saleEurWorld };
  const cell = (track: "CZK" | "EUR_SK" | "EUR_WORLD") => resolveAmount(source, track, version);
  const czk = cell("CZK");
  const eurSk = cell("EUR_SK");
  const eurWorld = cell("EUR_WORLD");
  const priced = (amount: number | undefined): CardPriceCell => (amount === undefined ? { status: "missing" } : { status: "priced", amount });
  return {
    hasEntry: true,
    czk: priced(czk.amount),
    eurSk: {
      ...priced(eurSk.amount),
      rate,
      ...(eurSk.eurSource === "manual" || eurSk.eurSource === "derived" ? { source: eurSk.eurSource } : {}),
      ...(eurSk.derivedEur !== undefined ? { derivedAmount: eurSk.derivedEur } : {}),
    },
    eurWorld: priced(eurWorld.amount),
    ...unit,
  };
}

export type CardPurchasePrice = Readonly<{ status: "priced" | "missing"; amount?: number; unitCode?: string; variantRowCount: number }>;

/** INTERNAL purchase price (CZK, without VAT) of a card in one purchase version — the shared list, not per realization firm. */
export function cardPurchasePrice(version: PriceListVersion, entries: readonly PurchasePriceEntry[], catalogItemId: string): CardPurchasePrice {
  const rows = entries.filter((entry) => entry.versionId === version.id && entry.catalogItemId === catalogItemId);
  const general = rows.find((entry) => !entry.variantId);
  const variantRowCount = rows.filter((entry) => entry.variantId).length;
  return general
    ? { status: "priced", amount: general.purchaseCzk, ...(general.unitCode ? { unitCode: general.unitCode } : {}), variantRowCount }
    : { status: "missing", variantRowCount };
}

/**
 * Which version the card shows first: the newest published one (the price list in force), else the
 * newest draft, else the newest archived. Only a starting point for viewing — the user can pick any.
 */
export function defaultCardVersion(versions: readonly PriceListVersion[], priceListId: string | undefined): PriceListVersion | undefined {
  const own = versions.filter((version) => version.priceListId === priceListId).slice().sort((a, b) => b.versionNo - a.versionNo);
  return own.find((version) => version.status === "published") ?? own.find((version) => version.status === "draft") ?? own[0];
}

/**
 * Which sale price lists a card belongs to — decided by the card's own pricing classification
 * (catalog_items.price_category: electricity → the electricity price list, everything else → the
 * base sale price list), never by the ABF code. Inactive lists are offered only when no active one
 * of that kind exists. "locked" = exactly one list, shown as a fixed source (no picker).
 */
export type CardListChoice = Readonly<{
  kind: PriceListKind;
  lists: readonly VersionedPriceList[];
  locked: boolean;
  /** Set when there is nothing to show (no list of the required kind / card unknown to the price lists). */
  warning?: string;
}>;

function listsOfKind(lists: readonly VersionedPriceList[], kind: PriceListKind): readonly VersionedPriceList[] {
  const ofKind = lists.filter((list) => list.kind === kind);
  const active = ofKind.filter((list) => list.isActive);
  return active.length ? active : ofKind;
}

const KIND_NAME_CS: Readonly<Record<PriceListKind, string>> = { base: "základní prodejní ceník", electricity: "ceník elektřiny", purchase: "nákupní ceník" };

export function cardSaleListChoice(priceCategory: "standard" | "electricity" | undefined, lists: readonly VersionedPriceList[]): CardListChoice {
  if (!priceCategory) {
    return { kind: "base", lists: [], locked: true, warning: "Komponentu se nepodařilo najít mezi položkami ceníků, a proto není známá její cenová kategorie. Ceny nejsou zobrazené, aby se neukázaly z nesprávného ceníku." };
  }
  const kind: PriceListKind = priceCategory === "electricity" ? "electricity" : "base";
  const candidates = listsOfKind(lists, kind);
  if (!candidates.length) return { kind, lists: [], locked: true, warning: `Zatím není založený žádný ${KIND_NAME_CS[kind]} (Administrace → Ceníky (verze)).` };
  return { kind, lists: candidates, locked: candidates.length === 1 };
}

/** The shared purchase price list (one for all realization firms today). More lists stay distinguishable by their own identity. */
export function cardPurchaseListChoice(lists: readonly VersionedPriceList[]): CardListChoice {
  const candidates = listsOfKind(lists, "purchase");
  if (!candidates.length) return { kind: "purchase", lists: [], locked: true, warning: "Zatím není založený nákupní ceník." };
  return { kind: "purchase", lists: candidates, locked: candidates.length === 1 };
}
