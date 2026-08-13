"use client";

import { RemoteApiUnavailableError } from "./projectRepository.remoteApi.client.ts";

export type PersistenceProbeResult<T> =
  | Readonly<{ mode: "db"; value: T }>
  | Readonly<{ mode: "local-fallback" | "unavailable" }>;

/**
 * Section 7: decides whether the app may fall back to localStorage.
 * - probe() succeeds → DB is primary, its result is reused (no second fetch needed).
 * - probe() fails with a 503 (Supabase not configured) in development → local fallback,
 *   with a visible warning the caller must render (see BoothGenerator's local-fallback banner).
 * - Same 503 in production, or any OTHER failure (network/500/502 — DB configured but
 *   broken) in any environment → "unavailable". Production must never silently pretend
 *   localStorage is cloud persistence, and a broken-but-configured DB is not "not
 *   configured" — surfacing that as a local fallback would silently diverge from the DB
 *   other browsers see.
 */
export async function resolvePersistenceProbe<T>(probe: () => Promise<T>): Promise<PersistenceProbeResult<T>> {
  try {
    const value = await probe();
    return { mode: "db", value };
  } catch (error) {
    if (error instanceof RemoteApiUnavailableError && error.status === 503) {
      return { mode: process.env.NODE_ENV === "production" ? "unavailable" : "local-fallback" };
    }
    return { mode: "unavailable" };
  }
}
