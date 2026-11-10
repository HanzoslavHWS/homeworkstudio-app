import { redirect } from "next/navigation";
import { Launcher } from "../components/Launcher";
import { AuthStatePage } from "../components/auth/AuthCard";
import { currentUserOf, getPageAuth } from "../lib/auth/pageAuth.server";

export const metadata = {
  title: "Homework Studio | Launcher",
};

/** Rozcestník HomeworkStudio — every active account; the cards follow its memberships (V1-AUTH-02). */
export default async function Home() {
  const state = await getPageAuth();
  if (state.status === "unauthenticated") redirect(state.reason === "expired" ? "/login?error=expired" : "/login");
  if (state.status === "inactive") return <AuthStatePage title="Účet je deaktivovaný" message="Váš účet byl deaktivován. Obraťte se na správce HomeworkStudia." />;
  if (state.status === "unavailable") return <AuthStatePage title="Přihlášení nedostupné" message={state.message} showLogout={state.reason !== "config"} />;
  return <Launcher user={currentUserOf(state.user)} />;
}
