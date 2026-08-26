/**
 * Graphics Production Package v1 — the async orchestration tier: fetches REAL R2 bytes for each
 * ready surface (never re-rendered/re-encoded), builds manifest.pdf (lib/graphicsProductionPdf.ts)
 * and manifest.json, assembles the final ZIP via the existing dependency-free lib/zip.ts.
 *
 * `downloadAssetBytes` is an injected dependency (report section 9/29): the real implementation
 * (downloadAssetBytesViaSignedUrl below) wraps the existing getAssetDownloadUrl+fetch pattern
 * already used by components/workflow/WorkflowSteps.tsx's downloadPackage() — no new server
 * endpoint, no raw R2 credentials in the browser. Tests inject an in-memory fake instead, so this
 * I/O-heavy module stays unit-testable under node:test with zero network access.
 *
 * Failure handling deliberately differs from downloadPackage()'s existing silent-omit-on-failure
 * pattern (report section 23): production data is being handed to a print shop, so ANY source
 * download failure fails the WHOLE package with a clear list of what failed — never a silently
 * incomplete ZIP.
 */
import { createZip, textZipEntry, type ZipEntry } from "./zip.ts";
import { buildGraphicsProductionManifestPdf } from "./graphicsProductionPdf.ts";
import { getAssetDownloadUrl } from "./storage/assetClient.ts";
import { isRasterArtworkFile } from "./printArtworkOverlays.ts";
import type { GraphicsProductionFolderPlan, GraphicsProductionManifest, GraphicsProductionReadinessRow } from "../domain/graphicsProduction.ts";

export type GraphicsProductionPackageProgress = Readonly<{ completed: number; total: number; currentFileName?: string }>;

export type GraphicsProductionPackageInput = Readonly<{
  readyRows: readonly GraphicsProductionReadinessRow[];
  manifest: GraphicsProductionManifest;
  packageName: string;
  folderPlan: readonly GraphicsProductionFolderPlan[];
}>;

export type DownloadAssetBytes = (storageKey: string) => Promise<Uint8Array>;

export type GraphicsProductionPackageDeps = Readonly<{
  downloadAssetBytes: DownloadAssetBytes;
  onProgress?: (progress: GraphicsProductionPackageProgress) => void;
}>;

export type GraphicsProductionZipAssembly =
  | Readonly<{ ok: true; entries: readonly ZipEntry[] }>
  | Readonly<{ ok: false; failedFiles: readonly string[] }>;

export type GraphicsProductionPackageResult =
  | Readonly<{ ok: true; blob: Blob; fileName: string }>
  | Readonly<{ ok: false; failedFiles: readonly string[] }>;

// Best-effort manifest.pdf thumbnails only — never embed a multi-MB print-data file as an
// inline preview image; the actual production file goes into PRINT_DATA/ untouched regardless.
const MAX_THUMBNAIL_SOURCE_BYTES = 8_000_000;

/**
 * Pure-ish assembly step (the only I/O is `downloadAssetBytes`) split out from
 * buildGraphicsProductionPackage so tests can assert on the exact entry set without needing to
 * parse a real ZIP back out (report section 29).
 */
export async function assembleGraphicsProductionZipEntries(
  input: GraphicsProductionPackageInput,
  deps: GraphicsProductionPackageDeps,
): Promise<GraphicsProductionZipAssembly> {
  const total = input.folderPlan.length;
  const failedFiles: string[] = [];
  const fileEntries: ZipEntry[] = [];
  const thumbnails = new Map<string, string>();

  for (const [index, planned] of input.folderPlan.entries()) {
    const row = planned.row;
    deps.onProgress?.({ completed: index, total, currentFileName: row.exportFileName });
    const storageKey = row.artworkAsset?.storageKey;
    if (!storageKey) {
      // Contract violation guard: folderPlan should only ever contain status "ready" rows
      // (which imply artworkAsset is defined) — never crash on a caller mistake, just report it
      // the same way a real download failure is reported.
      failedFiles.push(row.exportFileName ?? row.printSurfaceId);
      continue;
    }
    try {
      const bytes = await deps.downloadAssetBytes(storageKey);
      fileEntries.push({ path: `${input.packageName}/${planned.path}`, data: bytes });
      try {
        if (bytes.length <= MAX_THUMBNAIL_SOURCE_BYTES && isRasterArtworkFile({ mimeType: row.artworkAsset.mimeType, name: row.exportFileName ?? "" })) {
          thumbnails.set(row.printSurfaceId, bytesToDataUrl(bytes, row.artworkAsset.mimeType));
        }
      } catch {
        // Thumbnail generation is a manifest.pdf preview convenience only — never fails the
        // actual print-data file, which already downloaded successfully above.
      }
    } catch {
      failedFiles.push(row.exportFileName ?? row.printSurfaceId);
    }
  }
  deps.onProgress?.({ completed: total, total });

  if (failedFiles.length > 0) return { ok: false, failedFiles };

  const pdfBytes = await buildGraphicsProductionManifestPdf(input.manifest, thumbnails);
  const entries: ZipEntry[] = [
    { path: `${input.packageName}/manifest.pdf`, data: pdfBytes },
    textZipEntry(`${input.packageName}/manifest.json`, JSON.stringify(input.manifest, null, 2)),
    ...fileEntries,
  ];
  return { ok: true, entries };
}

export async function buildGraphicsProductionPackage(
  input: GraphicsProductionPackageInput,
  deps: GraphicsProductionPackageDeps,
): Promise<GraphicsProductionPackageResult> {
  const assembled = await assembleGraphicsProductionZipEntries(input, deps);
  // This project's tsconfig runs strict:false; under this TypeScript build, boolean-literal
  // discriminant narrowing on a truthy/falsy check (if (assembled.ok)) silently fails to narrow
  // without strictNullChecks — an explicit === true comparison is the verified-working pattern.
  if (assembled.ok === true) return { ok: true, blob: createZip(assembled.entries), fileName: input.packageName };
  return { ok: false, failedFiles: assembled.failedFiles };
}

/** Real browser implementation — same getAssetDownloadUrl+fetch pattern WorkflowSteps.tsx's downloadPackage() already uses. */
export async function downloadAssetBytesViaSignedUrl(storageKey: string): Promise<Uint8Array> {
  const url = await getAssetDownloadUrl(storageKey);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Nepodařilo se stáhnout soubor (${response.status}).`);
  return new Uint8Array(await response.arrayBuffer());
}

function bytesToDataUrl(bytes: Uint8Array, mimeType: string): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:${mimeType};base64,${btoa(binary)}`;
}
