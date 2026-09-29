/**
 * Úkoly — calendar model: event MILESTONES and month/week/day grids.
 *
 * Milestones are DERIVED from the existing events (domain/organizations.ts Exhibition: assembly,
 * event from/to, disassembly, the two built-in deadlines and the free-form deadlines[]) — never
 * stored a second time, so editing an event's dates in "Výstavy / eventy" moves them here too.
 */
import type { Exhibition } from "./organizations.ts";
import { addDays, isIsoDate, startOfWeek, type Task } from "./tasks.ts";

export type EventMilestoneKind = "assembly" | "eventStart" | "eventEnd" | "disassembly" | "materialDeadline" | "designDeadline" | "deadline";

export type EventMilestone = Readonly<{
  id: string;
  eventId: string;
  eventName: string;
  date: string;
  kind: EventMilestoneKind;
  label: string;
}>;

type EventLike = Pick<Exhibition, "id" | "name" | "assemblyDate" | "eventFrom" | "eventTo" | "disassemblyDate" | "materialDataDeadline" | "designApprovalDeadline" | "deadlines">;

export function deriveEventMilestones(event: EventLike): readonly EventMilestone[] {
  const milestones: EventMilestone[] = [];
  const add = (kind: EventMilestoneKind, date: string | undefined, label: string, suffix: string = kind) => {
    if (isIsoDate(date)) milestones.push({ id: `${event.id}:${suffix}`, eventId: event.id, eventName: event.name, date, kind, label });
  };
  add("assembly", event.assemblyDate, "Začátek montáže");
  add("eventStart", event.eventFrom, "Začátek veletrhu");
  add("eventEnd", event.eventTo, "Konec veletrhu");
  add("disassembly", event.disassemblyDate, "Demontáž");
  add("materialDeadline", event.materialDataDeadline, "Deadline dodání materiálů / dat");
  add("designDeadline", event.designApprovalDeadline, "Deadline odsouhlasení návrhu stavby");
  for (const deadline of event.deadlines ?? []) add("deadline", deadline.date, deadline.name.trim() || "Deadline", `deadline:${deadline.id}`);
  return milestones.sort((a, b) => a.date.localeCompare(b.date));
}

export function deriveAllMilestones(events: readonly EventLike[]): readonly EventMilestone[] {
  return events.flatMap(deriveEventMilestones).sort((a, b) => a.date.localeCompare(b.date));
}

export type CalendarMode = "month" | "week" | "day";

/** Monday-first weeks covering the whole month (5–6 rows of 7 ISO dates). */
export function buildMonthGrid(year: number, month: number): readonly (readonly string[])[] {
  const first = `${year}-${String(month).padStart(2, "0")}-01`;
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = `${year}-${String(month).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
  const weeks: string[][] = [];
  let cursor = startOfWeek(first);
  while (cursor <= last) {
    weeks.push(Array.from({ length: 7 }, (_, index) => addDays(cursor, index)));
    cursor = addDays(cursor, 7);
  }
  return weeks;
}

export function buildWeekDays(anyDayInWeek: string): readonly string[] {
  const monday = startOfWeek(anyDayInWeek);
  return Array.from({ length: 7 }, (_, index) => addDays(monday, index));
}

/** Moves the calendar's anchor date by one month/week/day. */
export function shiftCalendarAnchor(anchor: string, mode: CalendarMode, direction: 1 | -1): string {
  if (mode === "day") return addDays(anchor, direction);
  if (mode === "week") return addDays(anchor, 7 * direction);
  const [year, month] = anchor.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1 + direction, 1));
  return date.toISOString().slice(0, 10);
}

export const CZECH_MONTHS = ["leden", "únor", "březen", "duben", "květen", "červen", "červenec", "srpen", "září", "říjen", "listopad", "prosinec"] as const;
export const CZECH_WEEKDAYS_SHORT = ["Po", "Út", "St", "Čt", "Pá", "So", "Ne"] as const;

export type CalendarDay = Readonly<{ tasks: readonly Task[]; milestones: readonly EventMilestone[] }>;

/** Tasks (with a due date) and milestones grouped by ISO date; tasks inside a day are ordered by time, then title. */
export function groupCalendarItems(tasks: readonly Task[], milestones: readonly EventMilestone[]): ReadonlyMap<string, CalendarDay> {
  const map = new Map<string, { tasks: Task[]; milestones: EventMilestone[] }>();
  const day = (date: string) => {
    let entry = map.get(date);
    if (!entry) { entry = { tasks: [], milestones: [] }; map.set(date, entry); }
    return entry;
  };
  for (const task of tasks) if (task.dueDate) day(task.dueDate).tasks.push(task);
  for (const milestone of milestones) day(milestone.date).milestones.push(milestone);
  for (const entry of map.values()) entry.tasks.sort((a, b) => (a.dueTime ?? "99:99").localeCompare(b.dueTime ?? "99:99") || a.title.localeCompare(b.title, "cs"));
  return map;
}
