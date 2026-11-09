import type { ReactNode } from "react";

/** The shared card of every sign-in / account-state page (same look as the original login). */
export function AuthCard({ title, lead, children }: Readonly<{ title: string; lead?: string; children: ReactNode }>) {
  return (
    <main className="loginPage">
      <section className="loginCard">
        <div className="loginBrand">
          <span>HOMEWORK</span>
          <strong>STUDIO</strong>
        </div>
        <span className="eyebrow">INTERNÍ APLIKACE</span>
        <h1>{title}</h1>
        {lead && <p>{lead}</p>}
        {children}
      </section>
    </main>
  );
}

/** Signed in, but no access to this page (inactive account, missing configuration, …) — with a way out. */
export function AuthStatePage({ title, message, showLogout = true }: Readonly<{ title: string; message: string; showLogout?: boolean }>) {
  return (
    <AuthCard title={title}>
      <div className="loginForm">
        <div className="loginMessage" role="alert">{message}</div>
        {showLogout && (
          <form action="/api/auth/logout" method="post">
            <button type="submit" className="loginSecondary">Odhlásit se</button>
          </form>
        )}
      </div>
    </AuthCard>
  );
}
