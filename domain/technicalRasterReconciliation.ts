/**
 * Technické rastry — corrective batch section 8: reconciliation between the app's PRIMARY technical
 * reports (elektro/internet/voda/odpad/úklid, already modeled by `TechnicalService` in
 * domain/technicalRaster.ts) and a NEW, purely supplemental/control source — a catalog-style export
 * ("5. Stavby - tisk vše katalog") that may mention the SAME real-world facts in different words.
 *
 * Concept (spec: "ONE logical service + MULTIPLE source evidences"): this module never invents a
 * second parallel world of services. It only ever answers one question, per (stand, category) —
 * "do these two sources agree, and if not, how do they disagree" — and always resolves to exactly
 * one of five honest outcomes, never a guess:
 *
 *   - SHODA             both sources agree (same canonical variant, same quantity where tracked)
 *   - only_report       the primary technical report mentions it, the catalog doesn't
 *   - only_catalog      the catalog mentions it, no primary report does
 *   - quantity_mismatch both sources agree on WHICH service, but not HOW MANY
 *   - conflict          the two sources genuinely disagree about WHAT the stand has (a different
 *                       variant entirely — e.g. report "2 kW" vs catalog "5 kW" — or the catalog
 *                       explicitly NEGATES a category the report affirms, e.g. "BEZ ELEKTRICKÉ
 *                       ENERGIE") — never auto-resolved, always "Ke kontrole" for a human.
 *
 * Deduplication is NEVER exact-string (spec: "Deduplikace NESMÍ být pouze exact-string") — this
 * reuses domain/technicalRasterServicePresentation.ts's OWN real-label classification (the exact
 * same kW-extraction/refrigerated/fixed-IP/WIFI patterns already trusted for rendering) as the
 * canonical identity key, so "Do 2 kW 230V" and "ELEKTRICKÁ ENERGIE - PŘÍKON DO 2 kW/230" (spec's
 * own example pair) resolve to the SAME canonical variant ("2kW") without a second, parallel
 * classification system to keep in sync.
 *
 * This module is deliberately INPUT-AGNOSTIC: it takes already-parsed, plain "mentions" from either
 * source — it does not itself parse any PDF. See docs/technical-rasters.md's own "Deliberately not
 * done yet" for why the actual "5. Stavby - tisk vše katalog" TEXT parser is not implemented in this
 * batch (no real fixture file was available to build/verify it against, the same standard every
 * other parser in domain/technicalReportParsers/* was already held to).
 */
import { normalizeGenericServiceVariant, resolveServiceVariantId } from "./technicalRasterServicePresentation.ts";
import { normalizeStandNumber } from "./technicalStandNumber.ts";

/**
 * CORRECTIVE BATCH (3rd) section 14 — real case: stand 1B05, report says "Lednicový okruh", catalog
 * says the real (sometimes OCR-truncated) "ELEKTRICKÁ ENERGIE - NOČNÍ PROUD (LEDNI...)". For THIS
 * catalog's own vocabulary, "noční proud" IS the refrigerated-circuit variant — a RECONCILIATION-ONLY
 * alias, deliberately NOT part of the live presentation table (domain/technicalRasterServicePresentation.ts),
 * which also decides how a report's own label renders.
 */
function isAbfNightCurrentRefrigeratedCatalogLabel(externalLabel: string): boolean {
  return /nocni\s*proud/u.test(normalizeGenericServiceVariant(externalLabel));
}

/** Prefix of the catch-all variant id for electricity labels without a dedicated variant (the raw label follows the "|"). */
const UNRECOGNIZED_ELECTRICITY_VARIANT = "electricity:unrecognized";

export type TechnicalReconciliationSource = "report" | "catalog";

/**
 * One already-parsed mention of a service from either source, at the SAME level of detail this
 * app's own `TechnicalService` already carries (category + verbatim externalLabel + quantity) —
 * never pre-grouped, never pre-deduplicated by the caller.
 */
export type TechnicalReconciliationMention = Readonly<{
  standNumber: string;
  category: string;
  externalLabel: string;
  quantity: number;
  /**
   * True ONLY for a catalog mention that EXPLICITLY states the stand has NO such service at all
   * (spec's own example: "BEZ ELEKTRICKÉ ENERGIE") — never meaningful/set for a `source: "report"`
   * mention (a technical report never lists a service it doesn't provide). A negated mention still
   * carries a real `category` (which one is being negated) but its `externalLabel`/`quantity` are
   * purely informational and never used for variant matching.
   */
  negated?: boolean;
}>;

