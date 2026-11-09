"use client";

import type { ReactNode } from "react";
import type { AppRole } from "../../domain/accessControl";
import { adminAreasFor, normalizeAdminRoute, workspaceHash, type AdminRoute } from "../../domain/adminNavigation";

/**
 * Společná administrace (V1-ADMIN-01): one frame — title, areas (Katalog, Ceníky, Veletrhy,
 * Realizační firmy, Uživatelé) and the tabs of the open area — around the EXISTING admin screens.
 * Only areas the role may manage are offered; the API checks every request anyway. Links carry the
 * real address (/abf#/administrace/…), so they also open in a new tab and survive a reload.
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
    <div className="adminShell">
      <header className="adminShellHeader">
        <span className="adminShellEyebrow">ADMINISTRACE</span>
        <nav className="adminTabs adminAreaTabs" aria-label="Oblasti administrace">
          {areas.map((candidate) => {
            const target = normalizeAdminRoute({ area: candidate.id });
            const active = candidate.id === current.area;
            return (
              <a key={candidate.id} href={workspaceHash({ section: "admin", admin: target })} className={active ? "adminTab active" : "adminTab"} aria-current={active ? "page" : undefined} onClick={follow(target)}>
                {candidate.label}
              </a>
            );
          })}
        </nav>
        {area && area.tabs.length > 0 && (
          <nav className="adminTabs adminSubTabs" aria-label={`${area.label} — části`}>
            {(area.tabs as readonly { id: string; label: string }[]).map((tab) => {
              const target = { area: area.id, tab: tab.id } as AdminRoute;
              const active = tab.id === current.tab;
              return (
                <a key={tab.id} href={workspaceHash({ section: "admin", admin: target })} className={active ? "adminSubTab active" : "adminSubTab"} aria-current={active ? "page" : undefined} onClick={follow(target)}>
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
