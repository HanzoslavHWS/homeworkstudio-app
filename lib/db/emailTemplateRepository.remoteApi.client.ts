"use client";

import type { EmailTemplate, EmailTemplateCreateInput, EmailTemplateEditInput, EmailTemplateRepository } from "../../domain/emailTemplate.ts";
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

/** Browser-side counterpart to lib/db/emailTemplateRepository.supabase.ts. */
export class RemoteApiEmailTemplateRepository implements EmailTemplateRepository {
  async list(): Promise<readonly EmailTemplate[]> {
    const response = await fetch("/api/emails/templates/list", { method: "GET", credentials: "same-origin" });
    if (!response.ok) await throwForFailedResponse(response, "Nepodařilo se načíst vzory e-mailů z databáze.");
    const body = (await response.json()) as { templates: readonly EmailTemplate[] };
    return body.templates;
  }

  async create(input: EmailTemplateCreateInput): Promise<EmailTemplate> {
    const response = await fetch("/api/emails/templates/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ template: input }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Uložení vzoru e-mailu selhalo.");
    const body = (await response.json()) as { template: EmailTemplate };
    return body.template;
  }

  async update(id: string, edit: EmailTemplateEditInput): Promise<EmailTemplate> {
    const response = await fetch("/api/emails/templates/save", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id, template: edit }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Úprava vzoru e-mailu selhala.");
    const body = (await response.json()) as { template: EmailTemplate };
    return body.template;
  }

  async delete(id: string): Promise<void> {
    const response = await fetch("/api/emails/templates/delete", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    if (!response.ok) await throwForFailedResponse(response, "Smazání vzoru e-mailu selhalo.");
  }
}
