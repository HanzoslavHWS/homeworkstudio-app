"use client";

import { seeMimeTypeFor } from "../../domain/seeFiles";

export const SEE_IMAGE_MAX_EDGE = 1600;

/**
 * Optimized preview for annotation / info-panel pictures: large photos are scaled down in the
 * browser (longest edge 1600 px, aspect ratio kept, never upscaled) and re-encoded as WebP (JPEG
 * fallback). Small or already compact images are uploaded unchanged. The server still validates
 * the type, size and file signature of whatever arrives.
 */
export async function prepareImageForUpload(file: File): Promise<File> {
  const mime = seeMimeTypeFor(file.name, file.type);
  if (!["image/jpeg", "image/png", "image/webp"].includes(mime) || typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return file; // the server will reject a broken picture with a clear message
  }
  try {
    const scale = Math.min(1, SEE_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size <= 1_500_000) return file;
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return file;
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.86));
    const encoded = blob?.type === "image/webp" ? blob : await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!encoded || encoded.size >= file.size) return file;
    const extension = encoded.type === "image/webp" ? "webp" : "jpg";
    return new File([encoded], `${file.name.replace(/\.[^.]+$/u, "") || "obrazek"}.${extension}`, { type: encoded.type });
  } finally {
    bitmap.close();
  }
}
