import { redirect } from "next/navigation";
import { AuthStatePage } from "../../../components/auth/AuthCard";
import { ReportPage } from "../../../components/support/ReportPage";
import { hasAppAccess } from "../../../domain/hwsApps";
import { getPageAuth } from "../../../lib/auth/pageAuth.server";

export const metadata = {
  title: "Nahlásit chybu | ABF Generator",
};

/**
 * "Nahlásit chybu" of ABF in its own tab (V1-SUPPORT-03) — opened by the application, which stays
 * untouched in the original tab. Every role of ABF (externals too) may report; the support API checks
 * the membership again on every request.
 */
export default async function AbfReportPage() {
  const state = await getPageAuth();
  if (state.status === "unauthenticated") redirect(`/login?next=${encodeURIComponent("/abf/nahlasit")}${state.reason === "expired" ? "&error=expired" : ""}`);
  if (state.status === "inactive") return <AuthStatePage title="Účet je deaktivovaný" message="Váš účet byl deaktivován. Obraťte se na správce HomeworkStudia." />;
  if (state.status === "unavailable") return <AuthStatePage title="Přihlášení nedostupné" message={state.message} showLogout={state.reason !== "config"} />;
  if (!hasAppAccess(state.user, "abf") || !state.user.role) {
    return <AuthStatePage title="Bez přístupu do ABF Generatoru" message="Váš účet nemá povolený ABF Generator. Přístup nastavuje správce HomeworkStudia." backHref="/" />;
  }
  return <ReportPage appKey="abf" appName="ABF Generator" appUrl="/abf" author={state.user.displayName || state.user.email} />;
}
