/**
 * V1-COMPLETE-02: P86 "Kóje 2 × 2 m" — the built-in booth (data/booths.ts, koje-2x2) moved into the
 * catalog as ONE BOOTH card, and nothing else. Pure plan; the writer is lib/db/p86Catalog.supabase.ts.
 *
 * Existence is decided by the established planP86Canonical (domain/importBatch2b.ts) plus a code
 * check: any card already using P86 as its internal or ABF code means "no insert". The card keeps
 * the canonical BoothType document unchanged (GLB, dimensions, print surfaces, camera views, legacy
 * packageContents and base price the current generator still reads); only the lifecycle differs
 * from Batch #2B — it lands as "K doplnění" for the user to review, never active, no reviewedAt.
 *
 * Commercial content (V1-DATA-04 kit lines), confirmed by the user: the construction IS the card
 * (no "Stavba stánku" line), M01 4 m² included with the SERBUS swatch book (default PLAT 020; M04
 * by agreement in any colour, no surcharge), M91 2 bm included with the matching fascia print
 * allowance. Lines are only planned for a P86 that has no lines yet — manual edits are never
 * overwritten. Prices are never part of this plan.
 */
import { BATCH2B_SOURCE_SYSTEM, planP86Canonical } from "./importBatch2b.ts";
import type { CatalogItemAdmin } from "./catalogItemsAdmin.ts";
import type { CatalogPackageItemInput } from "./catalogPackages.ts";
import type { CatalogVariantSet } from "./catalogVariants.ts";
import type { BoothType } from "./models.ts";

export const P86_CODE = "P86";
export const P86_CATEGORY = "Canonical";

export type P86CardPlan =
  | Readonly<{ action: "create"; row: Readonly<Record<string, unknown>> }>
  | Readonly<{ action: "keep"; itemId: string; reason: string }>
  | Readonly<{ action: "conflict"; reason: string }>;

export type P86LinesPlan =
  | Readonly<{ action: "create"; lines: readonly CatalogPackageItemInput[] }>
  | Readonly<{ action: "keep"; reason: string }>
  | Readonly<{ action: "blocked"; reason: string }>;

/** The insert row: canonical document as is (minus lifecycle/review bookkeeping), real codes and type. */
export function buildP86Row(seed: BoothType, sourceKey: string): Readonly<Record<string, unknown>> {
  const { lifecycleStatus: _lifecycle, reviewedAt: _reviewed, ...document } = seed as BoothType & { lifecycleStatus?: unknown; reviewedAt?: unknown };
  return {
    internal_code: P86_CODE,
    abf_code: P86_CODE,
    item_type: "BOOTH",
    kind: "booth",
    lifecycle_status: "needs_review",
    display_name: seed.name,
    official_name: null,
    category: P86_CATEGORY,
    unit: "ks",
    unit_code: "ks",
    document: { ...document, sourceSystem: BATCH2B_SOURCE_SYSTEM, sourceKey },
  };
}

export function planP86Card(seed: BoothType, items: readonly CatalogItemAdmin[]): P86CardPlan {
  const holders = items.filter((item) => item.internalCode?.toUpperCase() === P86_CODE || item.abfCode?.toUpperCase() === P86_CODE);
  if (holders.length > 1) return { action: "conflict", reason: `Kód P86 používá ${holders.length} karet — nic se nezapíše.` };
  const holder = holders[0];
  if (holder) {
    return holder.kind === "booth"
      ? { action: "keep", itemId: holder.id, reason: `P86 už v katalogu je (${holder.id}) — beze změny.` }
      : { action: "conflict", reason: `Kód P86 má karta „${holder.displayName}“ druhu ${holder.kind} — nic se nezapíše.` };
  }
  const existing = items.map((item) => ({ id: item.id, internalCode: item.internalCode ?? undefined, kind: item.kind, sourceSystem: typeof item.document.sourceSystem === "string" ? item.document.sourceSystem : undefined, sourceKey: typeof item.document.sourceKey === "string" ? item.document.sourceKey : undefined }));
  const canonical = planP86Canonical(seed, existing);
  if (canonical.action !== "insert") return { action: "conflict", reason: `Kanonický plán P86 nepovolil vložení (${canonical.reasons.at(-1) ?? canonical.action}).` };
  return { action: "create", row: buildP86Row(seed, canonical.sourceKey) };
}

/** The confirmed commercial content of P86 as kit lines. */
export function p86KitLines(ids: Readonly<{ m01: string; m91: string; m04: string; variantSetId: string; baseVariantId: string }>): readonly CatalogPackageItemInput[] {
  return [
    {
      lineKey: "koberec",
      lineKind: "item",
      childItemId: ids.m01,
      quantity: 4,
      unitCode: "m2",
      includedInPackage: true,
      variantSetId: ids.variantSetId,
      defaultVariantId: ids.baseVariantId,
      note: "Šedý koberec PODIUM / PLAT 020 v ceně. Jiná barva: příplatek podle řady (M02). M04 jen na základě dohody s PVA.",
      substitutes: [{ substituteItemId: ids.m04, surchargeRule: "none", quantityFactor: 1, isActive: true, note: "Koberec PVA — libovolná barva vzorníku, jen s uvedeným důvodem; cena kompletu se nemění." }],
    },
    {
      lineKey: "grafika-limec",
      lineKind: "item",
      childItemId: ids.m91,
      quantity: 2,
      unitCode: "bm",
      includedInPackage: true,
      printAllowance: [{ surfaceTypeId: "fascia", unitCode: "bm", includedQuantity: 2 }],
      note: "Grafika límce 2 bm v ceně.",
    },
  ];
}

export function planP86Lines(input: Readonly<{ p86Id: string | undefined; items: readonly CatalogItemAdmin[]; variantSets: readonly CatalogVariantSet[] }>): P86LinesPlan {
  if (!input.p86Id) return { action: "blocked", reason: "karta P86 zatím není" };
  const p86 = input.items.find((item) => item.id === input.p86Id);
  if ((p86?.packageItems ?? []).length > 0) return { action: "keep", reason: `P86 už má ${p86!.packageItems!.length} řádků obsahu — nepřepisuje se.` };
  const byCode = (code: string) => input.items.filter((item) => item.abfCode === code || item.internalCode === code);
  const missing: string[] = [];
  const one = (code: string, kind: string) => {
    const found = byCode(code).filter((item) => item.kind === kind);
    if (found.length !== 1) missing.push(`${code} (${kind}) — nalezeno ${found.length}`);
    return found[0]?.id;
  };
  const m01 = one("M01", "floor_finish");
  const m04 = one("M04", "floor_finish");
  const m91 = one("M91", "graphics_service");
  const set = input.variantSets.find((candidate) => candidate.code === "KOBERCE-SERBUS");
  const base = set?.variants.find((variant) => variant.code === "PODIUM-PLAT-020");
  if (!set || !base) missing.push("vzorník KOBERCE-SERBUS s PODIUM-PLAT-020");
  if (missing.length || !m01 || !m04 || !m91 || !set || !base) return { action: "blocked", reason: `chybí ${missing.join(", ")}` };
  return { action: "create", lines: p86KitLines({ m01, m91, m04, variantSetId: set.id, baseVariantId: base.id }) };
}
