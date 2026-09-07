/**
 * Print Surfaces V5 — event branding for exports (spec sections 1-3). Deliberately NOT a second
 * branding database: Exhibition (domain/organizations.ts) already carries everything a branding
 * resolver needs — `logoUrl` (normalizeExhibition ALWAYS fills this in, defaulting to the static
 * `/events/<slug>/logo.png` convention via eventLogoUrl() when no explicit override was set) and
 * an optional DB-uploaded `logoAsset` (StoredAsset). This module only DECIDES which of those two
 * sources wins and what the display fallback is — never fetches, never hardcodes a per-event
 * branch ("if event === FOR BEAUTY"). Every event, including FOR ARCH/FOR DECOR/future ones,
 * resolves through the exact same path: an explicit logoAsset (curated, admin-uploaded) takes
 * priority when present, otherwise the static per-slug convention file, otherwise plain text.
 */
import type { StoredAsset } from "./assets.ts";
import type { Exhibition } from "./organizations.ts";

export type EventBranding = Readonly<{
  displayName: string;
  /** Best-known logo URL — a static `/events/<slug>/logo.png` path or a resolved DB asset URL. Always present when an event was given; the actual file may still 404 (e.g. no static asset was ever added for this slug) — callers must render with an onError/try-catch fallback to `displayName`, never assume this URL is guaranteed to load (section 3). */
  logoUrl?: string;
  /** True only when a curated (DB-uploaded) logo asset exists — informational, lets a caller prefer waiting for the async asset URL resolution over the static convention path. */
  hasCuratedLogo: boolean;
  shortName?: string;
  venue?: string;
  dateRange?: string;
}>;

function formatEventDateRange(event: Pick<Exhibition, "eventFrom" | "eventTo">): string | undefined {
  if (!event.eventFrom) return undefined;
  const from = new Date(event.eventFrom).toLocaleDateString("cs-CZ");
  const to = event.eventTo ? new Date(event.eventTo).toLocaleDateString("cs-CZ") : undefined;
  return to && to !== from ? `${from} – ${to}` : from;
}

/**
 * `resolvedLogoAssetUrl` is an OUT-OF-BAND value the caller resolves itself (e.g. via
 * useAssetUrl/getAssetDownloadUrl against `event.logoAsset`) — this function stays pure/sync, no
 * I/O, matching every other domain resolver in this app. Never falls back across events (an event
 * with neither a curated asset nor a static file simply gets `logoUrl: event.logoUrl` — the plain
 * `/events/<slug>/logo.png` convention path — and rendering code must treat a real 404 there as a
 * text-fallback case, not a resolver-level concern).
 */
export function resolveEventBranding(
  event: Pick<Exhibition, "name" | "slug" | "logoUrl" | "venue" | "eventFrom" | "eventTo"> | undefined,
  resolvedLogoAssetUrl?: string,
): EventBranding {
  if (!event) return { displayName: "", hasCuratedLogo: false };
  return {
    displayName: event.name,
    logoUrl: resolvedLogoAssetUrl ?? event.logoUrl,
    hasCuratedLogo: Boolean(resolvedLogoAssetUrl),
    shortName: event.name,
    venue: event.venue || undefined,
    dateRange: formatEventDateRange(event),
  };
}

/** True when the event has an uploaded logo asset at all (regardless of whether it's been resolved to a URL yet) — lets a caller decide whether to wait for async resolution before falling back to the static path. */
export function eventHasCuratedLogoAsset(event: Pick<Exhibition, "logoAsset"> | undefined): event is Readonly<{ logoAsset: StoredAsset }> {
  return Boolean(event?.logoAsset);
}
