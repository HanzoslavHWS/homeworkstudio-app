import { hwsApp } from "../../domain/hwsApps.ts";
import { sanitizeClientContext, type ClientContext } from "../../domain/support.ts";

/**
 * "Nahlásit chybu" in a new tab (V1-SUPPORT-03). The page the user was on stays exactly as it was; the
 * report form opens at <app>/nahlasit#k=<random id>. The URL carries only that random one-time handle
 * — in the fragment, which never reaches the server or its logs. The context of the ORIGINAL page
 * (area, safe path, browser, window size, optionally the saved project) is handed over through
 * localStorage of the same origin under that handle, so the report never names the form's own address.
 * Nothing sensitive is stored: the context is sanitized on both sides, no form content, no tokens.
 */
export type ReportHandoff = Readonly<{ appKey: string; context: ClientContext; project?: Readonly<{ id: string; name: string }>; createdAt: number }>;
type KeyValueStore = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

const PREFIX = "hws-support-report:";
/** A form left open longer still works — only without the original context. */
export const REPORT_HANDOFF_TTL_MS = 2 * 60 * 60 * 1000;
/** Written by the form tab after a report was created; other tabs refresh their counters. */
export const REPORT_CREATED_EVENT_KEY = "hws-support:created";
const HANDLE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export function reportTabUrl(appKey: string, handle: string | null): string {
  const base = `${hwsApp(appKey)?.url ?? `/${appKey}`}/nahlasit`;
  return handle ? `${base}#k=${handle}` : base;
}

export function handleFromHash(hash: string): string | null {
  const value = new URLSearchParams(hash.replace(/^#/u, "")).get("k");
  return value && HANDLE.test(value) ? value : null;
}

/** Validated, sanitized handoff — or undefined (missing, expired, malformed). */
export function parseReportHandoff(raw: string | null, now: number): ReportHandoff | undefined {
  if (!raw) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const input = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  const createdAt = Number(input.createdAt);
  if (typeof input.appKey !== "string" || !Number.isFinite(createdAt) || now - createdAt > REPORT_HANDOFF_TTL_MS || createdAt - now > 60_000) return undefined;
  const project = input.project && typeof input.project === "object" ? (input.project as Record<string, unknown>) : undefined;
  return {
    appKey: input.appKey,
    context: sanitizeClientContext(input.context),
    ...(project && typeof project.id === "string" && typeof project.name === "string" && project.id ? { project: { id: project.id.slice(0, 200), name: project.name.slice(0, 200) } } : {}),
    createdAt,
  };
}

/** Old handles of tabs that were never sent. */
function removeExpired(store: KeyValueStore, now: number): void {
  const keys: string[] = [];
  for (let index = 0; index < store.length; index++) {
    const key = store.key(index);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  for (const key of keys) if (!parseReportHandoff(store.getItem(key), now)) store.removeItem(key);
}

/** In the original tab: stores the context and returns the handle (null when storage is unavailable). */
export function storeReportHandoff(store: KeyValueStore | undefined, handoff: Omit<ReportHandoff, "createdAt">, now: number, handle: string): string | null {
  if (!store) return null;
  try {
    removeExpired(store, now);
    store.setItem(`${PREFIX}${handle}`, JSON.stringify({ appKey: handoff.appKey, context: sanitizeClientContext(handoff.context), ...(handoff.project ? { project: handoff.project } : {}), createdAt: now }));
    return handle;
  } catch {
    return null;
  }
}

/** In the form tab: kept until the report is sent, so a reload of the form keeps the context. */
export function readReportHandoff(store: KeyValueStore | undefined, handle: string | null, appKey: string, now: number): ReportHandoff | undefined {
  if (!store || !handle) return undefined;
  try {
    const handoff = parseReportHandoff(store.getItem(`${PREFIX}${handle}`), now);
    return handoff && handoff.appKey === appKey ? handoff : undefined;
  } catch {
    return undefined;
  }
}

export function clearReportHandoff(store: KeyValueStore | undefined, handle: string | null): void {
  if (!store || !handle) return;
  try {
    store.removeItem(`${PREFIX}${handle}`);
  } catch {
    // storage unavailable — the handle expires on its own
  }
}

const browserStorage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/**
 * Opens the report form in a new tab of the same application. Returns false when the browser blocked
 * the new tab (the original page is never navigated away, so nothing unsaved can be lost).
 */
export function openReportTab(appKey: string, handoff: Omit<ReportHandoff, "appKey" | "createdAt">): boolean {
  const handle = storeReportHandoff(browserStorage(), { appKey, ...handoff }, Date.now(), crypto.randomUUID());
  const tab = window.open(reportTabUrl(appKey, handle), "_blank");
  if (!tab) {
    clearReportHandoff(browserStorage(), handle);
    return false;
  }
  try {
    tab.opener = null; // the form needs nothing from this page
  } catch {
    // ignore
  }
  return true;
}

/** Calls `onCreated` when a report is created in another tab of this browser. */
export function onReportCreatedElsewhere(onCreated: () => void): () => void {
  const listener = (event: StorageEvent) => {
    if (event.key === REPORT_CREATED_EVENT_KEY && event.newValue) onCreated();
  };
  window.addEventListener("storage", listener);
  return () => window.removeEventListener("storage", listener);
}

export function announceReportCreated(): void {
  try {
    browserStorage()?.setItem(REPORT_CREATED_EVENT_KEY, String(Date.now()));
  } catch {
    // other tabs refresh on focus anyway
  }
}

export const reportFormStorage = browserStorage;
