"use client";

import type { PrintSurfaceProject } from "../../domain/printSurfaceProject.ts";
import type { PrintSurfaceProjectRepository } from "./printSurfaceProjectRepository.ts";

const STORAGE_KEY = "homeworkstudio.printSurfaceProject.v1";

/**
 * Client-side-only persistence for the "Tiskové plochy" MVP (spec section 11: no DB migration for
 * this first phase). Stores the single working draft project as JSON, image included as a data
 * URL — see PrintSurfaceProjectImage. Thrown quota/parse errors are surfaced to the caller so the
 * page can show a banner rather than silently losing work.
 */
export class LocalStoragePrintSurfaceProjectRepository implements PrintSurfaceProjectRepository {
  async load(): Promise<PrintSurfaceProject | null> {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PrintSurfaceProject;
    } catch {
      return null;
    }
  }

  async save(project: PrintSurfaceProject): Promise<void> {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(project));
    } catch {
      throw new Error("Uložení do prohlížeče se nezdařilo — obrázek je pravděpodobně příliš velký.");
    }
  }

  async clear(): Promise<void> {
    if (typeof window === "undefined") return;
    window.localStorage.removeItem(STORAGE_KEY);
  }
}
