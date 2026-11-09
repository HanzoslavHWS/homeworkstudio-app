import { redirect } from "next/navigation";
import BoothGenerator from "../../components/BoothGenerator";
import { AuthStatePage } from "../../components/auth/AuthCard";
import { getPageAuth } from "../../lib/auth/pageAuth.server";

export const metadata = {
  title: "Homework Studio | ABF Generator",
};

export default async function AbfGeneratorPage() {
  const state = await getPageAuth();
  if (state.status === "unauthenticated") redirect(`/login?next=${encodeURIComponent("/abf")}${state.reason === "expired" ? "&error=expired" : ""}`);
  if (state.status === "inactive") return <AuthStatePage title="Účet je deaktivovaný" message="Váš účet byl deaktivován. Obraťte se na správce aplikace." />;
  if (state.status === "unavailable") return <AuthStatePage title="Přihlášení nedostupné" message={state.message} showLogout={state.reason !== "config"} />;
  // Externí účet vidí jen své přidělené projekty (úvodní stránka) — generátor ani globální data ne.
  if (state.user.role === "external") redirect("/");
  return <BoothGenerator currentUser={{ id: state.user.id, email: state.user.email, displayName: state.user.displayName, role: state.user.role }} />;
}
