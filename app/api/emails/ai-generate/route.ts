import { NextResponse, type NextRequest } from "next/server.js";
import {
  assertValidEmailAiGenerateRequestBody,
  resolveEmailAiTone,
  EmailAiRequestError,
  type EmailAiGenerateRequestBody,
} from "../../../../domain/emailAi.ts";
import { findEmailAiLanguage } from "../../../../domain/emailAiConfig.ts";
import { isEmailAiRequestAuthorized } from "../../../../lib/ai/emailAiRouteAuth.server.ts";
import { resolveEmailAiProvider } from "../../../../lib/ai/emailAiProvider.server.ts";
import type { EmailAiProvider } from "../../../../lib/ai/emailAiProvider.server.ts";

/**
 * Scoped to exactly one job: validate -> resolve provider -> call generateEmail -> return
 * {subject, body}. No persistence here — saving a template is a separate route/repository
 * (app/api/emails/templates/*).
 */
export async function handleEmailAiGenerate(
  request: NextRequest,
  providerFactory: () => EmailAiProvider | undefined = resolveEmailAiProvider,
): Promise<NextResponse> {
  if (!(await isEmailAiRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro generování e-mailu je vyžadováno přihlášení." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }

  try {
    assertValidEmailAiGenerateRequestBody(body);
  } catch (error) {
    if (error instanceof EmailAiRequestError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    throw error;
  }

  const provider = providerFactory();
  if (provider === undefined) {
    return NextResponse.json({ error: "AI generování e-mailu není momentálně nakonfigurováno.", code: "provider-unavailable" }, { status: 503 });
  }

  const typedBody = body as EmailAiGenerateRequestBody;
  const language = findEmailAiLanguage(typedBody.languageCode)!;
  const tone = resolveEmailAiTone(typedBody.toneId);

  try {
    const result = await provider.generateEmail({
      freeText: typedBody.freeText,
      promptLanguage: language.promptLanguage,
      tone,
      templateInstruction: typedBody.templateInstruction,
      eventContext: typedBody.eventContext,
      recipientName: typedBody.recipientName,
    });

    if (result.ok !== true) {
      return NextResponse.json({ error: "AI generování e-mailu selhalo.", code: result.reason }, { status: 502 });
    }
    if (typeof result.subject !== "string" || typeof result.body !== "string" || result.body.trim().length === 0) {
      return NextResponse.json({ error: "AI poskytovatel vrátil neplatný výsledek.", code: "invalid-response" }, { status: 502 });
    }

    return NextResponse.json({ subject: result.subject, body: result.body, model: result.model, provider: provider.id });
  } catch {
    return NextResponse.json({ error: "AI generování e-mailu se nezdařilo." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleEmailAiGenerate(request);
}
