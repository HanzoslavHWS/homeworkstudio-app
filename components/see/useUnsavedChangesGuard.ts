"use client";

import { useEffect } from "react";

/**
 * Protects unsaved editor changes:
 * - closing / reloading the tab or leaving to another site → the browser's own confirmation;
 * - clicking any in-app link (Next <Link>, menu, "← Projekty", "Portál") → a confirm dialog,
 *   handled in the capture phase before the client-side router navigates.
 * The browser Back button inside the app cannot be blocked reliably in the Next.js App Router;
 * that case is covered by the draft backup (useDraftBackup).
 */
export function useUnsavedChangesGuard(active: boolean, message = "Máte neuložené změny. Opravdu chcete editor opustit? Změny se ztratí.") {
  useEffect(() => {
    if (!active) return undefined;
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin === window.location.origin && destination.pathname === window.location.pathname && destination.search === window.location.search) return;
      if (!window.confirm(message)) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    document.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload);
      document.removeEventListener("click", onClick, true);
    };
  }, [active, message]);
}

const DRAFT_PREFIX = "hws-see-draft:";

export type StoredDraft<T> = Readonly<{ baseUpdatedAt: string; savedAt: string; draft: T }>;

/** Per-viewer convenience only: may be unavailable (private mode, blocked storage) — never required. */
export function readDraftBackup<T>(projectId: string): StoredDraft<T> | undefined {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_PREFIX + projectId);
    return raw ? JSON.parse(raw) as StoredDraft<T> : undefined;
  } catch {
    return undefined;
  }
}

export function writeDraftBackup<T>(projectId: string, value: StoredDraft<T>): void {
  try {
    window.sessionStorage.setItem(DRAFT_PREFIX + projectId, JSON.stringify(value));
  } catch {
    // storage full or blocked — the in-page guard still protects the changes
  }
}

export function clearDraftBackup(projectId: string): void {
  try {
    window.sessionStorage.removeItem(DRAFT_PREFIX + projectId);
  } catch {
    // ignore
  }
}
