"use client";

import { useEffect } from "react";
import type { CurrentUser } from "../../lib/auth/pageAuth.server";

const REFRESH_INTERVAL_MS = 20 * 60 * 1000;

/**
 * Signed-in user + "Odhlásit se", and the session keep-alive (V1-AUTH-01): /api/auth/session renews
 * the sliding session while the app is open (on focus and every 20 minutes). An expired / revoked
 * session sends the user to the login page with a return to the current page; a deactivated account
 * reloads into the "účet deaktivován" page. Display only — the server decides every request anyway.
 */
export function UserMenu({ user, roleLabel, variant = "light", compact = false, showLogout = true }: Readonly<{ user: CurrentUser; roleLabel: string; variant?: "light" | "dark"; compact?: boolean; showLogout?: boolean }>) {
  useEffect(() => {
    let stopped = false;
    async function refresh() {
      try {
        const response = await fetch("/api/auth/session", { credentials: "same-origin", headers: { Accept: "application/json" } });
        if (stopped) return;
        if (response.status === 401) {
          const next = `${window.location.pathname}${window.location.search}`;
          window.location.assign(`/login?error=expired&next=${encodeURIComponent(next)}`);
        } else if (response.status === 403) {
          window.location.reload();
        }
      } catch {
        // offline — the next request decides
      }
    }
    const timer = window.setInterval(refresh, REFRESH_INTERVAL_MS);
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return (
    <div className={`userMenu userMenu--${variant}${compact ? " userMenu--compact" : ""}`}>
      <span className="userMenuIdentity" title={user.email}>
        <strong>{user.displayName || user.email}</strong>
        <span>{roleLabel}</span>
      </span>
      {showLogout && (
        <form action="/api/auth/logout" method="post">
          <button type="submit" className="userMenuLogout" title="Odhlásit se">{compact ? "⎋" : "Odhlásit se"}</button>
        </form>
      )}
    </div>
  );
}
