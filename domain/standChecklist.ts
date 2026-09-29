/**
 * Stand readiness checklist (Úkoly module). Configurable: items come from a TEMPLATE — the
 * event's own template when one exists, otherwise the global default — and only the per-stand
 * done/undone state is stored (stand_checklist_entries, keyed by event + normalized stand number,
 * the stand identity shared by all modules).
 */
import { normalizeStandNumber } from "./technicalStandNumber.ts";

export type ChecklistTemplateItem = Readonly<{ key: string; label: string }>;

export type StandChecklistTemplate = Readonly<{
  id: string;
  name: string;
  eventId?: string;
  isDefault: boolean;
  items: readonly ChecklistTemplateItem[];
}>;

export type StandChecklistEntry = Readonly<{
  eventId: string;
  standNumber: string;
  itemKey: string;
  isDone: boolean;
  doneAt?: string;
  doneBy?: string;
}>;

export type StandChecklistItem = ChecklistTemplateItem & Readonly<{ isDone: boolean; doneAt?: string; doneBy?: string }>;

export type StandChecklist = Readonly<{
  templateId: string;
  templateName: string;
  items: readonly StandChecklistItem[];
  doneCount: number;
  totalCount: number;
}>;

export type StandKey = Readonly<{ eventId: string; standNumber: string }>;

/** A stand can have a checklist only when both its event and stand number are known. */
export function resolveStandKey(eventId: string | undefined, standNumber: string | undefined): StandKey | undefined {
  const normalized = standNumber ? normalizeStandNumber(standNumber) : "";
  return eventId && normalized ? { eventId, standNumber: normalized } : undefined;
}

export function resolveChecklistTemplate(templates: readonly StandChecklistTemplate[], eventId: string | undefined): StandChecklistTemplate | undefined {
  return (eventId ? templates.find((template) => template.eventId === eventId) : undefined) ?? templates.find((template) => template.isDefault);
}

/** Template items in template order, with their stored state. Entries for keys no longer in the template are ignored. */
export function buildStandChecklist(template: StandChecklistTemplate, entries: readonly StandChecklistEntry[]): StandChecklist {
  const byKey = new Map(entries.map((entry) => [entry.itemKey, entry]));
  const items = template.items.map((item) => {
    const entry = byKey.get(item.key);
    return { ...item, isDone: entry?.isDone ?? false, doneAt: entry?.isDone ? entry.doneAt : undefined, doneBy: entry?.isDone ? entry.doneBy : undefined };
  });
  return { templateId: template.id, templateName: template.name, items, doneCount: items.filter((item) => item.isDone).length, totalCount: items.length };
}

/** Validates a template's items: non-empty unique keys and labels. */
export function validateChecklistItems(items: readonly ChecklistTemplateItem[]): string | undefined {
  const keys = new Set<string>();
  for (const item of items) {
    if (!item.key.trim() || !item.label.trim()) return "Každá položka checklistu potřebuje klíč i název.";
    if (keys.has(item.key)) return `Položka „${item.key}“ je v checklistu dvakrát.`;
    keys.add(item.key);
  }
  return undefined;
}

export interface StandChecklistRepository {
  listTemplates(): Promise<readonly StandChecklistTemplate[]>;
  listEntries(stand: StandKey): Promise<readonly StandChecklistEntry[]>;
  setEntry(stand: StandKey, itemKey: string, isDone: boolean, doneBy?: string): Promise<StandChecklistEntry>;
}
