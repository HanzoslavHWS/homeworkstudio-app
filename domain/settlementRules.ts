/**
 * Kontrola vyúčtování — rules of a realization company (model + safe management only).
 *
 * Batch 1 stores every rule type but EVALUATES exactly one: `out_of_scope` ("this company never
 * bills this ABF item" — domain/settlementComparison.ts). The other types are the place future
 * unit conversions, merges and splits will live; until an engine exists for them they are inert,
 * and the UI says so.
 *
 * Safety model, enforced here and by the DB check constraint:
 *  - a rule is created as `draft`; nothing is ever created active;
 *  - `active` requires a named human verifier and a verification timestamp;
 *  - a rule must carry a plain-language explanation — that text is what the user is shown as the
 *    reason whenever the rule changes a result;
 *  - `origin = ai_suggestion` is reserved for a future AI proposer; such a rule is still a draft
 *    until a human activates it through the same path.
 */
import type { ComparisonOutOfScopeRule } from "./settlementComparison.ts";
import { normalizeSettlementText, SettlementValidationError, type SettlementOrigin } from "./settlementCheck.ts";

export const SETTLEMENT_RULE_TYPES = ["out_of_scope", "unit_conversion", "merge_abf_items", "split_vendor_item", "wall_booth_billing", "type_booth_exception", "custom"] as const;
export type SettlementRuleType = (typeof SETTLEMENT_RULE_TYPES)[number];

export const SETTLEMENT_RULE_TYPE_LABELS_CS: Readonly<Record<SettlementRuleType, string>> = {
  out_of_scope: "Položku realizačka neúčtuje (mimo rozsah)",
  unit_conversion: "Přepočet měrné jednotky",
  merge_abf_items: "Sloučení více položek ABF do jedné položky realizačky",
  split_vendor_item: "Rozdělení položky realizačky do více položek ABF",
  wall_booth_billing: "Účtování stěn a kójí",
  type_booth_exception: "Výjimka pro typové stánky",
  custom: "Jiné pravidlo",
};

/** Rule types the comparison engine actually applies today. */
export const SETTLEMENT_EVALUATED_RULE_TYPES: readonly SettlementRuleType[] = ["out_of_scope"];

export const SETTLEMENT_RULE_STATUSES = ["draft", "active", "disabled"] as const;
export type SettlementRuleStatus = (typeof SETTLEMENT_RULE_STATUSES)[number];

export const SETTLEMENT_RULE_STATUS_LABELS_CS: Readonly<Record<SettlementRuleStatus, string>> = {
  draft: "Návrh (neaktivní)",
  active: "Aktivní",
  disabled: "Vypnuto",
};

export type SettlementRule = Readonly<{
  id: string;
  realizationCompanyId: string;
  /** null = applies to every event of the company; set = an individual rule for one event. */
  eventId: string | null;
  ruleType: SettlementRuleType;
  name: string;
  explanation: string;
  definition: Readonly<Record<string, unknown>>;
  status: SettlementRuleStatus;
  origin: SettlementOrigin;
  verifiedAt: string | null;
  verifiedBy: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}>;

export type SettlementRuleInput = Readonly<{
  ruleType: SettlementRuleType;
  name: string;
  explanation: string;
  eventId?: string | null;
  definition?: Readonly<Record<string, unknown>>;
}>;

const NAME_MAX = 160;
const EXPLANATION_MIN = 10;
const EXPLANATION_MAX = 2000;
const DEFINITION_MAX_BYTES = 8000;

