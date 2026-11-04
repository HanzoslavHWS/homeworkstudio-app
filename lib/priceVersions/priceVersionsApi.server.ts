import { NextResponse, type NextRequest } from "next/server.js";
import { requestHasPermission, type Permission, type PermissionCheck } from "../auth/permissions.ts";
import { createSupabaseServerClient, SupabaseConfigurationError } from "../db/supabase.server.ts";
import { createSupabasePriceVersionRepository, PriceVersionConflictError, PriceVersionsNotMigratedError, type PriceVersionRepository } from "../db/priceVersions.supabase.ts";
import { readCatalogItemsAdmin, readCatalogPackageItems, readCatalogVariantSets } from "../db/catalogItemsAdmin.supabase.ts";
import { documentUsageAgreement } from "../../domain/catalogItemsAdmin.ts";
import type { CatalogPackageItem } from "../../domain/catalogPackages.ts";
import type { CatalogVariantSet } from "../../domain/catalogVariants.ts";
import type { KitLineSelection } from "../../domain/catalogKitPricing.ts";
import {
  assignmentIssue,
  currencyOfTrack,
  currentEventAssignment,
  duplicateRowKeys,
  isPriceTrack,
  InvalidPriceVersionInputError,
  parsePriceListInput,
  parsePriceVersionHeaderInput,
  parsePurchaseEntryInput,
  parseSaleEntryInput,
  parseSurchargeInput,
  PRICE_CATEGORIES,
  priceKitVersioned,
  resolveSalePrice,
  SALE_PRICE_LIST_KINDS,
  surchargeKey,
  validateVersionForPublish,
  versionTrackCoverage,
  type PriceCategory,
  type PriceListKind,
  type SalePriceBook,
  type SalePriceListKind,
  type VersionedPricingContext,
} from "../../domain/priceVersions.ts";

/**
 * Administrace → Ceníky (verze) — V1-DATA-05.
 *
 *   /api/price-versions          sale lists (base, electricity), versions, event assignments, test resolution
 *   /api/purchase-prices         purchase list, versions, linked realization firms
 *
 * The two namespaces are separate on purpose: separate permissions (lib/auth/permissions.ts), and a
 * version action of one namespace refuses a version of the other, so the sale page can never read
 * or write purchase rows. No handler deletes a list, a published version or an assignment.
 */
export type PriceVersionsApiDependencies = Readonly<{
  repository: () => PriceVersionRepository;
  /** agreementItemIds: cards usable only by explicit agreement (document.usageAgreement, e.g. M04 — the PVA carpet). */
  kitData: () => Promise<Readonly<{ variantSets: readonly CatalogVariantSet[]; packageItems: readonly CatalogPackageItem[]; agreementItemIds?: readonly string[] }>>;
  hasPermission: PermissionCheck;
}>;

export const defaultPriceVersionsApiDependencies: PriceVersionsApiDependencies = {
  repository: () => createSupabasePriceVersionRepository(createSupabaseServerClient()),
  kitData: async () => {
    const client = createSupabaseServerClient();
    const [variantSets, packageItems, items] = await Promise.all([readCatalogVariantSets(client), readCatalogPackageItems(client), readCatalogItemsAdmin(client)]);
    return { variantSets, packageItems, agreementItemIds: items.filter((item) => documentUsageAgreement(item.document)).map((item) => item.id) };
  },
  hasPermission: requestHasPermission,
};

const SALE_KINDS: readonly PriceListKind[] = SALE_PRICE_LIST_KINDS;
const PURCHASE_KINDS: readonly PriceListKind[] = ["purchase"];

async function denied(request: NextRequest, dependencies: PriceVersionsApiDependencies, permission: Permission): Promise<NextResponse | undefined> {
  if (await dependencies.hasPermission(request, permission)) return undefined;
  return NextResponse.json({ error: "Pro tuto část ceníků nemáte oprávnění nebo nejste přihlášeni." }, { status: 401 });
}

async function readJsonBody(request: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  try {
    const body = (await request.json()) as unknown;
    if (!body || typeof body !== "object") throw new Error("not an object");
    return body as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }
}

