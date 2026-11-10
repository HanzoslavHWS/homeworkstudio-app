import { redirect } from "next/navigation";
import BoothGenerator from "../../components/BoothGenerator";
import { AuthStatePage } from "../../components/auth/AuthCard";
import { ExternalProjectsPage } from "../../components/auth/ExternalProjectsPage";
import { hasAppAccess } from "../../domain/hwsApps";
import { currentUserOf, getPageAuth } from "../../lib/auth/pageAuth.server";

export const metadata = {
  title: "Homework Studio | ABF Generator",
};

export default async function AbfGeneratorPage() {
  const state = await getPageAuth();
  if (state.status === "unauthenticated") redirect(`/login?next=${encodeURIComponent("/abf")}${state.reason === "expired" ? "&error=expired" : ""}`);
  if (state.status === "inactive") return <AuthStatePage title="Účet je deaktivovaný" message="Váš účet byl deaktivován. Obraťte se na správce HomeworkStudia." />;
  if (state.status === "unavailable") return <AuthStatePage title="Přihlášení nedostupné" message={state.message} showLogout={state.reason !== "config"} />;
  // V1-AUTH-02: ABF needs an ABF membership — the same rule every ABF API route applies.
  if (!hasAppAccess(state.user, "abf") || !state.user.role) {
    return <AuthStatePage title="Bez přístupu do ABF Generatoru" message="Váš účet nemá povolený ABF Generator. Přístup nastavuje správce HomeworkStudia. Ostatní aplikace najdete na rozcestníku." backHref="/" />;
  }
  const user = currentUserOf(state.user);
  // Externí účet vidí jen své přidělené zakázky — generátor ani globální data ne.
  if (state.user.role === "external") return <ExternalProjectsPage user={user} />;
  return <BoothGenerator currentUser={user} />;
}
