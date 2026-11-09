import { redirect } from "next/navigation";
import { Launcher } from "../components/Launcher";
import { AuthStatePage } from "../components/auth/AuthCard";
import { ExternalProjectsPage } from "../components/auth/ExternalProjectsPage";
import { getPageAuth } from "../lib/auth/pageAuth.server";

export const metadata = {
  title: "Homework Studio | Launcher",
};

export default async function Home() {
  const state = await getPageAuth();
  if (state.status === "unauthenticated") redirect(state.reason === "expired" ? "/login?error=expired" : "/login");
  if (state.status === "inactive") return <AuthStatePage title="Účet je deaktivovaný" message="Váš účet byl deaktivován. Obraťte se na správce aplikace." />;
  if (state.status === "unavailable") return <AuthStatePage title="Přihlášení nedostupné" message={state.message} showLogout={state.reason !== "config"} />;
  const user = { id: state.user.id, email: state.user.email, displayName: state.user.displayName, role: state.user.role };
  if (user.role === "external") return <ExternalProjectsPage user={user} />;
  return <Launcher user={user} />;
}