function errorResponse(error: unknown, fallback: string): NextResponse {
  if (error instanceof InvalidPriceVersionInputError) return NextResponse.json({ error: error.message }, { status: 422 });
  if (error instanceof SupabaseConfigurationError || error instanceof PriceVersionsNotMigratedError) return NextResponse.json({ error: error.message }, { status: 503 });
  if (error instanceof PriceVersionConflictError) return conflictResponse(error.message, error.currentRevision);
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505") return NextResponse.json({ error: "Stejný kód ceníku nebo stejný řádek už existuje." }, { status: 409 });
  if (code === "P0001" || code === "P0002" || code === "23514" || code === "23503") {
    return NextResponse.json({ error: (error as { message?: string }).message ?? fallback }, { status: 409 });
  }
  return NextResponse.json({ error: fallback }, { status: 502 });
}

/** 409 for an optimistic-concurrency conflict: nothing was written; the client must reload. */
function conflictResponse(message: string, currentRevision?: number): NextResponse {
  return NextResponse.json({ error: message, conflict: true, ...(currentRevision !== undefined ? { currentRevision } : {}) }, { status: 409 });
}

const STALE_MESSAGE = "Verzi ceníku mezitím změnil někdo jiný. Nic nebylo uloženo; načtěte aktuální stav.";

/** The revision the client based its write on — required for every write to a version. */
function expectedRevisionOf(value: unknown): number {
  const revision = typeof value === "string" ? Number(value) : value;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) throw new InvalidPriceVersionInputError("Chybí revize verze (expectedRevision). Načtěte verzi znovu.");
  return revision;
}

