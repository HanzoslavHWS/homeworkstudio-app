import { NextResponse, type NextRequest } from "next/server.js";
import {
  assertValidEmailOutlookDraftInput,
  EmailOutlookDraftRequestError,
  type EmailOutlookDraftInput,
} from "../../../../domain/emailOutlookDraft.ts";
import { isEmailAiRequestAuthorized } from "../../../../lib/ai/emailAiRouteAuth.server.ts";
import { resolveOutlookDraftProvider } from "../../../../lib/mail/outlookDraftProvider.server.ts";
import type { EmailOutlookDraftProvider } from "../../../../domain/emailOutlookDraft.ts";

/**
 * Real-usage follow-up (spec sections 11-13) — creates a real Outlook draft via whichever
 * EmailOutlookDraftProvider is resolved. Always 503s today (resolveOutlookDraftProvider always
 * returns undefined — see that module's doc for exactly why), which is the intended, honest
 * signal for EmailsPage to fall back to its existing mailto: behavior — never a fake success.
 */
export async function handleEmailOutlookDraft(
  request: NextRequest,
  providerFactory: () => EmailOutlookDraftProvider | undefined = resolveOutlookDraftProvider,
): Promise<NextResponse> {
  if (!(await isEmailAiRequestAuthorized(request))) {
    return NextResponse.json({ error: "Pro vytvoření konceptu je vyžadováno přihlášení." }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Neplatný JSON požadavek." }, { status: 400 });
  }

  try {
    assertValidEmailOutlookDraftInput(body);
  } catch (error) {
    if (error instanceof EmailOutlookDraftRequestError) return NextResponse.json({ error: error.message, code: error.code }, { status: 400 });
    throw error;
  }

  const provider = providerFactory();
  if (provider === undefined) {
    return NextResponse.json({ error: "Vytváření konceptů v Outlooku není momentálně nakonfigurováno.", code: "provider-unavailable" }, { status: 503 });
  }

  try {
    const result = await provider.createDraft(body as EmailOutlookDraftInput);
    return NextResponse.json(result);
  } catch {
    return NextResponse.json({ error: "Vytvoření konceptu v Outlooku se nezdařilo.", code: "provider-error" }, { status: 502 });
  }
}

export async function POST(request: NextRequest) {
  return handleEmailOutlookDraft(request);
}
