"use client";

import { useCallback, useEffect, useState } from "react";
import type { SupportRole } from "../../domain/support";
import { supportApi } from "../../lib/support/supportClient";

/** `notifications` only for managers: whether support e-mails go out (SMTP configured). */
export type SupportSummary = Readonly<{ role: SupportRole; newTickets: number; waitingForMe: number; notifications?: Readonly<{ active: boolean; reason?: string }> }>;

/** Badge counts of Nápověda a podpora — refreshed on focus, every two minutes and after a change. */
export function useSupportSummary(appKey: string, enabled: boolean) {
  const [summary, setSummary] = useState<SupportSummary | null>(null);
  const refresh = useCallback(() => {
    if (!enabled) return;
    supportApi<SupportSummary>("summary", { query: { app: appKey } }).then(setSummary, () => undefined);
  }, [appKey, enabled]);
  useEffect(() => {
    refresh();
    const timer = window.setInterval(refresh, 120_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  return { summary, refresh };
}
