import { AuthCard } from "../../../components/auth/AuthCard";
import { ForgotPasswordForm } from "../../../components/auth/AuthForms";

export const metadata = {
  title: "Homework Studio | Zapomenuté heslo",
};

export default function ForgotPasswordPage() {
  return (
    <AuthCard title="Zapomenuté heslo" lead="Zadejte e-mail svého účtu. Pokud účet existuje a je aktivní, pošleme na něj odkaz pro nastavení nového hesla.">
      <ForgotPasswordForm />
    </AuthCard>
  );
}
