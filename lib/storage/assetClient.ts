"use client";

import type { AssetCategory, StoredAsset } from "../../domain/assets.ts";

export type UploadProgress = Readonly<{ state: "uploading" | "success" | "error"; percent: number; message?: string }>;
export type RasterImageDimensions = Readonly<{ widthPx: number; heightPx: number }>;

export async function uploadAsset(
  file: File,
  target: Readonly<{ category: AssetCategory; ownerId: string; displayName?: string }>,
  onProgress?: (progress: UploadProgress) => void,
): Promise<StoredAsset> {
  onProgress?.({ state: "uploading", percent: 0 });
  try {
    const mimeType = browserFileMimeType(file);
    const presignResponse = await fetch("/api/assets/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ category: target.category, ownerId: target.ownerId, originalFileName: file.name, mimeType, size: file.size, displayName: target.displayName }),
    });
    const prepared = await presignResponse.json() as { asset?: StoredAsset; upload?: { uploadUrl: string; method: "PUT"; headers: Record<string, string> }; error?: string };
    if (!presignResponse.ok || !prepared.asset || !prepared.upload) throw new Error(prepared.error ?? "Server nepřipravil upload.");
    await putFile(prepared.upload.uploadUrl, file, prepared.upload.headers, (percent) => onProgress?.({ state: "uploading", percent }));
    onProgress?.({ state: "success", percent: 100 });
    return prepared.asset;
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload se nezdařil.";
    onProgress?.({ state: "error", percent: 0, message });
    throw error;
  }
}

export function browserFileMimeType(file: Pick<File, "name" | "type">): string {
  if (file.type) return file.type;
  const extension = file.name.toLowerCase().split(".").pop();
  return ({ ai: "application/illustrator", eps: "application/postscript", pdf: "application/pdf", svg: "image/svg+xml", glb: "model/gltf-binary", doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", txt: "text/plain", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp" } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

/** Reads real raster dimensions before upload so Fit/Fill remains deterministic after reload. */
export async function readRasterImageDimensions(file: File): Promise<RasterImageDimensions | undefined> {
  if (!["image/png", "image/jpeg", "image/jpg", "image/webp"].includes(browserFileMimeType(file))) {
    return undefined;
  }
  try {
    if (typeof createImageBitmap === "function") {
      const bitmap = await createImageBitmap(file);
      const dimensions = { widthPx: bitmap.width, heightPx: bitmap.height };
      bitmap.close();
      return dimensions.widthPx > 0 && dimensions.heightPx > 0 ? dimensions : undefined;
    }
    const url = URL.createObjectURL(file);
    try {
      const image = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image();
        element.onload = () => resolve(element);
        element.onerror = () => reject(new Error("Rozměry obrázku se nepodařilo načíst."));
        element.src = url;
      });
      return image.naturalWidth > 0 && image.naturalHeight > 0
        ? { widthPx: image.naturalWidth, heightPx: image.naturalHeight }
        : undefined;
    } finally {
      URL.revokeObjectURL(url);
    }
  } catch {
    return undefined;
  }
}

export async function getAssetDownloadUrl(storageKey: string): Promise<string> {
  const response = await fetch("/api/assets/download", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ storageKey }) });
  const result = await response.json() as { downloadUrl?: string; error?: string };
  if (!response.ok || !result.downloadUrl) throw new Error(result.error ?? "Asset není dostupný.");
  return result.downloadUrl;
}

export async function dataUrlToFile(dataUrl: string, fileName: string): Promise<File> {
  const response = await fetch(dataUrl);
  const blob = await response.blob();
  return new File([blob], fileName, { type: blob.type || "image/png" });
}

function putFile(url: string, file: File, headers: Readonly<Record<string, string>>, onProgress: (percent: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    Object.entries(headers).forEach(([name, value]) => request.setRequestHeader(name, value));
    request.upload.onprogress = (event) => event.lengthComputable && onProgress(Math.round(event.loaded / event.total * 100));
    request.onerror = () => reject(new Error("Síťová chyba při přímém uploadu do R2."));
    request.onload = () => request.status >= 200 && request.status < 300 ? resolve() : reject(new Error(`R2 upload selhal (${request.status}).`));
    request.send(file);
  });
}
