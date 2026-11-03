/**
 * "Parametry komponenty" (V1-CATALOG). One section on the card, two kinds of parameters:
 *
 *   A. SYSTEM parameters — bound to existing structured fields the generator and other modules read:
 *      Šířka / Hloubka / Výška (widthMm/depthMm/heightMm), Barva / Materiál (attributes.color/material),
 *      Výkon kW (serviceTechnical.powerKw). Never re-mapped, never stored a second time as free text.
 *   B. RECOMMENDED parameters — defined per category in the category administration (name, value
 *      type, optional unit, order, active). Their values are stored in the card's EXISTING generic
 *      parameter list (attributes.extra; for services serviceTechnical.parameters) under the
 *      parameter's key — no new storage. Always optional in V1.0.
 *
 * Plus any number of the user's own parameters in the same list. A template change never rewrites
 * cards: a value whose template was renamed or deactivated simply stays as the card's own parameter.
 */

export type ParameterValueType = "text" | "number";

export type RecommendedParameter = Readonly<{
  /** Stable id within the category. */
  id: string;
  name: string;
  valueType: ParameterValueType;
  unit?: string;
  sortOrder: number;
  isActive: boolean;
}>;

export type ParameterEntry = Readonly<{ key: string; value: string }>;

const normalize = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/gu, "").trim().toLowerCase().replace(/\s+/gu, " ");

/** Names reserved by system parameters (with or without a unit in brackets) — a recommended or own parameter can never duplicate them. */
const SYSTEM_PARAMETER_NAMES = ["sirka", "hloubka", "vyska", "rozmery", "vykon", "barva", "material"];

export function isSystemParameterName(name: string): boolean {
  const base = normalize(name).replace(/\s*\(.*\)$/u, "").replace(/\s*\[.*\]$/u, "").trim();
  return SYSTEM_PARAMETER_NAMES.includes(base);
}

/** The key a recommended parameter's value is stored under: "Rychlost připojení (Mb/s)" — the unit stays readable wherever the list is shown (customer catalog too). */
export function recommendedParameterKey(parameter: Pick<RecommendedParameter, "name" | "unit">): string {
  return parameter.unit ? `${parameter.name} (${parameter.unit})` : parameter.name;
}

export function activeRecommendedParameters(parameters: readonly RecommendedParameter[] | undefined): readonly RecommendedParameter[] {
  return (parameters ?? []).filter((parameter) => parameter.isActive).slice().sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name, "cs"));
}

/**
 * Splits the card's stored list into values of the category's ACTIVE recommended parameters and the
 * card's own parameters (everything else — including values of deactivated or renamed templates,
 * which therefore stay visible and editable).
 */
export function splitParameters(entries: readonly ParameterEntry[], recommended: readonly RecommendedParameter[]): Readonly<{ recommended: readonly Readonly<{ parameter: RecommendedParameter; value: string }>[]; own: readonly ParameterEntry[] }> {
  const active = activeRecommendedParameters(recommended);
  const keys = new Set(active.map(recommendedParameterKey));
  return {
    recommended: active.map((parameter) => ({ parameter, value: entries.find((entry) => entry.key === recommendedParameterKey(parameter))?.value ?? "" })),
    own: entries.filter((entry) => !keys.has(entry.key)),
  };
}

/** Back into ONE list: filled recommended values (in template order), then own parameters. Empty values are not stored. */
export function mergeParameters(recommended: readonly Readonly<{ parameter: RecommendedParameter; value: string }>[], own: readonly ParameterEntry[]): readonly ParameterEntry[] {
  return [
    ...recommended.filter((row) => row.value.trim()).map((row) => ({ key: recommendedParameterKey(row.parameter), value: row.value.trim() })),
    ...own.map((entry) => ({ key: entry.key.trim(), value: entry.value.trim() })).filter((entry) => entry.key),
  ];
}

