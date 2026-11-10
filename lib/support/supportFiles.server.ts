import { createCloudflareR2StorageProvider } from "../storage/cloudflareR2.server.ts";

/**
 * Support attachments in the EXISTING private R2 bucket (same provider, same environment guards as
 * every other file of the app), under support/<app>/<attachment id>/<safe name>. Only short-lived
 * presigned URLs leave the server, and only after the support API checked the permission.
 */
export interface SupportFiles {
  createUploadUrl(input: Readonly<{ storageKey: string; mimeType: string; originalFileName: string; expiresInSeconds?: number }>): Promise<Readonly<{ uploadUrl: string; method: "PUT"; headers: Record<string, string>; expiresAt: string }>>;
  getDownloadUrl(storageKey: string, expiresInSeconds?: number, downloadFileName?: string): Promise<string>;
  getMetadata(storageKey: string): Promise<Readonly<{ contentLength?: number }> | undefined>;
  readObjectPrefix(storageKey: string, length?: number): Promise<Uint8Array | undefined>;
  deleteObject(storageKey: string): Promise<void>;
}

let override: SupportFiles | undefined;
export function supportFiles(): SupportFiles {
  return override ?? createCloudflareR2StorageProvider();
}
/** Tests only. */
export function setSupportFilesForTesting(files: SupportFiles | undefined): void {
  override = files;
}