export type TechnicalReconciliationOutcome =
  | Readonly<{ status: "shoda"; standNumber: string; category: string; variant: string; quantity: number }>
  | Readonly<{ status: "only_report"; standNumber: string; category: string; variant: string; quantity: number }>
  | Readonly<{ status: "only_catalog"; standNumber: string; category: string; variant: string; quantity: number }>
  | Readonly<{ status: "quantity_mismatch"; standNumber: string; category: string; variant: string; reportQuantity: number; catalogQuantity: number }>
  | Readonly<{
    status: "conflict";
    standNumber: string;
    category: string;
    reason: "different_variant" | "catalog_negates_report";
    reportVariants: readonly string[];
    catalogVariants: readonly string[];
  }>;

/**
 * Canonical service variant for reconciliation (spec: "Canonical identity minimálně: standNumber,
 * service category, normalized variant") — the SAME variant table the live presentation uses
 * (resolveServiceVariantId), never a second parallel heuristic, plus the catalog-only "noční proud"
 * alias above. Deduplication is never exact-string: "Do 2 kW 230V" and "ELEKTRICKÁ ENERGIE - PŘÍKON
 * DO 2 kW/230" both resolve to "2kw", "denní úklid" and "úklid denní" both to "cleaning:daily".
 *
 * Every electricity label without a dedicated variant reconciles as ONE "electricity:unrecognized"
 * bucket (unchanged behavior) — only the re-import identity below keeps those labels apart.
 */
export function resolveCanonicalServiceVariant(category: string, externalLabel: string): string {
  if (category === "electricity" && isAbfNightCurrentRefrigeratedCatalogLabel(externalLabel)) return "refrigerated";
  const variant = resolveServiceVariantId(category, externalLabel);
  return variant.startsWith(`${UNRECOGNIZED_ELECTRICITY_VARIANT}|`) ? UNRECOGNIZED_ELECTRICITY_VARIANT : variant;
}

/**
 * Stable LOGICAL identity of one service row across re-imports of the same report type (used by
 * domain/technicalRaster.ts's incremental re-import): `<category>|<variant id>` — never a
 * database/random id, never the display label. The stand is part of the grouping at the call site.
 *
 * HOTFIX-02 — the variant table gives every approved service its own id, so services that used to
 * collide are now distinct: "Rozvaděč 9-21kW" ≠ "Do 21kW 400V", "Non stop" ≠ "Lednicový okruh",
 * "Osvětlení" ≠ "Vrchní přívod", "Router zapůjčení" ≠ "Internet". The identity is NEVER stored — it
 * is recomputed for the old AND the new service with this same function on every re-import, so an
 * older saved project needs no migration and keeps its placements (see
 * tests/technicalRasterServiceIdentity.test.ts). Ids that never collided are unchanged, e.g.
 * "electricity|3kw", "internet|wifi", "electricity|electricity:unrecognized|<label>".
 */
export function resolveServiceIdentityKey(category: string, externalLabel: string): string {
  return `${category}|${resolveServiceVariantId(category, externalLabel)}`;
}

type MentionGroup = Readonly<{ standNumber: string; category: string; report: readonly TechnicalReconciliationMention[]; catalog: readonly TechnicalReconciliationMention[] }>;

function groupKey(standNumber: string, category: string): string {
  return `${normalizeStandNumber(standNumber)}::${category}`;
}

/**
 * The ONE reconciliation entry point (spec section 8). Never throws, never drops a mention
 * silently — every mention in either input ends up reflected in exactly one outcome (a "shoda"/
 * "quantity_mismatch" outcome reflects one mention from EACH side; a "conflict" reflects every
 * variant seen on both sides for that stand/category; "only_report"/"only_catalog" each reflect
 * exactly one mention).
 */
