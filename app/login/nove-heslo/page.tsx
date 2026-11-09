import { cookies } from "next/headers";
import { AuthCard } from "../../../components/auth/AuthCard";
import { SetPasswordForm } from "../../../components/auth/AuthForms";
import { PASSWORD_SETUP_COOKIE_NAME, readPasswordSetupToken } from "../../../lib/auth/session";
import { PASSWORD_MIN_LENGTH } from "../../../lib/auth/supabaseAuth.server";

export const metadata = {
  title: "Homework Studio | Nastavení hesla",
};

export default async function SetPasswordPage() {
  const cookieStore = await cookies();
  const grant = await readPasswordSetupToken(cookieStore.get(PASSWORD_SETUP_COOKIE_NAME)?.value, process.env.APP_SESSION_SECRET);
  if (!grant) {
    return (
      <AuthCard title="Nastavení hesla">
        <div className="loginForm">
          <div className="loginMessage" role="alert">Odkaz pro nastavení hesla chybí nebo vypršel (platí 15 minut od otevření). Požádejte o nový.</div>
          <a className="loginLink" href="/login/zapomenute-heslo">Požádat o nový odkaz</a>
          <a className="loginLink" href="/login">Zpět na přihlášení</a>
        </div>
      </AuthCard>
    );
  }
  return (
    <AuthCard title={grant.kind === "invite" ? "Vítejte" : "Nové heslo"} lead={grant.kind === "invite" ? "Nastavte si heslo ke svému účtu. Potom budete přihlášeni." : "Zvolte nové heslo. Všechna dosavadní přihlášení k účtu se ukončí."}>
      <SetPasswordForm minLength={PASSWORD_MIN_LENGTH} />
    </AuthCard>
  );
}
