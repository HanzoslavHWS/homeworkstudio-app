import { AuthCard } from "../../../components/auth/AuthCard";
import { AuthCallbackHandler } from "../../../components/auth/AuthForms";

export const metadata = {
  title: "Homework Studio | Ověření odkazu",
};

export default function AuthCallbackPage() {
  return (
    <AuthCard title="Ověření odkazu">
      <AuthCallbackHandler />
    </AuthCard>
  );
}
