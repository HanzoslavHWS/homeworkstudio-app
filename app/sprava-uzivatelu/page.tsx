import { redirect } from "next/navigation";
import { AccountsAdminPage } from "../../components/accounts/AccountsAdminPage";
import { AuthStatePage } from "../../components/auth/AuthCard";
import { canManageAccounts } from "../../domain/hwsApps";
import { currentUserOf, getPageAuth } from "../../lib/auth/pageAuth.server";

export const metadata = {
  title: "Homework Studio | Správa uživatelů",
};

/**
 * Správa uživatelů HomeworkStudio (V1-AUTH-02) — shared accounts and access to the applications.
 * Only for the shared administrators (app_users.is_hws_admin); an ABF administrator without that flag
 * is refused here and by every /api/hws/accounts call.
 */
export default async function AccountsAdministrationPage() {
  const state = await getPageAuth();
  if (state.status === "unauthenticated") redirect(`/login?next=${encodeURIComponent("/sprava-uzivatelu")}${state.reason === "expired" ? "&error=expired" : ""}`);
  if (state.status === "inactive") return <AuthStatePage title="Účet je deaktivovaný" message="Váš účet byl deaktivován. Obraťte se na správce HomeworkStudia." />;
  if (state.status === "unavailable") return <AuthStatePage title="Přihlášení nedostupné" message={state.message} showLogout={state.reason !== "config"} />;
  if (!canManageAccounts(state.user)) return <AuthStatePage title="Bez oprávnění" message="Správu uživatelů HomeworkStudia smí otevřít jen její správce." backHref="/" />;
  return <AccountsAdminPage currentUser={currentUserOf(state.user)} />;
}