export function reconcileTechnicalReportAndCatalog(
  reportMentions: readonly TechnicalReconciliationMention[],
  catalogMentions: readonly TechnicalReconciliationMention[],
): readonly TechnicalReconciliationOutcome[] {
  const groups = new Map<string, { standNumber: string; category: string; report: TechnicalReconciliationMention[]; catalog: TechnicalReconciliationMention[] }>();
  function bucket(mention: TechnicalReconciliationMention, source: TechnicalReconciliationSource) {
    const key = groupKey(mention.standNumber, mention.category);
    let group = groups.get(key);
    if (!group) { group = { standNumber: mention.standNumber, category: mention.category, report: [], catalog: [] }; groups.set(key, group); }
    (source === "report" ? group.report : group.catalog).push(mention);
  }
  for (const mention of reportMentions) bucket(mention, "report");
  for (const mention of catalogMentions) bucket(mention, "catalog");

  const outcomes: TechnicalReconciliationOutcome[] = [];
  for (const group of groups.values() as IterableIterator<MentionGroup>) {
    const catalogNegated = group.catalog.some((mention) => mention.negated);
    const reportAffirmed = group.report.length > 0;

    if (catalogNegated && reportAffirmed) {
      outcomes.push({
        status: "conflict",
        standNumber: group.standNumber,
        category: group.category,
        reason: "catalog_negates_report",
        reportVariants: dedupeVariants(group.report, group.category),
        catalogVariants: [],
      });
      continue;
    }
    if (catalogNegated && !reportAffirmed) {
      // Catalog explicitly says "none" and the report agrees by simply never mentioning it —
      // this is agreement, not a finding to review (spec never asks for a "SHODA: nic" row).
      continue;
    }

    const reportByVariant = groupByVariant(group.report, group.category);
    const catalogByVariant = groupByVariant(group.catalog.filter((mention) => !mention.negated), group.category);
    const allVariants = new Set([...reportByVariant.keys(), ...catalogByVariant.keys()]);
    const reportOnlyVariants: string[] = [];
    const catalogOnlyVariants: string[] = [];

    for (const variant of allVariants) {
      const reportMention = reportByVariant.get(variant);
      const catalogMention = catalogByVariant.get(variant);
      if (reportMention && catalogMention) {
        if (reportMention.quantity === catalogMention.quantity) {
          outcomes.push({ status: "shoda", standNumber: group.standNumber, category: group.category, variant, quantity: reportMention.quantity });
        } else {
          outcomes.push({
            status: "quantity_mismatch",
            standNumber: group.standNumber,
            category: group.category,
            variant,
            reportQuantity: reportMention.quantity,
            catalogQuantity: catalogMention.quantity,
          });
        }
      } else if (reportMention) {
        reportOnlyVariants.push(variant);
      } else if (catalogMention) {
        catalogOnlyVariants.push(variant);
      }
    }

    // A variant present on BOTH sides was already resolved above (shoda/quantity_mismatch) and
    // never reaches here. Reaching this point with SOMETHING on both the report-only and
    // catalog-only side (fully disjoint variant sets for the same stand+category) means the two
    // sources genuinely disagree about WHAT the stand has (spec's own "report = 2 kW, katalog =
    // 5 kW" example) — a real conflict, never silently reported as two unrelated "only" rows.
    if (reportOnlyVariants.length > 0 && catalogOnlyVariants.length > 0) {
      outcomes.push({
        status: "conflict",
        standNumber: group.standNumber,
        category: group.category,
        reason: "different_variant",
        reportVariants: reportOnlyVariants,
        catalogVariants: catalogOnlyVariants,
      });
      continue;
    }
    for (const variant of reportOnlyVariants) {
      const mention = reportByVariant.get(variant)!;
      outcomes.push({ status: "only_report", standNumber: group.standNumber, category: group.category, variant, quantity: mention.quantity });
    }
    for (const variant of catalogOnlyVariants) {
      const mention = catalogByVariant.get(variant)!;
      outcomes.push({ status: "only_catalog", standNumber: group.standNumber, category: group.category, variant, quantity: mention.quantity });
    }
  }
  return outcomes;
}

function groupByVariant(mentions: readonly TechnicalReconciliationMention[], category: string): Map<string, TechnicalReconciliationMention> {
  const map = new Map<string, TechnicalReconciliationMention>();
  for (const mention of mentions) {
    const variant = resolveCanonicalServiceVariant(category, mention.externalLabel);
    const existing = map.get(variant);
    // Multiple real rows for the SAME variant on the SAME side (e.g. two "Do 2kW" report rows for
    // one stand) are summed, never overwritten — quantity is a real, additive count.
    map.set(variant, existing ? { ...existing, quantity: existing.quantity + mention.quantity } : mention);
  }
  return map;
}

function dedupeVariants(mentions: readonly TechnicalReconciliationMention[], category: string): readonly string[] {
  return [...new Set(mentions.map((mention) => resolveCanonicalServiceVariant(category, mention.externalLabel)))];
}
