/**
 * E-maily — pure prompt-building for the AI email assistant. No fetch, no THREE/DOM, mirrors
 * domain/visualizationAiPrompt.ts's separation of prompt engineering from the provider/API-route
 * layers. The single non-negotiable rule threaded through every prompt built here: the model may
 * never invent facts, dates, prices, names, or any other business/technical detail that is not
 * present in the user's own text, the selected event context, the recipient context, or the
 * template instruction — it rewrites/translates/edits, it does not author new content.
 */
import type { EmailAiTone } from "./emailAiConfig.ts";
import type { EmailEventContext } from "./emailEventContext.ts";

const NO_FABRICATION_RULE =
  "Never invent or add facts that are not explicitly present in the provided text/context: prices, " +
  "dates, deadlines, quantities, names, surnames, companies, phone numbers, email addresses, order " +
  "numbers, technical information, ordered services, dimensions, customer commitments, or any other " +
  "business or technical detail. Preserve the original meaning and every given detail exactly. If the " +
  "source text is vague or incomplete, keep the result equally vague rather than filling in specifics.";

const JSON_OUTPUT_RULE =
  'Respond with ONLY a JSON object of the exact shape {"subject": string, "body": string} — no ' +
  "markdown, no code fences, no extra commentary before or after the JSON.";

export type EmailAiGenerationPromptInput = Readonly<{
  freeText: string;
  promptLanguage: string;
  tone: EmailAiTone;
  /** Optional AI instruction carried by a saved template (domain/emailTemplate.ts), e.g. "always ask for a delivery address". */
  templateInstruction?: string;
  /** Optional selected event/veletrh (domain/emailEventContext.ts) — only these exact fields are ever visible to the model. */
  eventContext?: EmailEventContext;
  /** Optional free-text form of address, e.g. "Anna" / "paní Nováková" / "Mr Smith" — used verbatim, never expanded. */
  recipientName?: string;
  /**
   * Additional structured facts the model MAY reference for grounding (e.g. print-surfaces' own
   * per-surface list — label/type/dimension/quantity, see domain/printSurfaceEmailContext.ts) but
   * must NOT proactively dump into the email body — a short summary referencing the attachment is
   * preferred by default; the itemized list only belongs in the body if the user's own freeText
   * explicitly asks for one. Kept generic (plain strings) so any future caller can reuse this same
   * mechanism without this module knowing their domain shape.
   */
  additionalContext?: readonly string[];
}>;

export type EmailAiPrompt = Readonly<{ system: string; user: string }>;

function eventContextLine(event: EmailEventContext): string {
  const parts = [`name "${event.name}"`];
  if (event.dateFrom || event.dateTo) parts.push(`dates ${event.dateFrom ?? "?"} to ${event.dateTo ?? "?"}`);
  if (event.venue) parts.push(`venue "${event.venue}"`);
  return `EVENT CONTEXT: This email relates to the following event — ${parts.join(", ")}. Use ONLY these exact facts about the event; never invent or add any other event detail (no additional dates, location details, or descriptions).`;
}

function recipientContextLine(recipientName: string, promptLanguage: string): string {
  return (
    `RECIPIENT CONTEXT: Address the recipient using exactly this given form of address: "${recipientName}". ` +
    `Use it to form a natural, appropriately localized greeting for ${promptLanguage} (e.g. a title-less first ` +
    `name gets an informal greeting, "paní/pan <surname>" or "Mr/Mrs <surname>" gets a formal one). Never invent ` +
    "a surname, title, gender, job position, or company beyond exactly what was given here."
  );
}

const NO_RECIPIENT_LINE =
  "RECIPIENT CONTEXT: No recipient name was given — use a neutral, professional greeting with no name (e.g. " +
  '"Dobrý den," / "Hello,"), never invent one.';

function additionalContextLines(facts: readonly string[]): string {
  return [
    "ADDITIONAL AVAILABLE FACTS (for grounding only): the following facts are accurate and available to you, " +
      "but do NOT list them out item-by-item in the email body by default — refer to them briefly/collectively " +
      "(e.g. \"the attached overview\") unless the user's own text explicitly asks for an itemized list:",
    ...facts.map((fact) => `- ${fact}`),
  ].join("\n");
}

/**
 * Handles both same-language rewriting AND cross-language "translation" in one instruction set:
 * when the source text isn't already in promptLanguage, the result must read as a natural,
 * professional email written by a native speaker — never a literal, word-for-word translation.
 *
 * The user message stays the raw freeText, unchanged — event/recipient/template context are
 * instructions about HOW to write the email, so they live in the system prompt, clearly labeled,
 * never mixed into what the user actually typed.
 */
export function buildEmailGenerationPrompt(input: EmailAiGenerationPromptInput): EmailAiPrompt {
  const system = [
    `You turn a rough, informal note written by a business user into a polished, professional email written in ${input.promptLanguage}.`,
    `If the source text is not already in ${input.promptLanguage}, produce a natural, professional email in ${input.promptLanguage} with the same meaning — never a literal, word-for-word translation.`,
    input.tone.instructionHint,
    input.templateInstruction ? `Additional instruction for this type of email: ${input.templateInstruction}` : undefined,
    input.eventContext ? eventContextLine(input.eventContext) : undefined,
    input.recipientName ? recipientContextLine(input.recipientName, input.promptLanguage) : NO_RECIPIENT_LINE,
    input.additionalContext && input.additionalContext.length > 0 ? additionalContextLines(input.additionalContext) : undefined,
    NO_FABRICATION_RULE,
    "Produce a complete, ready-to-send email: a concise, relevant subject line, and a body with an appropriate greeting and sign-off matching the requested tone.",
    JSON_OUTPUT_RULE,
  ].filter(Boolean).join("\n");

  return { system, user: input.freeText };
}

export type EmailAiRewritePromptInput = Readonly<{
  currentSubject: string;
  currentBody: string;
  actionInstruction: string;
  promptLanguage: string;
}>;

/**
 * Operates on the CURRENT result (subject+body), never re-derives from the original free text or
 * event/recipient context — callers (the API route) are responsible for always passing the latest
 * edited state (section 19: rewrite works on the current result, never re-injects new context).
 */
export function buildEmailRewritePrompt(input: EmailAiRewritePromptInput): EmailAiPrompt {
  const system = [
    `You edit an already-drafted business email written in ${input.promptLanguage}.`,
    `Requested change: ${input.actionInstruction}`,
    `Keep the email in ${input.promptLanguage}.`,
    NO_FABRICATION_RULE,
    JSON_OUTPUT_RULE,
  ].join("\n");

  const user = `Subject: ${input.currentSubject}\n\nBody:\n${input.currentBody}`;

  return { system, user };
}
