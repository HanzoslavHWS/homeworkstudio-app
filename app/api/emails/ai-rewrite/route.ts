import { NextResponse, type NextRequest } from "next/server.js";
import {
  assertValidEmailAiRewriteRequestBody,
  EmailAiRequestError,
  type EmailAiRewriteRequestBody,
} from "../../../../domain/emailAi.ts";
import { findEmailAiLanguage, findEmailAiRewriteAction } from "../../../../domain/emailAiConfig.ts";
import { isEmailAiRequestAuthorized } from "../../../../lib/ai/emailAiRouteAuth.server.ts";
import { resolveEmailAiProvider } from "../../../../lib/ai/emailAiProvider.server.ts";
import type { EmailAiProvider } from "../../../../lib/ai/emailAiProvider.server.ts";

/**
 * Applies one quick edit (Přeformulovat / Zkrátit / Více formální / ...) to the CURRENT
 * subject+body the client sends — never re-derives from the original free text, matching the
 * spec's "each edit works on the current result, not just the original input again".
 */
export async function handleEmailAiRewrite(
  request: NextRequest,
  providerFactory: () => EmailAiProvider | undefined = resolveEmailAiProvider,
): Promise<NextResponse> {
  if (!(await isEmailAiRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro úpravu e-mailu je vyžadováno přihlášení." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }

  try {
    assertValidEmailAiRewriteRequestBody(body);
  } catch (error) {
    if (error instanceof EmailAiRequestError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    throw error;
  }

  const provider = providerFactory();
  if (provider === undefined) {
    return NextResponse.json({ error: "AI úprava e-mailu není momentálně nakonfigurována.", code: "provider-unavailable" }, { status: 503 });
  }

  const typedBody = body as EmailAiRewriteRequestBody;
  const language = findEmailAiLanguage(typedBody.languageCode)!;
  const action = findEmailAiRewriteAction(typedBody.actionId)!;

  try {
    const result = await provider.rewriteEmail({
      currentSubject: typedBody.subject,
      currentBody: typedBody.body,
      actionInstruction: action.instruction,
      promptLanguage: language.promptLanguage,
    });

    if (result.ok !== true) {
      return NextResponse.json({ error: "AI úprava e-mailu selhala.", code: result.reason }, { status: 502 });
    }
    if (typeof result.subject !== "string" || typeof result.body !== "string" || result.body.trim().length === 0) {
      return NextResponse.json({ error: "AI poskytovatel vrátil neplatný výsledek.", code: "invalid-response" }, { status: 502 });
    }

    return NextResponse.json({ subject: result.subject, body: result.body, model: result.model, provider: provider.id });
  } catch {
    return NextResponse.json({ error: "AI úprava e-mailu se nezdařila." }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleEmailAiRewrite(request);
}
