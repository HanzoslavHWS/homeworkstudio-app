import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import {
  AUTH_COOKIE_NAME,
  verifySessionToken,
} from "../../lib/auth/session";

type LoginPageProps = {
  searchParams: Promise<{
    error?: string;
    next?: string;
  }>;
};

export default async function LoginPage({ searchParams }: LoginPageProps) {
  const query = await searchParams;
  const cookieStore = await cookies();
  const sessionValid = await verifySessionToken(
    cookieStore.get(AUTH_COOKIE_NAME)?.value,
    process.env.APP_SESSION_SECRET,
  );
  if (sessionValid) {
    redirect("/");
  }

  const message =
    query.error === "invalid"
      ? "Zadané heslo není správné."
      : query.error === "config"
        ? "Přihlášení zatím není na serveru nakonfigurované."
        : "";

  return (
    <main className="loginPage">
      <section className="loginCard">
        <div className="loginBrand">
          <span>HOMEWORK</span>
          <strong>STUDIO</strong>
        </div>

        <span className="eyebrow">INTERNÍ APLIKACE</span>
        <h1>Booth Generator</h1>
        <p>Pro pokračování zadejte přístupové heslo.</p>

        <form action="/api/auth/login" method="post" className="loginForm">
          <input type="hidden" name="next" value={query.next || "/"} />
          <label>
            <span>Heslo</span>
            <input
              type="password"
              name="password"
              autoComplete="current-password"
              required
              autoFocus
            />
          </label>

          {message && <div className="loginMessage">{message}</div>}

          <button type="submit">Přihlásit se</button>
        </form>
      </section>
    </main>
  );
}
