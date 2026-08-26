/**
 * Visualization v2 — "Stáhnout všechny": bundles the already-in-memory render data URLs (a
 * render's imageDataUrl is always populated at capture time, never cleared after the R2 upload —
 * same permanent-fallback convention domain/project.ts's VisualizationItem already uses) into a
 * ZIP via the existing dependency-free lib/zip.ts. No remote fetch needed (unlike Graphics
 * Production Package's ZIP, which pulls externally-uploaded print files from R2) — but still
 * never produces a silently incomplete ZIP: any entry with no usable image data fails the whole
 * build with an explicit list, exactly like assembleGraphicsProductionZipEntries's contract.
 */
import { createZip, dataUrlZipEntry, type ZipEntry } from "./zip.ts";

export type VisualizationDownloadEntry = Readonly<{ fileName: string; dataUrl: string | undefined }>;

export type VisualizationZipEntriesResult =
  | Readonly<{ ok: true; entries: readonly ZipEntry[] }>
  | Readonly<{ ok: false; failedFiles: readonly string[] }>;

export type VisualizationZipResult =
  | Readonly<{ ok: true; blob: Blob }>
  | Readonly<{ ok: false; failedFiles: readonly string[] }>;

/** Pure assembly step, split out so tests can assert on the exact entry set without parsing a real ZIP Blob back out — same split lib/graphicsProductionPackage.ts uses. */
export function assembleVisualizationZipEntries(
  packageName: string,
  entries: readonly VisualizationDownloadEntry[],
  presentationPdf?: Readonly<{ fileName: string; bytes: Uint8Array }>,
): VisualizationZipEntriesResult {
  const failedFiles = entries.filter((entry) => !entry.dataUrl).map((entry) => entry.fileName);
  if (failedFiles.length > 0) return { ok: false, failedFiles };

  const zipEntries: ZipEntry[] = entries.map((entry) => dataUrlZipEntry(`${packageName}/${entry.fileName}`, entry.dataUrl!));
  if (presentationPdf) zipEntries.push({ path: `${packageName}/${presentationPdf.fileName}`, data: presentationPdf.bytes });
  return { ok: true, entries: zipEntries };
}

export function buildVisualizationRendersZip(
  packageName: string,
  entries: readonly VisualizationDownloadEntry[],
  presentationPdf?: Readonly<{ fileName: string; bytes: Uint8Array }>,
): VisualizationZipResult {
  const assembled = assembleVisualizationZipEntries(packageName, entries, presentationPdf);
  if (assembled.ok === true) return { ok: true, blob: createZip(assembled.entries) };
  return { ok: false, failedFiles: assembled.failedFiles };
}
