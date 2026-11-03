import { componentCatalogItems } from "../data/components.ts";
import { boothTypes } from "../data/booths.ts";
import { CLEANING_INTERNAL_CODES, ELECTRICITY_POWER_INTERNAL_CODES, GRAPHICS_INTERNAL_CODES } from "./technicalServices.ts";
import { TYPE_BOOTH_LINE_CODES } from "./typeBoothCanonicalization.ts";

/**
 * Changing the generator code (catalog_items.internal_code) of an EXISTING card. The code is a
 * stable identity: services are looked up by it (L02, U05, graphics …), the legacy generator's
 * static seeds and type booths carry it, and saved projects may store it (scene items, older
 * boothId values). References by the card's UUID (prices, aliases, kits, settlement) never
 * depend on it. A change is therefore allowed only when nothing that keys by the CODE uses it.
 */

const key = (code: string) => code.trim().toLocaleUpperCase("cs");

/** Codes the application itself keys by — never changeable from the card. */
export function systemGeneratorCodes(): ReadonlySet<string> {
  const codes = [
    ...componentCatalogItems.map((item) => item.internalCode),
    ...boothTypes.flatMap((booth) => [booth.internalCode, booth.code]),
    ...Object.values(CLEANING_INTERNAL_CODES),
    ...Object.values(GRAPHICS_INTERNAL_CODES),
    ...Object.values(ELECTRICITY_POWER_INTERNAL_CODES),
    ...TYPE_BOOTH_LINE_CODES,
  ].filter((code): code is string => typeof code === "string" && Boolean(code.trim()));
  return new Set(codes.map(key));
}

export function isSystemGeneratorCode(code: string): boolean {
  return systemGeneratorCodes().has(key(code));
}

/** True when any string value anywhere in a saved project document equals the code (conservative: any exact occurrence counts). */
export function documentReferencesCode(document: unknown, code: string): boolean {
  const wanted = key(code);
  const visit = (value: unknown): boolean => {
    if (typeof value === "string") return key(value) === wanted;
    if (Array.isArray(value)) return value.some(visit);
    if (value && typeof value === "object") return Object.values(value as Record<string, unknown>).some(visit);
    return false;
  };
  return visit(document);
}

/** Why the code cannot be changed, or undefined when the change is safe. */
export function internalCodeChangeIssue(input: Readonly<{ currentCode: string | null; from: string; to: string; referencingProjects: readonly string[] }>): string | undefined {
  if (!input.currentCode) return "Karta zatím nemá generátorový kód — kód se doplňuje, ne mění.";
  if (key(input.currentCode) !== key(input.from)) return "Generátorový kód se mezitím změnil. Načtěte kartu znovu.";
  if (isSystemGeneratorCode(input.from)) return `Kód „${input.from}“ používá aplikace (služby, typové stánky nebo starý generátor) — nelze ho změnit.`;
  if (input.referencingProjects.length) {
    const names = input.referencingProjects.slice(0, 5).join(", ");
    return `Kód „${input.from}“ používají uložené projekty (${names}${input.referencingProjects.length > 5 ? " …" : ""}). Změna by rozbila jejich vazby — kód zůstává.`;
  }
  return undefined;
}
