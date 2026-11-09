import { redirect } from "next/navigation";
import { safeReturnPath } from "../../domain/accessControl";
import { AuthCard } from "../../components/auth/AuthCard";
import { LoginForm } from "../../components/auth/AuthForms";
import { getPageAuth } from "../../lib/auth/pageAuth.server";

export const metadata = {
  title: "Homework Studio | Přihlášení",
};

type LoginPageProps = {
  searchParams: Promise<{ error?: string; next?: string; status?: string }>;
};

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  invalid: "E-mail nebo heslo není správné.",
  inactive: "Účet je deaktivovaný. Obraťte se na správce.",
  no_access: "Tento účet nemá přístup do aplikace. Obraťte se na správce.",
  unconfirmed: "Účet ještě není aktivovaný — použijte odkaz z pozvánky.",
  rate_limited: "Příliš mnoho pokusů o přihlášení. Zkuste to za několik minut.",
  config: "Přihlášení není na serveru nakonfigurované. Kontaktujte správce.",
  migration: "Databáze nemá tabulky přihlášení (chybí migrace). Kontaktujte správce.",
  unavailable: "Služba přihlášení je dočasně nedostupná. Zkuste to znovu.",
  link_invalid: "Odkaz je neplatný, vypršel nebo už byl použit. Požádejte o nový.",
  expired: "Přihlášení vypršelo. Přihlaste se znovu.",
};

const STATUS_MESSAGES: Readonly<Record<string, string>> = {
  logged_out: "Byli jste odhlášeni.",
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const query = await searchParams;
  const next = safeReturnPath(query.next);
  const state = await getPageAuth();
  if (state.status === "authenticated") redirect(next);

  const configProblem = state.status === "unavailable" ? state.message : undefined;
  const error = configProblem ?? (query.error ? ERROR_MESSAGES[query.error] ?? "Přihlášení se nezdařilo." : state.status === "inactive" ? ERROR_MESSAGES.inactive : undefined);
  const status = query.status ? STATUS_MESSAGES[query.status] : undefined;

  return (
    <AuthCard title="Přihlášení" lead="Přihlaste se e-mailem a heslem. Účty zakládá správce aplikace.">
      {status && !error && <div className="loginNotice" role="status">{status}</div>}
      <LoginForm next={next} initialError={error} />
    </AuthCard>
  );
}