/** Fast, readable refusal before any work; the database repeats the check under a row lock. */
function staleVersion(version: Readonly<{ revision: number }>, expected: number): NextResponse | undefined {
  return version.revision === expected ? undefined : conflictResponse(STALE_MESSAGE, version.revision);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function actorOf(body: Record<string, unknown>): string {
  return text(body.actor)?.slice(0, 120) ?? "Administrace";
}

/** The version and its list, only when the list belongs to this namespace. */
async function versionInNamespace(repository: PriceVersionRepository, versionId: unknown, kinds: readonly PriceListKind[]) {
  if (typeof versionId !== "string" || !versionId) throw new InvalidPriceVersionInputError("Chybí ID verze.");
  const version = await repository.getVersion(versionId);
  const list = version ? await repository.getPriceList(version.priceListId) : undefined;
  if (!version || !list || !kinds.includes(list.kind)) throw new InvalidPriceVersionInputError("Verze ceníku nebyla nalezena.");
  return { version, list };
}

async function listInNamespace(repository: PriceVersionRepository, listId: unknown, kinds: readonly PriceListKind[]) {
  if (typeof listId !== "string" || !listId) throw new InvalidPriceVersionInputError("Chybí ID ceníku.");
  const list = await repository.getPriceList(listId);
  if (!list || !kinds.includes(list.kind)) throw new InvalidPriceVersionInputError("Ceník nebyl nalezen.");
  return list;
}

async function publishCheck(repository: PriceVersionRepository, versionId: unknown, kinds: readonly PriceListKind[]) {
  const { version, list } = await versionInNamespace(repository, versionId, kinds);
  const [items, otherVersions] = await Promise.all([repository.listPricingItems(), repository.listVersions([list.id])]);
  if (list.kind === "purchase") {
    const rows = await repository.listPurchaseEntries([version.id]);
    return { version, list, check: validateVersionForPublish({ list, version, rowCount: rows.length, otherVersions, items }) };
  }
  const [saleEntries, surcharges] = await Promise.all([repository.listSaleEntries([version.id]), repository.listSurcharges([version.id])]);
  return { version, list, check: validateVersionForPublish({ list, version, rowCount: saleEntries.length, saleEntries, surcharges, otherVersions, items }) };
}

/** Version and list actions shared by both namespaces. */
async function handleVersionAction(repository: PriceVersionRepository, body: Record<string, unknown>, kinds: readonly PriceListKind[]): Promise<NextResponse> {
  const actor = actorOf(body);
  switch (body.action) {
    case "saveList": {
      const input = parsePriceListInput(body.list, kinds);
      if (input.id) {
        await listInNamespace(repository, input.id, kinds);
        return NextResponse.json({ list: await repository.updatePriceList(input.id, input) });
      }
      return NextResponse.json({ list: await repository.createPriceList(input) }, { status: 201 });
    }
    case "createVersion": {
      const list = await listInNamespace(repository, body.priceListId, kinds);
      const basedOnId = text(body.basedOnVersionId);
      let basedOn: { versionId: string; revision: number } | undefined;
      if (basedOnId) {
        const { version: source } = await versionInNamespace(repository, basedOnId, kinds);
        const expected = expectedRevisionOf(body.basedOnRevision);
        const stale = staleVersion(source, expected);
        if (stale) return stale;
        basedOn = { versionId: source.id, revision: expected };
      }
      return NextResponse.json({ versionId: await repository.createVersion(list.id, basedOn, actor) }, { status: 201 });
    }
    case "updateVersion": {
      const { version } = await versionInNamespace(repository, body.versionId, kinds);
      const expected = expectedRevisionOf(body.expectedRevision);
      if (version.status !== "draft") return NextResponse.json({ error: "Publikovaná verze ceníku je neměnná. Pro opravu vytvořte novou verzi." }, { status: 409 });
      const stale = staleVersion(version, expected);
      if (stale) return stale;
      return NextResponse.json({ ok: true, revision: await repository.updateVersionHeader(version.id, expected, parsePriceVersionHeaderInput(body.header)) });
    }
    case "deleteVersion": {
      const { version } = await versionInNamespace(repository, body.versionId, kinds);
      const expected = expectedRevisionOf(body.expectedRevision);
      if (version.status !== "draft") return NextResponse.json({ error: "Smazat lze jen koncept. Publikovanou verzi lze archivovat." }, { status: 409 });
      const stale = staleVersion(version, expected);
      if (stale) return stale;
      const copies = (await repository.listVersions([version.priceListId])).filter((candidate) => candidate.basedOnVersionId === version.id);
      if (copies.length) return NextResponse.json({ error: `Koncept nelze smazat, vychází z něj ${copies.map((copy) => `v${copy.versionNo}`).join(", ")}. Smažte nejdřív tu verzi, nebo koncept ponechte.` }, { status: 409 });
      await repository.deleteDraftVersion(version.id, expected);
      return NextResponse.json({ ok: true });
    }
    case "checkPublish": {
      const { check } = await publishCheck(repository, body.versionId, kinds);
      return NextResponse.json(check);
    }
    case "publishVersion": {
      const expected = expectedRevisionOf(body.expectedRevision);
      const { version, check } = await publishCheck(repository, body.versionId, kinds);
      const stale = staleVersion(version, expected);
      if (stale) return stale;
      if (check.errors.length) return NextResponse.json({ error: check.errors[0], ...check }, { status: 422 });
      return NextResponse.json({ ok: true, revision: await repository.publishVersion(version.id, expected, actor), warnings: check.warnings });
    }
    case "archiveVersion": {
      const { version } = await versionInNamespace(repository, body.versionId, kinds);
      const expected = expectedRevisionOf(body.expectedRevision);
      if (version.status !== "published") return NextResponse.json({ error: "Archivovat lze jen publikovanou verzi." }, { status: 409 });
      const stale = staleVersion(version, expected);
      if (stale) return stale;
      return NextResponse.json({ ok: true, revision: await repository.archiveVersion(version.id, expected) });
    }
    default:
      return NextResponse.json({ error: "Neznámá akce." }, { status: 400 });
  }
}

// ============================================================================
// Sale namespace
// ============================================================================

export async function handleSaleRegister(request: NextRequest, dependencies: PriceVersionsApiDependencies = defaultPriceVersionsApiDependencies): Promise<NextResponse> {
  const refused = await denied(request, dependencies, "prices.sale.read");
  if (refused) return refused;
  try {
    const repository = dependencies.repository();
    const lists = await repository.listPriceLists(SALE_KINDS);
    const [versions, events, assignments, items, kitData] = await Promise.all([
      repository.listVersions(lists.map((list) => list.id)),
      repository.listEvents(),
      repository.listAssignments(),
      repository.listPricingItems(),
      dependencies.kitData(),
    ]);
    const kitIds = new Set(items.filter((item) => item.itemType === "BOOTH" || item.itemType === "KIT").map((item) => item.id));
    const versionIds = versions.map((version) => version.id);
    const [allEntries, allSurcharges] = await Promise.all([repository.listSaleEntries(versionIds), repository.listSurcharges(versionIds)]);
    const coverage = Object.fromEntries(versions.map((version) => [version.id, versionTrackCoverage(allEntries.filter((entry) => entry.versionId === version.id), allSurcharges.filter((surcharge) => surcharge.versionId === version.id), version)]));
    return NextResponse.json({
      lists,
      versions,
      events,
      assignments,
      items,
      coverage,
      variantSets: kitData.variantSets,
      kitLines: kitData.packageItems.filter((line) => kitIds.has(line.packageItemId)),
    });
  } catch (error) {
    return errorResponse(error, "Ceníky se nepodařilo načíst.");
  }
}

export async function handleSaleAction(request: NextRequest, dependencies: PriceVersionsApiDependencies = defaultPriceVersionsApiDependencies): Promise<NextResponse> {
  const refused = await denied(request, dependencies, "prices.sale.write");
  if (refused) return refused;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  try {
    const repository = dependencies.repository();
    if (body.action === "assign") {
      const eventId = text(body.eventId);
      const listKind = SALE_PRICE_LIST_KINDS.find((kind) => kind === body.listKind);
      if (!eventId || !listKind) return NextResponse.json({ error: "Chybí veletrh nebo druh ceníku." }, { status: 400 });
      const versionId = text(body.versionId) ?? null;
      if (!("expectedCurrentVersionId" in body)) return NextResponse.json({ error: "Chybí aktuální přiřazení, které jste viděli (expectedCurrentVersionId). Načtěte stránku znovu." }, { status: 400 });
      const expectedCurrent = text(body.expectedCurrentVersionId) ?? null;
      if (versionId) {
        const { version, list } = await versionInNamespace(repository, versionId, SALE_KINDS);
        const issue = assignmentIssue(list, version, listKind);
        if (issue) return NextResponse.json({ error: issue }, { status: 409 });
      }
      const current = currentEventAssignment(await repository.listAssignments(), eventId, listKind)?.priceListVersionId ?? null;
      if (current !== expectedCurrent) return conflictResponse("Přiřazení ceníku veletrhu mezitím změnil někdo jiný. Nic nebylo uloženo; načtěte aktuální stav.");
      await repository.assignEventVersion(eventId, listKind, versionId, expectedCurrent, actorOf(body), text(body.note));
      return NextResponse.json({ ok: true });
    }
    if (body.action === "setPriceCategory") {
      const catalogItemId = text(body.catalogItemId);
      const category = PRICE_CATEGORIES.find((candidate) => candidate === body.priceCategory);
      if (!catalogItemId || !category) return NextResponse.json({ error: "Chybí položka nebo kategorie." }, { status: 400 });
      await repository.setPriceCategory(catalogItemId, category satisfies PriceCategory);
      return NextResponse.json({ ok: true });
    }
    return await handleVersionAction(repository, body, SALE_KINDS);
  } catch (error) {
    return errorResponse(error, "Akci s ceníkem se nepodařilo provést.");
  }
}

export async function handleSaleRowsRead(request: NextRequest, dependencies: PriceVersionsApiDependencies = defaultPriceVersionsApiDependencies): Promise<NextResponse> {
  const refused = await denied(request, dependencies, "prices.sale.read");
  if (refused) return refused;
  try {
    const repository = dependencies.repository();
    const { version, list } = await versionInNamespace(repository, request.nextUrl.searchParams.get("versionId"), SALE_KINDS);
    const [entries, surcharges] = await Promise.all([repository.listSaleEntries([version.id]), repository.listSurcharges([version.id])]);
    return NextResponse.json({ version, list, entries, surcharges });
  } catch (error) {
    return errorResponse(error, "Řádky ceníku se nepodařilo načíst.");
  }
}

export async function handleSaleRowsSave(request: NextRequest, dependencies: PriceVersionsApiDependencies = defaultPriceVersionsApiDependencies): Promise<NextResponse> {
  const refused = await denied(request, dependencies, "prices.sale.write");
  if (refused) return refused;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  try {
    const repository = dependencies.repository();
    const { version } = await versionInNamespace(repository, body.versionId, SALE_KINDS);
    const expected = expectedRevisionOf(body.expectedRevision);
    if (version.status !== "draft") return NextResponse.json({ error: "Publikovaná verze ceníku je neměnná. Pro opravu vytvořte novou verzi." }, { status: 409 });
    const stale = staleVersion(version, expected);
    if (stale) return stale;
    const entries = (Array.isArray(body.entries) ? body.entries : []).map(parseSaleEntryInput);
    const surcharges = (Array.isArray(body.surcharges) ? body.surcharges : []).map(parseSurchargeInput);
    if (duplicateRowKeys(entries).length) return NextResponse.json({ error: "Stejná položka (a varianta) je ve verzi dvakrát." }, { status: 422 });
    if (new Set(surcharges.map(surchargeKey)).size !== surcharges.length) return NextResponse.json({ error: "Stejný doplatek je ve verzi dvakrát." }, { status: 422 });
    const revision = await repository.replaceSaleRows(version.id, expected, entries, surcharges);
    return NextResponse.json({ ok: true, revision, entries: entries.length, surcharges: surcharges.length });
  } catch (error) {
    return errorResponse(error, "Řádky ceníku se nepodařilo uložit.");
  }
}

/**
 * Test resolution ("Zkušební výpočet") of one explicitly chosen price track: with an event, its CURRENT assignments (never its date);
 * without one, the explicitly chosen versions (drafts allowed, so a draft can be checked before it
 * is published). Sale prices only.
 */
export async function handleSaleResolve(request: NextRequest, dependencies: PriceVersionsApiDependencies = defaultPriceVersionsApiDependencies): Promise<NextResponse> {
  const refused = await denied(request, dependencies, "prices.sale.read");
  if (refused) return refused;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  // The price track is always chosen explicitly (CZK / EUR_SK / EUR_WORLD) — never derived from a
  // currency or the customer's country.
  const track = isPriceTrack(body.priceTrack) ? body.priceTrack : undefined;
  if (!track) return NextResponse.json({ error: "Zvolte cenový režim: CZK, EUR_SK nebo EUR_WORLD." }, { status: 400 });
  try {
    const repository = dependencies.repository();
    const eventId = text(body.eventId);
    let versionIds: Partial<Record<SalePriceListKind, string>> = {};
    if (eventId) {
      const assignments = await repository.listAssignments();
      versionIds = {
        base: currentEventAssignment(assignments, eventId, "base")?.priceListVersionId,
        electricity: currentEventAssignment(assignments, eventId, "electricity")?.priceListVersionId,
      };
    } else {
      versionIds = { base: text(body.baseVersionId), electricity: text(body.electricityVersionId) };
    }
    const book = async (versionId: string | undefined, kind: SalePriceListKind): Promise<SalePriceBook | undefined> => {
      if (!versionId) return undefined;
      const { version, list } = await versionInNamespace(repository, versionId, [kind]);
      const [entries, surcharges] = await Promise.all([repository.listSaleEntries([version.id]), repository.listSurcharges([version.id])]);
      return { list, version, entries, surcharges };
    };
    const [base, electricity, items] = await Promise.all([book(versionIds.base, "base"), book(versionIds.electricity, "electricity"), repository.listPricingItems()]);
    const categoryById = new Map(items.map((item) => [item.id, item.priceCategory]));
    // Swatch books resolve a variant's product line (variant row -> product line -> card row).
    const kitData = await dependencies.kitData();
    const seriesByVariant = new Map(kitData.variantSets.flatMap((set) => set.variants.flatMap((variant) => (variant.series ? [[variant.id, variant.series] as const] : []))));
    const context: VersionedPricingContext = { track, ...(base ? { base } : {}), ...(electricity ? { electricity } : {}), priceCategoryOf: (id) => categoryById.get(id), variantSeriesOf: (variantId) => seriesByVariant.get(variantId) };
    const requested = Array.isArray(body.items) ? body.items : [];
    const results = requested
      .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && typeof (entry as Record<string, unknown>).catalogItemId === "string")
      .slice(0, 200)
      .map((entry) => ({ catalogItemId: entry.catalogItemId as string, variantId: text(entry.variantId), result: resolveSalePrice(context, entry.catalogItemId as string, text(entry.variantId)) }));
    let kit;
    const kitItemId = text(body.kitItemId);
    if (kitItemId) {
      const selections = (Array.isArray(body.selections) ? body.selections : []).filter((selection): selection is KitLineSelection => Boolean(selection) && typeof (selection as KitLineSelection).lineKey === "string");
      kit = priceKitVersioned({ context, kitItemId, lines: kitData.packageItems.filter((line) => line.packageItemId === kitItemId), variantSets: kitData.variantSets, selections, agreementItemIds: new Set(kitData.agreementItemIds ?? []) });
    }
    return NextResponse.json({ track, currency: currencyOfTrack(track), versionIds, results, ...(kit ? { kit } : {}) });
  } catch (error) {
    return errorResponse(error, "Cenu se nepodařilo vypočítat.");
  }
}

