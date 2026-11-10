"use client";

import { attachmentProblem, browserName, safeContextPath, type AttachmentMime, type ClientContext } from "../../domain/support";

/**
 * Browser side of the support API (V1-SUPPORT-01). Every call goes to /api/support/* — the server
 * decides what the account may see. Files are uploaded only when the report / article is being
 * sent: presign → PUT to the private bucket → server-side verification of size and real type.
 */
export class SupportApiError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "SupportApiError";
    this.status = status;
    this.code = code;
  }
}

export async function supportApi<T>(path: string, init?: Readonly<{ body?: unknown; query?: Record<string, string> }>): Promise<T> {
  const query = init?.query ? `?${new URLSearchParams(init.query).toString()}` : "";
  const response = await fetch(`/api/support/${path}${query}`, {
    method: init?.body !== undefined ? "POST" : "GET",
    credentials: "same-origin",
    headers: { Accept: "application/json", ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string; code?: string };
  if (!response.ok) throw new SupportApiError(body.error ?? `Požadavek selhal (HTTP ${response.status}).`, response.status, body.code);
  return body;
}

/** A file waiting in the browser until the report / article is sent (images may be edited before). */
export type LocalFile = Readonly<{ key: string; file: File; previewUrl: string; edited: boolean }>;

export function localFile(file: File, edited = false): LocalFile {
  return { key: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file), edited };
}

export function localFileProblem(file: File): string | undefined {
  return attachmentProblem(file.type, file.size, file.name || "soubor");
}

/** Uploads one file and has the server verify it; returns the attachment id. */
export async function uploadSupportFile(appKey: string, purpose: "ticket" | "article", file: File): Promise<string> {
  const prepared = await supportApi<{ attachment: { id: string }; upload: { uploadUrl: string; headers: Record<string, string> } }>("attachments/presign", {
    body: { app: appKey, purpose, fileName: file.name || "snimek.png", mimeType: file.type as AttachmentMime, size: file.size },
  });
  const put = await fetch(prepared.upload.uploadUrl, { method: "PUT", headers: prepared.upload.headers, body: file });
  if (!put.ok) {
    await supportApi("attachments/discard", { body: { app: appKey, attachmentId: prepared.attachment.id } }).catch(() => undefined);
    throw new SupportApiError(`Soubor ${file.name} se nepodařilo nahrát (HTTP ${put.status}).`, put.status);
  }
  await supportApi("attachments/verify", { body: { app: appKey, attachmentId: prepared.attachment.id } });
  return prepared.attachment.id;
}

/** Short-lived URL of an attached file (the server checks the permission each time). */
export async function attachmentUrl(appKey: string, attachmentId: string, download = false): Promise<string> {
  return (await supportApi<{ url: string }>("attachments/url", { body: { app: appKey, attachmentId, download } })).url;
}

/** What the report's automatic context contains — shown to the user before sending. */
export function currentClientContext(area: string): ClientContext {
  if (typeof window === "undefined") return { area, path: "/", browser: "", viewport: "" };
  return {
    area,
    path: safeContextPath(window.location.pathname, window.location.hash),
    browser: browserName(navigator.userAgent),
    viewport: `${window.innerWidth}×${window.innerHeight}`,
  };
}
