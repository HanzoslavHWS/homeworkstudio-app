/**
 * E-maily — feasibility layer for a real Microsoft Graph-backed Outlook draft provider (real-usage
 * follow-up spec sections 11/12). Mirrors lib/ai/emailAiProvider.server.ts's resolver shape:
 * `resolveOutlookDraftProvider` never throws, never fabricates a connection — it returns
 * `undefined` until a real provider is actually wired in, so the API route 503s and
 * EmailsPage's "Otevřít v Outlooku" transparently falls back to its existing mailto: behavior.
 *
 * This codebase has NO Microsoft OAuth / Graph / Azure AD integration today — confirmed by repo-
 * wide search (no MSAL, no token storage, no Azure app registration, no delegated-permission
 * consent flow). `resolveOutlookDraftProvider` therefore ALWAYS returns undefined right now. This
 * is deliberate, not a placeholder bug: building a Graph client that "looks connected" without a
 * real OAuth flow behind it would be worse than an honest, visible 503 — see this session's phase
 * report for the exact Azure/Entra app-registration + delegated OAuth (Mail.ReadWrite, consent,
 * token storage/refresh) work a human would need to do before a real provider could exist here.
 * A real implementation is also NOT simply "set an env var": Mail.ReadWrite as a delegated
 * permission requires an interactive per-user sign-in/consent redirect, and this app currently has
 * no per-user identity at all (one shared login — see lib/auth/session.ts) to attach a token to.
 */
import type { EmailOutlookDraftProvider } from "../../domain/emailOutlookDraft.ts";

export function resolveOutlookDraftProvider(
  _env: Readonly<Record<string, string | undefined>> = process.env,
): EmailOutlookDraftProvider | undefined {
  return undefined;
}