/** Whitelists and validates a raw request body. Never accepts a status, origin or verifier. */
export function parseSettlementRuleInput(raw: unknown): Required<SettlementRuleInput> {
  if (!raw || typeof raw !== "object") throw new SettlementValidationError("Chybí data pravidla.");
  const candidate = raw as Record<string, unknown>;
  if (typeof candidate.ruleType !== "string" || !(SETTLEMENT_RULE_TYPES as readonly string[]).includes(candidate.ruleType)) {
    throw new SettlementValidationError("Neplatný typ pravidla.");
  }
  const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
  if (!name) throw new SettlementValidationError("Pravidlo musí mít název.");
  if (name.length > NAME_MAX) throw new SettlementValidationError(`Název pravidla může mít nejvýše ${NAME_MAX} znaků.`);
  const explanation = typeof candidate.explanation === "string" ? candidate.explanation.trim() : "";
  if (explanation.length < EXPLANATION_MIN) throw new SettlementValidationError("Pravidlo musí mít srozumitelné vysvětlení (proč a jak se množství posuzuje).");
  if (explanation.length > EXPLANATION_MAX) throw new SettlementValidationError(`Vysvětlení může mít nejvýše ${EXPLANATION_MAX} znaků.`);
  const definition = candidate.definition === undefined || candidate.definition === null ? {} : candidate.definition;
  if (typeof definition !== "object" || Array.isArray(definition)) throw new SettlementValidationError("Definice pravidla musí být objekt.");
  if (JSON.stringify(definition).length > DEFINITION_MAX_BYTES) throw new SettlementValidationError("Definice pravidla je příliš velká.");
  const ruleType = candidate.ruleType as SettlementRuleType;

  let normalizedDefinition = definition as Record<string, unknown>;
  if (ruleType === "out_of_scope") {
    const catalogItemId = typeof normalizedDefinition.catalogItemId === "string" && normalizedDefinition.catalogItemId ? normalizedDefinition.catalogItemId : null;
    const abfName = typeof normalizedDefinition.abfName === "string" ? normalizedDefinition.abfName.trim() : "";
    if (!catalogItemId && !abfName) throw new SettlementValidationError("Pravidlo „mimo rozsah“ musí určit komponentu katalogu nebo název položky ABF.");
    normalizedDefinition = { ...(catalogItemId ? { catalogItemId } : {}), ...(abfName ? { abfName, abfNormalizedName: normalizeSettlementText(abfName) } : {}) };
  }

  return {
    ruleType,
    name,
    explanation,
    eventId: typeof candidate.eventId === "string" && candidate.eventId.trim() ? candidate.eventId.trim() : null,
    definition: normalizedDefinition,
  };
}

export type SettlementRuleStatusPatch = Readonly<{ status: SettlementRuleStatus; verifiedAt: string | null; verifiedBy: string | null }>;

/**
 * The only way a rule changes status. Activation always needs a named person; deactivation keeps
 * the verification record so the history of who approved it is not lost.
 */
export function planRuleStatusChange(rule: Pick<SettlementRule, "status" | "verifiedAt" | "verifiedBy">, nextStatus: unknown, actorName: string | undefined, now: string): SettlementRuleStatusPatch {
  if (typeof nextStatus !== "string" || !(SETTLEMENT_RULE_STATUSES as readonly string[]).includes(nextStatus)) {
    throw new SettlementValidationError("Neplatný stav pravidla.");
  }
  if (nextStatus === "active") {
    const verifier = actorName?.trim();
    if (!verifier) throw new SettlementValidationError("Pravidlo může aktivovat jen konkrétní osoba — vyplňte své jméno.");
    return { status: "active", verifiedAt: now, verifiedBy: verifier };
  }
  return { status: nextStatus as SettlementRuleStatus, verifiedAt: rule.verifiedAt, verifiedBy: rule.verifiedBy };
}

/** Active, verified `out_of_scope` rules that apply to this event — the only rules the engine receives. */
export function activeOutOfScopeRules(rules: readonly SettlementRule[], eventId: string): readonly ComparisonOutOfScopeRule[] {
  return rules
    .filter((rule) => rule.status === "active" && Boolean(rule.verifiedAt) && rule.ruleType === "out_of_scope" && (rule.eventId === null || rule.eventId === eventId))
    .map((rule) => ({
      id: rule.id,
      name: rule.name,
      catalogItemId: typeof rule.definition.catalogItemId === "string" ? rule.definition.catalogItemId : null,
      abfNormalizedName: typeof rule.definition.abfNormalizedName === "string" ? rule.definition.abfNormalizedName : null,
    }));
}