// ============================================================================
// Purchase namespace
// ============================================================================

export async function handlePurchaseRegister(request: NextRequest, dependencies: PriceVersionsApiDependencies = defaultPriceVersionsApiDependencies): Promise<NextResponse> {
  const refused = await denied(request, dependencies, "prices.purchase.read");
  if (refused) return refused;
  try {
    const repository = dependencies.repository();
    const lists = await repository.listPriceLists(PURCHASE_KINDS);
    const [versions, links, companies, items] = await Promise.all([
      repository.listVersions(lists.map((list) => list.id)),
      repository.listPurchaseCompanies(),
      repository.listCompanies(),
      repository.listPricingItems(),
    ]);
    return NextResponse.json({ lists, versions, links, companies, items });
  } catch (error) {
    return errorResponse(error, "Nákupní ceníky se nepodařilo načíst.");
  }
}

export async function handlePurchaseAction(request: NextRequest, dependencies: PriceVersionsApiDependencies = defaultPriceVersionsApiDependencies): Promise<NextResponse> {
  const refused = await denied(request, dependencies, "prices.purchase.write");
  if (refused) return refused;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  try {
    const repository = dependencies.repository();
    if (body.action === "linkCompany") {
      const list = await listInNamespace(repository, body.priceListId, PURCHASE_KINDS);
      const companyId = text(body.realizationCompanyId);
      if (!companyId) return NextResponse.json({ error: "Chybí realizační firma." }, { status: 400 });
      await repository.linkPurchaseCompany(list.id, companyId, body.isActive !== false);
      return NextResponse.json({ ok: true });
    }
    return await handleVersionAction(repository, body, PURCHASE_KINDS);
  } catch (error) {
    return errorResponse(error, "Akci s nákupním ceníkem se nepodařilo provést.");
  }
}

