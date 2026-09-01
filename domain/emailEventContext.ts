/**
 * E-maily v1.2 — event/veletrh context passed to the AI. Deliberately hand-enumerated (not a
 * Pick<Exhibition, ...>) — same discipline domain/visualizationAiPrompt.ts's CuratedAiSceneMetadata
 * already established: pricing, contact, internal notes and every other Exhibition field are
 * simply not fields this type can ever carry, regardless of how Exhibition grows later.
 */
import type { Exhibition } from "./organizations.ts";

export type EmailEventContext = Readonly<{
  id: string;
  name: string;
  dateFrom?: string;
  dateTo?: string;
  venue?: string;
}>;

/** Omits a field entirely when it's empty/missing rather than sending an empty string — the prompt builder must never have to guess whether "" means "known to be blank" or "unknown". */
export function buildEmailEventContext(event: Exhibition): EmailEventContext {
  return {
    id: event.id,
    name: event.name,
    dateFrom: event.eventFrom || undefined,
    dateTo: event.eventTo || undefined,
    venue: event.venue || undefined,
  };
}
