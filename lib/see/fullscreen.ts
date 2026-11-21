"use client";

/**
 * Fullscreen for the HWS SEE viewer. Uses the Fullscreen API where it exists (desktop, Android,
 * iPad via the webkit prefix) and otherwise — iPhone Safari has no element fullscreen — a CSS
 * "fill the window" fallback on the same element, closed by the same button or Escape.
 */

type FullscreenCapable = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void };
type FullscreenDocument = Document & { webkitFullscreenElement?: Element | null; webkitExitFullscreen?: () => Promise<void> | void };

export const SEE_FULLSCREEN_FALLBACK_CLASS = "seeFullscreenFallback";

export function nativeFullscreenElement(): Element | null {
  const doc = document as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

/** Resolves once the browser reports a fullscreen change/error, or after `timeoutMs`. */
function nextFullscreenEvent(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const events = ["fullscreenchange", "fullscreenerror", "webkitfullscreenchange", "webkitfullscreenerror"];
    const done = () => {
      events.forEach((name) => document.removeEventListener(name, done));
      window.clearTimeout(timer);
      resolve();
    };
    const timer = window.setTimeout(done, timeoutMs);
    events.forEach((name) => document.addEventListener(name, done));
  });
}

export async function enterFullscreen(element: HTMLElement): Promise<"native" | "fallback"> {
  const target = element as FullscreenCapable;
  try {
    if (typeof target.requestFullscreen === "function" && document.fullscreenEnabled !== false) {
      await target.requestFullscreen();
    } else if (typeof target.webkitRequestFullscreen === "function") {
      // The prefixed API returns nothing and may fail silently (no promise rejection).
      const settled = nextFullscreenEvent(600);
      await target.webkitRequestFullscreen();
      await settled;
    }
  } catch {
    // Refused (iframe without allow="fullscreen", user gesture missing …) → CSS fallback below.
  }
  if (nativeFullscreenElement() === element) return "native";
  element.classList.add(SEE_FULLSCREEN_FALLBACK_CLASS);
  return "fallback";
}

export async function exitFullscreen(element: HTMLElement | null): Promise<void> {
  element?.classList.remove(SEE_FULLSCREEN_FALLBACK_CLASS);
  const doc = document as FullscreenDocument;
  if (!nativeFullscreenElement()) return;
  try {
    if (typeof doc.exitFullscreen === "function") await doc.exitFullscreen();
    else await doc.webkitExitFullscreen?.();
  } catch {
    // already left
  }
}

export function isFullscreen(element: HTMLElement | null): boolean {
  return Boolean(element && (nativeFullscreenElement() === element || element.classList.contains(SEE_FULLSCREEN_FALLBACK_CLASS)));
}
