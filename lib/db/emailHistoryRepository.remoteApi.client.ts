"use client";

import type { EmailHistoryEntry, EmailHistoryRepository, EmailHistorySaveInput } from "../../domain/emailHistory.ts";
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

/** Browser-side counterpart to lib/db/emailHistoryRepository.supabase.ts. */
export class RemoteApiEmailHistoryRepository implements EmailHistoryRepository {
  async list(): Promise<readonly EmailHistoryEntry[]> {
    const response = await fetch("/api/emails/history/list", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst historii e-mailů z databáze.");
    const body = (await response.json()) as { entries: readonly EmailHistoryEntry[] };
    return body.entries;
  }

  async create(input: EmailHistorySaveInput): Promise<EmailHistoryEntry> {
    const response = await fetch("/api/emails/history/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry: input }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Uložení do historie e-mailů selhalo.");
    const body = (await response.json()) as { entry: EmailHistoryEntry };
    return body.entry;
  }

  async update(id: string, input: EmailHistorySaveInput): Promise<EmailHistoryEntry> {
    const response = await fetch("/api/emails/history/update", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, entry: input }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Aktualizace historie e-mailů selhala.");
    const body = (await response.json()) as { entry: EmailHistoryEntry };
    return body.entry;
  }

  async delete(id: string): Promise<void> {
    const response = await fetch("/api/emails/history/delete", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Smazání záznamu historie selhalo.");
  }
}