export async function handlePurchaseRowsRead(request: NextRequest, dependencies: PriceVersionsApiDependencies = defaultPriceVersionsApiDependencies): Promise<NextResponse> {
  const refused = await denied(request, dependencies, "prices.purchase.read");
  if (refused) return refused;
  try {
    const repository = dependencies.repository();
    const { version, list } = await versionInNamespace(repository, request.nextUrl.searchParams.get("versionId"), PURCHASE_KINDS);
    return NextResponse.json({ version, list, entries: await repository.listPurchaseEntries([version.id]) });
  } catch (error) {
    return errorResponse(error, "Nákupní ceny se nepodařilo načíst.");
  }
}

export async function handlePurchaseRowsSave(request: NextRequest, dependencies: PriceVersionsApiDependencies = defaultPriceVersionsApiDependencies): Promise<NextResponse> {
  const refused = await denied(request, dependencies, "prices.purchase.write");
  if (refused) return refused;
  const body = await readJsonBody(request);
  if (body instanceof NextResponse) return body;
  try {
    const repository = dependencies.repository();
    const { version } = await versionInNamespace(repository, body.versionId, PURCHASE_KINDS);
    const expected = expectedRevisionOf(body.expectedRevision);
    if (version.status !== "draft") return NextResponse.json({ error: "Publikovaná verze ceníku je neměnná. Pro opravu vytvořte novou verzi." }, { status: 409 });
    const stale = staleVersion(version, expected);
    if (stale) return stale;
    const entries = (Array.isArray(body.entries) ? body.entries : []).map(parsePurchaseEntryInput);
    if (duplicateRowKeys(entries).length) return NextResponse.json({ error: "Stejná položka (a varianta) je ve verzi dvakrát." }, { status: 422 });
    const revision = await repository.replacePurchaseRows(version.id, expected, entries);
    return NextResponse.json({ ok: true, revision, entries: entries.length });
  } catch (error) {
    return errorResponse(error, "Nákupní ceny se nepodařilo uložit.");
  }
}
