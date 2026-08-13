"use client";

import type { Exhibition } from "../../domain/organizations.ts";
import type { PersistedExhibition, RemoteEventRepository } from "../../domain/remotePersistence.ts";
import { ConcurrencyConflictError } from "./concurrency.ts";
import { RemoteApiUnavailableError } from "./projectRepository.remoteApi.client.ts";

async function throwForFailedResponse(response: Response, fallbackMessage: string): Promise<never> {
  let message = fallbackMessage;
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) message = body.error;
  } catch {
    // response body wasn't JSON — keep the fallback message
  }
  throw new RemoteApiUnavailableError(response.status, message);
}

/**
 * Browser-side counterpart to lib/db/eventRepository.supabase.ts — same rationale as
 * RemoteApiProjectRepository. R2 storageKeys travel inside the Exhibition document
 * untouched; presigned URLs are never part of what this persists.
 */
export class RemoteApiEventRepository implements RemoteEventRepository {
  async list(): Promise<readonly Exhibition[]> {
    const response = await fetch("/api/events/list", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst eventy z databáze.");
    const body = (await response.json()) as { events: readonly PersistedExhibition[] };
    return body.events;
  }

  async getWithRevision(id: string): Promise<PersistedExhibition | undefined> {
    const events = await this.list();
    return (events as readonly PersistedExhibition[]).find((event) => event.id === id);
  }

  /** Convenience path matching the plain EventRepository contract; prefer saveWithRevision when the caller already holds a known revision. */
  async save(event: Exhibition): Promise<Exhibition> {
    const existing = await this.getWithRevision(event.id);
    return this.saveWithRevision(event, existing?.revision ?? null);
  }

  async saveWithRevision(event: Exhibition, expectedRevision: number | null): Promise<PersistedExhibition> {
    const response = await fetch("/api/events/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event, expectedRevision }),
    });
    if (response.status === 409) throw new ConcurrencyConflictError("event", event.id);
    if (!response.ok) await throwForFailedResponse(response, "Uložení eventu do databáze selhalo.");
    const body = (await response.json()) as { event: PersistedExhibition };
    return body.event;
  }
}