export function parseNumberText(text: string): number | undefined {
  const value = Number(text.trim().replace(/\s/gu, "").replace(",", "."));
  return text.trim() && Number.isFinite(value) ? value : undefined;
}

/** First problem of the form's parameters, or undefined. An empty optional value never blocks saving. */
export function parameterProblem(input: Readonly<{ recommended: readonly Readonly<{ parameter: RecommendedParameter; value: string }>[]; own: readonly ParameterEntry[]; dimensions?: readonly Readonly<{ label: string; value: string }>[] }>): string | undefined {
  for (const dimension of input.dimensions ?? []) {
    if (dimension.value.trim() && !(parseNumberText(dimension.value)! >= 0)) return `${dimension.label} musí být nezáporné číslo v mm.`;
  }
  for (const row of input.recommended) {
    if (row.parameter.valueType === "number" && row.value.trim() && parseNumberText(row.value) === undefined) return `Parametr „${row.parameter.name}“ musí být číslo.`;
  }
  const seen = new Set<string>();
  for (const entry of input.own) {
    if (!entry.key.trim()) continue;
    if (isSystemParameterName(entry.key)) return `Parametr „${entry.key.trim()}“ je systémový údaj — vyplňte ho v jeho vlastním poli, ne jako vlastní parametr.`;
    const key = normalize(entry.key);
    if (seen.has(key)) return `Parametr „${entry.key.trim()}“ je uvedený dvakrát.`;
    seen.add(key);
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Category administration
// ---------------------------------------------------------------------------------------------

const MAX_RECOMMENDED = 30;

/** Validates a category's recommended parameter list (administration input). Throws a message string. */
export function parseRecommendedParameters(raw: unknown): readonly RecommendedParameter[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error("Doporučené parametry musí být seznam.");
  const result: RecommendedParameter[] = [];
  for (const [index, value] of raw.slice(0, MAX_RECOMMENDED).entries()) {
    if (!value || typeof value !== "object") continue;
    const candidate = value as Record<string, unknown>;
    const name = typeof candidate.name === "string" ? candidate.name.trim() : "";
    if (!name) continue;
    if (name.length > 60) throw new Error(`Název parametru „${name.slice(0, 20)}…“ je delší než 60 znaků.`);
    if (isSystemParameterName(name)) throw new Error(`„${name}“ je systémový parametr (rozměry, barva, materiál, výkon) — má vlastní strukturované pole a nelze ho přidat jako doporučený parametr.`);
    const unit = typeof candidate.unit === "string" && candidate.unit.trim() ? candidate.unit.trim().slice(0, 20) : undefined;
    const id = typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim().slice(0, 64) : `param-${normalize(name).replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || index + 1}`;
    result.push({
      id,
      name,
      valueType: candidate.valueType === "number" ? "number" : "text",
      ...(unit ? { unit } : {}),
      sortOrder: typeof candidate.sortOrder === "number" && Number.isFinite(candidate.sortOrder) ? Math.round(candidate.sortOrder) : (index + 1) * 10,
      isActive: candidate.isActive !== false,
    });
  }
  const names = new Set<string>();
  const ids = new Set<string>();
  for (const parameter of result) {
    const key = normalize(recommendedParameterKey(parameter));
    if (names.has(key)) throw new Error(`Doporučený parametr „${parameter.name}“ je v kategorii dvakrát.`);
    if (ids.has(parameter.id)) throw new Error(`Identifikátor parametru „${parameter.id}“ je v kategorii dvakrát.`);
    names.add(key);
    ids.add(parameter.id);
  }
  return result;
}

/** Sets one stored value by key (empty = removed). The raw list keeps the rows the user is still typing. */
export function setParameterValue(entries: readonly ParameterEntry[], key: string, value: string): readonly ParameterEntry[] {
  if (!value.trim()) return entries.filter((entry) => entry.key !== key);
  return entries.some((entry) => entry.key === key) ? entries.map((entry) => (entry.key === key ? { ...entry, value } : entry)) : [...entries, { key, value }];
}
