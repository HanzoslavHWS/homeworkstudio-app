/**
 * Realizační firma — the ONE register of real construction/print contractors (V1-DATA-02). The
 * physical table is still `print_surface_realization_companies` (decision A9: kept as the canonical
 * source because tasks, print-surface projects and settlement checks already reference it), exposed
 * in SQL through the neutral view `realization_companies`. Never referenced by name in logic; see
 * domain/printSurfaceProductionDimension.ts for how a company's ACTUAL production sizes are looked
 * up, and domain/realizationCompanyIdentity.ts for names, aliases and the old placeholder ids.
 *
 * Firms are never deleted (a DB trigger refuses it) — only deactivated. The id is stable: a slug
 * from the Excel header for imported firms, a slug from the working name for manually created ones,
 * and it never changes afterwards (also enforced by a trigger).
 */

/** `import` = created by the print-surface Excel sync, `manual` = created in Administrace → Realizační firmy. Only `import` firms can be deactivated by a sync. */
export type RealizationCompanySource = "import" | "manual";

export type RealizationCompanyContact = Readonly<{
  id: string;
  name?: string;
  role?: string;
  email?: string;
  phone?: string;
  note?: string;
}>;

export type RealizationCompany = Readonly<{
  id: string;
  /** Pracovní / zobrazovaný název — what every module shows. */
  name: string;
  /** Oficiální právní název (e.g. "CREATIV EXPO, s.r.o."). */
  legalName?: string;
  /** Název, pod kterým firmu vede ABRA. */
  abraName?: string;
  ico?: string;
  dic?: string;
  contacts?: readonly RealizationCompanyContact[];
  /** Interní poznámka. */
  note?: string;
  isActive: boolean;
  /** Absent on rows read from a database without the V1-DATA-02 migration — treat as `import`. */
  source?: RealizationCompanySource;
}>;

/** `alternative` = another current spelling (ABF "R:" text, vendor files), `historical` = a former name. */
export type RealizationCompanyAliasKind = "alternative" | "historical";
export const REALIZATION_COMPANY_ALIAS_KINDS: readonly RealizationCompanyAliasKind[] = ["alternative", "historical"];

export type RealizationCompanyAlias = Readonly<{
  id: string;
  realizationCompanyId: string;
  alias: string;
  /** normalizeCompanyName(alias) — unique among ACTIVE aliases across all firms (DB index). */
  normalizedAlias: string;
  kind: RealizationCompanyAliasKind;
  note?: string;
  isActive: boolean;
}>;

/**
 * Old realization identifiers that predate the register (`data/realizationProfiles.ts`,
 * `data/organizations.ts`), still stored in project documents, `productionProfiles` keys and legacy
 * price lists. Decision A2: none is mapped to a firm yet.
 *   - system_no_override: `default` — the system mode "no production-size override", NOT a firm.
 *   - unresolved: `realization-2..4` — placeholders whose real firm is unknown.
 *   - mapped: confirmed later by the user (one UPDATE, no migration).
 */
export type RealizationLegacyIdKind = "system_no_override" | "unresolved" | "mapped";
export const REALIZATION_LEGACY_ID_KINDS: readonly RealizationLegacyIdKind[] = ["system_no_override", "unresolved", "mapped"];

export type RealizationLegacyId = Readonly<{
  legacyId: string;
  kind: RealizationLegacyIdKind;
  realizationCompanyId?: string;
  evidence?: string;
  note?: string;
}>;

/** Read access every module needs (print surfaces, tasks, settlement, generator). */
export interface RealizationCompanyRepository {
  list(): Promise<readonly RealizationCompany[]>;
}

/** Fields a user edits on the firm card. `id` and `source` are never editable. */
export type RealizationCompanyCardInput = Readonly<{
  name: string;
  legalName?: string;
  abraName?: string;
  ico?: string;
  dic?: string;
  contacts?: readonly RealizationCompanyContact[];
  note?: string;
  isActive: boolean;
}>;

export type RealizationCompanyAliasInput = Readonly<{
  /** Present for an alias that already exists — absent for a new one. */
  id?: string;
  alias: string;
  kind: RealizationCompanyAliasKind;
  note?: string;
}>;

/** Administrace → Realizační firmy. No delete method on purpose. */
export interface RealizationCompanyAdminRepository extends RealizationCompanyRepository {
  listAliases(): Promise<readonly RealizationCompanyAlias[]>;
  listLegacyIds(): Promise<readonly RealizationLegacyId[]>;
  create(company: RealizationCompany): Promise<RealizationCompany>;
  update(company: RealizationCompany): Promise<RealizationCompany>;
  /** Inserts new aliases and deactivates the given ones — an alias row is never deleted. */
  saveAliases(changes: Readonly<{ insert: readonly Omit<RealizationCompanyAlias, "id">[]; deactivateIds: readonly string[] }>): Promise<void>;
}
