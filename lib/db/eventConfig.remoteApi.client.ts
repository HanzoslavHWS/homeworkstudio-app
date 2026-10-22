"use client";

import type { EventPathMapping, EventRealizationLink, RealizationCompanyOption } from "../../domain/eventAdmin.ts";
import { RemoteApiUnavailableError } from "./projectRepository.remoteApi.client.ts";

export type EventConfigResponse = Readonly<{
  eventId: string;
  configRevision: number;
  realizationLinks: readonly EventRealizationLink[];
  pathMappings: readonly EventPathMapping[];
  companies: readonly RealizationCompanyOption[];
}>;

/** The event changed elsewhere since it was loaded; nothing was saved. */
export class EventConfigConflictClientError extends RemoteApiUnavailableError {
  constructor(message: string) {
    super(409, message);
    this.name = "EventConfigConflictClientError";
  }
}

/** The event is not stored yet (new card): its sections can be edited after the first save. */
export class EventNotSavedClientError extends RemoteApiUnavailableError {
  constructor(message: string) {
    super(404, message);
    this.name = "EventNotSavedClientError";
  }
}

async function readJson<T>(response: Response, fallback: string): Promise<T> {
  if (response.ok) return (await response.json()) as T;
  let body: { error?: string; conflict?: boolean; notSaved?: boolean } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // not JSON — keep the fallback
  }
  const message = body.error ?? fallback;
  if (body.conflict) throw new EventConfigConflictClientError(message);
  if (response.status === 404) throw new EventNotSavedClientError(message);
  throw new RemoteApiUnavailableError(response.status, message);
}

const post = <T>(body: unknown, fallback: string) =>
  fetch("/api/events/config", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).then((response) => readJson<T>(response, fallback));

/** Administrace → Výstavy / eventy: one list of realization firms and folder paths (app/api/events/config). */
export const eventConfigApi = {
  load: (eventId: string) =>
    fetch(`/api/events/config?eventId=${encodeURIComponent(eventId)}`, { method: "GET", credentials: "same-origin" }).then((response) => readJson<EventConfigResponse>(response, "Nastavení veletrhu se nepodařilo načíst.")),
  saveRealization: (eventId: string, expectedConfigRevision: number, links: readonly EventRealizationLink[]) =>
    post<{ ok: true; configRevision: number; warnings: readonly string[] }>({ action: "saveRealization", eventId, expectedConfigRevision, links }, "Realizační firmy se nepodařilo uložit."),
  savePaths: (eventId: string, expectedConfigRevision: number, paths: readonly EventPathMapping[]) =>
    post<{ ok: true; configRevision: number; paths: readonly EventPathMapping[] }>({ action: "savePaths", eventId, expectedConfigRevision, paths }, "Cesty se nepodařilo uložit."),
};
