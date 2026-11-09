"use client";

import { useEffect, useState, type FormEvent } from "react";

/**
 * Client forms of the sign-in pages (V1-AUTH-01): loading and error states, JSON calls to
 * /api/auth/*. Every form also works as a plain HTML form post (no JavaScript) where it makes sense.
 * A result is shown only from the server's answer — nothing is presented as done before it is.
 */
type ApiAnswer = { ok?: boolean; redirectTo?: string; error?: string; message?: string; code?: string };

async function postJson(url: string, body: Record<string, unknown>): Promise<{ status: number; answer: ApiAnswer }> {
  try {
    const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: JSON.stringify(body), credentials: "same-origin" });
    const answer = (await response.json().catch(() => ({}))) as ApiAnswer;
    return { status: response.status, answer };
  } catch {
    return { status: 0, answer: { error: "Server neodpověděl. Zkontrolujte připojení a zkuste to znovu.", code: "network" } };
  }
}

export function LoginForm({ next, initialError }: Readonly<{ next: string; initialError?: string }>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(initialError ?? "");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    const { answer } = await postJson("/api/auth/login", { email: form.get("email"), password: form.get("password"), next });
    if (answer.ok && answer.redirectTo) {
      window.location.assign(answer.redirectTo);
      return;
    }
    setPending(false);
    setError(answer.error ?? "Přihlášení se nezdařilo.");
  }

  return (
    <form action="/api/auth/login" method="post" className="loginForm" onSubmit={submit} aria-busy={pending}>
      <input type="hidden" name="next" value={next} />
      <label>
        <span>E-mail</span>
        <input type="email" name="email" autoComplete="username" required autoFocus disabled={pending} />
      </label>
      <label>
        <span>Heslo</span>
        <input type="password" name="password" autoComplete="current-password" required disabled={pending} />
      </label>
      {error && <div className="loginMessage" role="alert">{error}</div>}
      <button type="submit" disabled={pending}>{pending ? "Přihlašuji…" : "Přihlásit se"}</button>
      <a className="loginLink" href="/login/zapomenute-heslo">Zapomenuté heslo</a>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setPending(true);
    setError("");
    const { answer } = await postJson("/api/auth/password/forgot", { email: form.get("email") });
    setPending(false);
    if (answer.ok) setDone(answer.message ?? "Odkaz byl odeslán.");
    else setError(answer.error ?? "Odkaz se nepodařilo odeslat.");
  }

  if (done) {
    return (
      <div className="loginForm">
        <div className="loginNotice" role="status">{done}</div>
        <a className="loginLink" href="/login">Zpět na přihlášení</a>
      </div>
    );
  }
  return (
    <form className="loginForm" onSubmit={submit} aria-busy={pending}>
      <label>
        <span>E-mail účtu</span>
        <input type="email" name="email" autoComplete="username" required autoFocus disabled={pending} />
      </label>
      {error && <div className="loginMessage" role="alert">{error}</div>}
      <button type="submit" disabled={pending}>{pending ? "Odesílám…" : "Poslat odkaz pro nové heslo"}</button>
      <a className="loginLink" href="/login">Zpět na přihlášení</a>
    </form>
  );
}

export function SetPasswordForm({ minLength }: Readonly<{ minLength: number }>) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get("password") ?? "");
    if (password !== String(form.get("confirm") ?? "")) {
      setError("Hesla se neshodují.");
      return;
    }
    setPending(true);
    setError("");
    const { answer } = await postJson("/api/auth/password/set", { password });
    if (answer.ok && answer.redirectTo) {
      window.location.assign(answer.redirectTo);
      return;
    }
    setPending(false);
    setError(answer.error ?? "Heslo se nepodařilo nastavit.");
  }

  return (
    <form className="loginForm" onSubmit={submit} aria-busy={pending}>
      <label>
        <span>Nové heslo (alespoň {minLength} znaků)</span>
        <input type="password" name="password" autoComplete="new-password" minLength={minLength} required autoFocus disabled={pending} />
      </label>
      <label>
        <span>Nové heslo znovu</span>
        <input type="password" name="confirm" autoComplete="new-password" minLength={minLength} required disabled={pending} />
      </label>
      {error && <div className="loginMessage" role="alert">{error}</div>}
      <button type="submit" disabled={pending}>{pending ? "Ukládám…" : "Nastavit heslo a přihlásit se"}</button>
    </form>
  );
}

/**
 * /auth/callback — the default Supabase e-mail link lands here with the result in the URL fragment
 * (#access_token=…&type=recovery, or #error=…). The fragment never reaches the server on its own;
 * this page hands the one-time token to /api/auth/callback and removes it from the address bar.
 */
export function AuthCallbackHandler() {
  const [message, setMessage] = useState("Ověřuji odkaz…");
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const hash = new URLSearchParams(window.location.hash.replace(/^#/u, ""));
    const query = new URLSearchParams(window.location.search);
    window.history.replaceState(null, "", window.location.pathname);
    const linkError = hash.get("error_description") ?? query.get("error_description") ?? hash.get("error") ?? query.get("error");
    if (linkError) {
      setFailed(true);
      setMessage(/expired|vypr/iu.test(linkError) ? "Odkaz vypršel. Požádejte o nový." : "Odkaz je neplatný nebo už byl použit. Požádejte o nový.");
      return;
    }
    const tokenHash = query.get("token_hash");
    const type = query.get("type") ?? hash.get("type");
    if (tokenHash && type) {
      window.location.replace(`/auth/confirm?token_hash=${encodeURIComponent(tokenHash)}&type=${encodeURIComponent(type)}`);
      return;
    }
    const accessToken = hash.get("access_token");
    if (!accessToken || !type) {
      setFailed(true);
      setMessage("Odkaz je neúplný. Otevřete ho prosím celý z e-mailu, nebo požádejte o nový.");
      return;
    }
    void postJson("/api/auth/callback", { accessToken, type }).then(({ answer }) => {
      if (answer.ok && answer.redirectTo) window.location.replace(answer.redirectTo);
      else {
        setFailed(true);
        setMessage(answer.error ?? "Odkaz se nepodařilo ověřit.");
      }
    });
  }, []);

  return (
    <div className="loginForm">
      <div className={failed ? "loginMessage" : "loginNotice"} role={failed ? "alert" : "status"}>{message}</div>
      {failed && <a className="loginLink" href="/login/zapomenute-heslo">Požádat o nový odkaz</a>}
    </div>
  );
}
