"use client";

import { seeMimeTypeFor } from "../../domain/seeFiles";
import { isRetryableStatus, SeeTransientError, withRetry } from "../../domain/seeRetry";
import type { SeeFileKind, SeeProjectSummary } from "../../domain/seeProject";
import type { SeeEditorFile, SeeEditorView } from "../../domain/seeViews";

/** Browser helpers for the HWS SEE editor API (portal session cookie travels automatically). */

export class SeeApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export const SEE_OFFLINE_MESSAGE = "Server není dostupný — zkontrolujte připojení k internetu a zkuste to znovu.";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { ...(init?.body ? { "Content-Type": "application/json" } : {}), ...init?.headers }, cache: "no-store" });
  } catch {
    throw new SeeApiError(SEE_OFFLINE_MESSAGE, 0);
  }
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (response.status === 401 && typeof window !== "undefined") {
    window.location.href = `/login?next=${encodeURIComponent(window.location.pathname)}`;
  }
  if (!response.ok) throw new SeeApiError(body.error ?? `Požadavek selhal (${response.status}).`, response.status);
  return body;
}

/** Same as call(), but transient failures (offline, 5xx, storage outage) are retried with backoff. */
async function callWithRetry<T>(url: string, init: RequestInit, onRetry?: (attempt: number) => void): Promise<T> {
  return withRetry(() => call<T>(url, init), {
    attempts: 3,
    baseDelayMs: 1500,
    shouldRetry: (error) => error instanceof SeeApiError && isRetryableStatus(error.status),
    onRetry: (attempt) => onRetry?.(attempt),
  });
}

export type SeeProjectList = Readonly<{ items: readonly SeeProjectSummary[]; total: number; backend: "supabase" | "local" }>;

export function listSeeProjects(params: URLSearchParams) {
  return call<SeeProjectList>(`/api/see/projects?${params.toString()}`);
}

export async function createSeeProject(input: Readonly<{ name: string; description: string; scenes: readonly Readonly<{ name: string }>[] }>) {
  return (await call<{ project: SeeEditorView }>("/api/see/projects", { method: "POST", body: JSON.stringify(input) })).project;
}

export async function getSeeProject(id: string) {
  return (await call<{ project: SeeEditorView }>(`/api/see/projects/${id}`)).project;
}

export async function saveSeeProject(id: string, body: unknown) {
  return (await call<{ project: SeeEditorView }>(`/api/see/projects/${id}`, { method: "PUT", body: JSON.stringify(body) })).project;
}

export function changeSeeProjectStatus(id: string, action: string) {
  return call<{ status: string; warning?: string }>(`/api/see/projects/${id}/status`, { method: "POST", body: JSON.stringify({ action }) });
}

export function seePublicationAction(id: string, body: Readonly<Record<string, unknown>>) {
  return call<{ project: SeeEditorView; pin?: string; warning?: string }>(`/api/see/projects/${id}/publication`, { method: "POST", body: JSON.stringify(body) });
}

export async function seeEditorFileUrl(projectId: string, fileId: string, download = false) {
  return (await call<{ url: string }>(`/api/see/projects/${projectId}/files/${fileId}${download ? "?download=1" : ""}`)).url;
}

export type SeeUploadProgress = Readonly<{ percent: number; state: "uploading" | "verifying" | "done" | "error"; message?: string }>;

/**
 * presign (server validates type/size/permission) → direct PUT with progress → server-side
 * verification (size + magic bytes). Returns the updated project after verification.
 */
export async function uploadSeeFile(
  projectId: string,
  file: File,
  target: Readonly<{ kind: SeeFileKind; sceneId?: string; displayName?: string; appliesToAll?: boolean; sceneIds?: readonly string[] }>,
  onProgress: (progress: SeeUploadProgress) => void,
): Promise<Readonly<{ project: SeeEditorView; file: SeeEditorFile }>> {
  try {
    onProgress({ percent: 0, state: "uploading" });
    const mimeType = seeMimeTypeFor(file.name, file.type);
    const prepared = await call<{ file: SeeEditorFile; upload: { uploadUrl: string; headers: Record<string, string> } }>(`/api/see/projects/${projectId}/uploads`, {
      method: "POST",
      body: JSON.stringify({ kind: target.kind, fileName: file.name, mimeType, sizeBytes: file.size, displayName: target.displayName, appliesToAll: target.appliesToAll, sceneIds: target.sceneIds }),
    });
    // The presigned PUT stays valid ~15 min, so a dropped connection is simply retried.
    await withRetry(() => putWithProgress(prepared.upload.uploadUrl, file, prepared.upload.headers, (percent) => onProgress({ percent, state: "uploading" })), {
      attempts: 3,
      baseDelayMs: 2000,
      onRetry: (attempt) => onProgress({ percent: 0, state: "uploading", message: `Spojení se přerušilo, zkouším znovu (${attempt + 1}/3)…` }),
    });
    onProgress({ percent: 100, state: "verifying" });
    // "complete" is idempotent on the server: repeating it after an outage is safe.
    const completed = await callWithRetry<{ project: SeeEditorView }>(`/api/see/projects/${projectId}/uploads/complete`, {
      method: "POST",
      body: JSON.stringify({ fileId: prepared.file.id, sceneId: target.sceneId }),
    }, (attempt) => onProgress({ percent: 100, state: "verifying", message: `Úložiště neodpovídá, ověření zkouším znovu (${attempt + 1}/3)…` }));
    onProgress({ percent: 100, state: "done" });
    return { project: completed.project, file: prepared.file };
  } catch (error) {
    onProgress({ percent: 0, state: "error", message: error instanceof Error ? error.message : "Upload se nezdařil." });
    throw error;
  }
}

function putWithProgress(url: string, file: File, headers: Readonly<Record<string, string>>, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    Object.entries(headers).forEach(([name, value]) => request.setRequestHeader(name, value));
    request.upload.onprogress = (event) => event.lengthComputable && onProgress(Math.round((event.loaded / event.total) * 100));
    request.onerror = () => reject(new SeeTransientError("Nahrávání se přerušilo (výpadek sítě nebo úložiště). Pokud se to opakuje, ověřte připojení a nastavení CORS úložiště."));
    request.ontimeout = () => reject(new SeeTransientError("Nahrávání trvá příliš dlouho — spojení se zřejmě přerušilo."));
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else if (isRetryableStatus(request.status)) reject(new SeeTransientError(`Úložiště je dočasně nedostupné (${request.status}).`, request.status));
      else if (request.status === 403) reject(new Error("Odkaz pro nahrání vypršel nebo byl odmítnut — nahrajte soubor prosím znovu."));
      else reject(new Error(`Úložiště odmítlo soubor (${request.status}).`));
    };
    request.send(file);
  });
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function formatDateTime(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleString("cs-CZ", { day: "numeric", month: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });
}
