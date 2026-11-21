"use client";

import { useEffect } from "react";

export type SeeNoticeValue = Readonly<{ kind: "ok" | "error" | "warn"; text: string }>;

/**
 * Result of an action: confirmations disappear by themselves after a few seconds, warnings and
 * errors stay until closed. Announced to screen readers.
 */
export function SeeNotice({ notice, onClose }: Readonly<{ notice: SeeNoticeValue | undefined; onClose: () => void }>) {
  useEffect(() => {
    if (notice?.kind !== "ok") return undefined;
    const timer = window.setTimeout(onClose, 6000);
    return () => window.clearTimeout(timer);
  }, [notice, onClose]);
  if (!notice) return null;
  const className = notice.kind === "ok" ? "seeBannerOk" : notice.kind === "warn" ? "seeBannerWarn" : "seeBannerError";
  return (
    <div className={`seeBanner ${className} seeNotice`} role={notice.kind === "error" ? "alert" : "status"} aria-live={notice.kind === "error" ? "assertive" : "polite"}>
      <span>{notice.kind === "ok" ? "✓ " : notice.kind === "error" ? "Chyba: " : ""}{notice.text}</span>
      <button type="button" className="seeNoticeClose" onClick={onClose} aria-label="Zavřít zprávu">×</button>
    </div>
  );
}
