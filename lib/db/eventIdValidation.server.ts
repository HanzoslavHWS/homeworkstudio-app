import type { SupabaseClient } from "@supabase/supabase-js";
import { LEGACY_EVENT_ID_ALIASES, resolveCanonicalEventId } from "../../domain/eventIdentity.ts";

/**
 * Corrective batch — event-ID consistency audit, sections 8/9. The user-facing message for a
 * genuinely unresolvable event reference — deliberately distinct from both the generic persistence
 * failure and the "Supabase not configured" message, and never leaking the raw Postgres FK details.
 */
export const UNKNOWN_EVENT_MESSAGE = "Vybraný veletrh není v databázi. Obnovte data nebo kontaktujte administrátora.";

// Deliberately plain object-literal union members (never `Readonly<{...}>` here) — a `Readonly<T>`
// mapped-type wrapper on each branch defeats TypeScript's discriminated-union narrowing on `ok` in
// some configurations, which is exactly the shape every call site below relies on.
export type EventIdResolution =
  | { readonly ok: true; readonly eventId: string | undefined }
  | { readonly ok: false; readonly message: string };

export type EventIdResolver = (eventId: string | null | undefined) => Promise<EventIdResolution>;

/**
 * Real, DB-backed event-id resolver (spec section 8: "validate that the event ID is resolvable/
 * canonical" BEFORE ever attempting the insert/update). Queries only the handful of candidate ids
 * actually relevant to this ONE request (the input id itself, plus its legacy alias target if one
 * is documented) — never a full table scan, and never trusts a client-supplied id merely because it
 * LOOKS like a real one.
 */
export function createSupabaseEventIdResolver(client: SupabaseClient): EventIdResolver {
  return async (eventId) => {
    const trimmed = eventId?.trim();
    if (!trimmed) return { ok: true, eventId: undefined };
    const alias = LEGACY_EVENT_ID_ALIASES[trimmed];
    const candidates = alias ? [trimmed, alias] : [trimmed];
    const { data, error } = await client.from("events").select("id").in("id", candidates);
    if (error) throw error;
    const known = new Set(((data ?? []) as readonly { id: string }[]).map((row) => row.id));
    const canonical = resolveCanonicalEventId(trimmed, known);
    if (canonical === undefined) return { ok: false, message: UNKNOWN_EVENT_MESSAGE };
    return { ok: true, eventId: canonical };
  };
}

/**
 * Defense-in-depth classifier for a raw Postgres foreign-key violation (code `23503`) that
 * specifically names `event_id` — this is what a save would still hit if, despite the pre-insert
 * resolver above, a request somehow reaches the DB with an unresolvable event id (e.g. a caller
 * that bypasses the resolver, or a future code path that forgets to call it). Never misclassifies
 * an UNRELATED foreign-key violation (a different constrained column) as an event-reference problem
 * — this only matches when the violation's own message/details explicitly mention `event_id`.
 */
export function isEventForeignKeyViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
  if (candidate.code !== "23503") return false;
  const text = `${typeof candidate.message === "string" ? candidate.message : ""} ${typeof candidate.details === "string" ? candidate.details : ""}`;
  return /event_id/iu.test(text);
}
