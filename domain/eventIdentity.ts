/**
 * Corrective batch — event-ID consistency audit. Root cause: `data/organizations.ts`'s own local
 * fallback/dev seed (used both as `LocalEventRepository`'s seed AND as the app's synchronous
 * pre-hydration default state before a real DB-backed event list loads) historically used
 * per-EDITION identifiers ("for-beauty-autumn-2026", "for-decor-2026") — but the actual production
 * Supabase `events` table (verified directly against its real row IDs: arch, beauty, ctm, czechbus,
 * decor, esalon, event-1786622663908, fishing, gastro, holiday, interior, kids, pets, svd, truck)
 * proves the REAL canonical model is one STABLE identity per exhibition BRAND, with no year/edition
 * baked into the id at all — year/edition are separate `Exhibition.year`/`Exhibition.edition`
 * fields on the SAME long-lived event row (see domain/organizations.ts's own Exhibition type; the
 * migration's own comment on `events.source_key` — "Stable Excel-import identity, e.g. 'beauty' /
 * 'arch'" — already pointed at this, it just was never reflected in the seed's own `id` values).
 * `event-1786622663908` is the one production event NOT yet given a clean brand slug — it was
 * created via components/workflow/CatalogManagementPages.tsx's own `addEvent()` (`id:
 * event-${Date.now()}`), which never exposes an editable `id` field; every clean slug ("beauty",
 * "arch", ...) predates that flow or was set directly, outside this app's current UI.
 *
 * `data/organizations.ts`/`data/fairs.ts` have been corrected to use the real canonical ids
 * directly (the actual fix — see their own updated doc comments) so no NEW data is ever created
 * under a legacy id going forward. This module exists as a SECOND, defense-in-depth layer for data
 * that already exists under an old id (a draft already open in a browser tab before the seed fix
 * shipped, a stale cached value, or any other stray reference) — never a replacement for fixing the
 * seed at its source.
 *
 * Deliberately CONSERVATIVE (spec: "Do not silently invent mappings where uncertain"): only the two
 * confirmed brand correspondences below are aliased. `data/organizations.ts`'s own third legacy
 * entry, "international-2026", has NO confirmed brand counterpart anywhere in the real production
 * event list — it is deliberately NOT aliased here; see the batch's own final report for why.
 */

/**
 * Legacy (pre-fix) application-level event id -> the real, confirmed production Supabase `events.id`
 * for the SAME logical exhibition brand. Every key here is a per-edition id this app's own seed data
 * used to generate; every value is a real, verified production row id.
 */
export const LEGACY_EVENT_ID_ALIASES: Readonly<Record<string, string>> = {
  "for-beauty-autumn-2026": "beauty",
  "for-beauty-autumn-2027": "beauty",
  "for-decor-2026": "decor",
  "for-decor-2027": "decor",
};

/**
 * The ONE place an incoming event id (from a request payload, a stale client cache, a legacy saved
 * project, ...) is reconciled against a REAL, currently-known set of event ids before it is ever
 * trusted for persistence. Never fuzzy, never a partial/best-effort guess:
 *
 *   - empty/undefined/whitespace-only input -> `undefined` (a project with no fair is valid).
 *   - input already present in `knownEventIds` -> returned UNCHANGED (already canonical — this
 *     covers every real, current production id, e.g. "beauty", "arch", "event-1786622663908").
 *   - input is a documented legacy alias (`LEGACY_EVENT_ID_ALIASES`) AND that alias's target is
 *     itself present in `knownEventIds` -> the alias target is returned.
 *   - anything else -> `undefined`, signalling "this event id could not be confirmed" — the caller
 *     (an API route) is expected to treat this as a validation failure, never silently substitute a
 *     guess or fall through to a raw DB insert that would violate the events foreign key.
 */
export function resolveCanonicalEventId(inputId: string | null | undefined, knownEventIds: ReadonlySet<string> | Iterable<string>): string | undefined {
  const trimmed = inputId?.trim();
  if (!trimmed) return undefined;
  const known = knownEventIds instanceof Set ? knownEventIds : new Set(knownEventIds);
  if (known.has(trimmed)) return trimmed;
  const alias = LEGACY_EVENT_ID_ALIASES[trimmed];
  if (alias && known.has(alias)) return alias;
  return undefined;
}
