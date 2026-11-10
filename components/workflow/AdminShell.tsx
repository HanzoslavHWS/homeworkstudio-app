"use client";

import type { ReactNode } from "react";
import { cn } from "cn";
import type { AppRole } from "../../domain/accessControl";
import { adminAreasFor, normalizeAdminRoute, workspaceHash, type AdminRoute } from "../../domain/adminNavigation";

/**
 * Společná administrace (V1-ADMIN-01): one frame — title, areas (Katalog, Ceníky, Veletrhy,
 * Realizační firmy, Uživatelé) and the tabs of the open area — around the admin screens.
 * Only areas the role may manage are offered; the API checks every request anyway. Links carry the
 * real address (/abf#/administrace/…), so they also open in a new tab and survive a reload.
 *
 * SHAD-01: the frame is the root of the shadcn/ui region (data-ui) — the scoped base styles and the
 * theme tokens of app/app.css apply inside it, the legacy bare-element rules do not.
 */
export function AdminShell({ role, route, onNavigate, children }: Readonly<{ role: AppRole | undefined; route: AdminRoute; onNavigate: (route: AdminRoute) => void; children: ReactNode }>) {
  const areas = adminAreasFor(role);
  const current = normalizeAdminRoute(route);
  const area = areas.find((candidate) => candidate.id === current.area);
  const follow = (next: AdminRoute) => (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    onNavigate(next);
  };
  return (
    <div data-ui="admin" className="adminShell mx-auto w-full max-w-[1600px] px-4 pt-6 pb-16 text-foreground sm:px-8 lg:px-12">
      <header className="mb-6">
        <p className="mb-3 text-xs font-bold tracking-[0.18em] text-muted-foreground uppercase">Administrace</p>
        <nav className="adminAreaTabs -mx-1 flex gap-1 overflow-x-auto border-b px-1" aria-label="Oblasti administrace">
          {areas.map((candidate) => {
            const target = normalizeAdminRoute({ area: candidate.id });
            const active = candidate.id === current.area;
            return (
              <a
                key={candidate.id}
                href={workspaceHash({ section: "admin", admin: target })}
                aria-current={active ? "page" : undefined}
                onClick={follow(target)}
                className={cn(
                  "-mb-px shrink-0 rounded-t-md border-b-2 px-3 py-2.5 text-[15px] font-semibold whitespace-nowrap no-underline transition-colors",
                  active ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
                )}
              >
                {candidate.label}
              </a>
            );
          })}
        </nav>
        {area && area.tabs.length > 0 && (
          <nav className="adminSubTabs mt-3 flex gap-2 overflow-x-auto pb-1" aria-label={`${area.label} — části`}>
            {(area.tabs as readonly { id: string; label: string }[]).map((tab) => {
              const target = { area: area.id, tab: tab.id } as AdminRoute;
              const active = tab.id === current.tab;
              return (
                <a
                  key={tab.id}
                  href={workspaceHash({ section: "admin", admin: target })}
                  aria-current={active ? "page" : undefined}
                  onClick={follow(target)}
                  className={cn(
                    "inline-flex h-9 shrink-0 items-center rounded-full border px-4 text-sm font-medium whitespace-nowrap no-underline transition-colors",
                    active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground hover:bg-muted",
                  )}
                >
                  {tab.label}
                </a>
              );
            })}
          </nav>
        )}
      </header>
      <div className="adminShellBody">{children}</div>
    </div>
  );
}
