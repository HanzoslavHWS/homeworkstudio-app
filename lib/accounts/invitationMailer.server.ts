import { resolveAppEnvironment } from "../env/supabaseEnvironment.ts";

/**
 * Invitation e-mail (V1-AUTH-02). Sends ONE message with the one-time set-password link through the
 * company SMTP — only when SMTP is configured; otherwise the administrator hands the link over by
 * hand. The link and the SMTP password are never logged; errors carry only a short, non-secret reason.
 *
 * Configuration (server only, see docs/AUTH_SETUP.md): SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASSWORD,
 * SMTP_FROM, optionally SMTP_SECURE=true (implicit TLS, usually port 465). In development a message
 * goes out only to addresses listed in SMTP_DEV_ALLOWED_RECIPIENTS (e-mails or @domains) — test
 * invitations never reach real people by accident.
 */
export type SmtpEnvironment = Readonly<{
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_USER?: string;
  SMTP_PASSWORD?: string;
  SMTP_FROM?: string;
  SMTP_SECURE?: string;
  SMTP_DEV_ALLOWED_RECIPIENTS?: string;
  NEXT_PUBLIC_APP_ENV?: string;
  NODE_ENV?: string;
}>;

export type MailerState = Readonly<{ configured: true }> | Readonly<{ configured: false; reason: string }>;

export type InvitationMessage = Readonly<{ to: string; displayName: string | null; link: string; appNames: readonly string[]; kind: "invite" | "recovery" }>;

export interface InvitationMailer {
  state(): MailerState;
  /** May this recipient receive a message here (development allow-list)? */
  recipientAllowed(email: string): boolean;
  send(message: InvitationMessage): Promise<void>;
}

export class InvitationSendError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvitationSendError";
  }
}

const env = (): SmtpEnvironment => ({
  SMTP_HOST: process.env.SMTP_HOST,
  SMTP_PORT: process.env.SMTP_PORT,
  SMTP_USER: process.env.SMTP_USER,
  SMTP_PASSWORD: process.env.SMTP_PASSWORD,
  SMTP_FROM: process.env.SMTP_FROM,
  SMTP_SECURE: process.env.SMTP_SECURE,
  SMTP_DEV_ALLOWED_RECIPIENTS: process.env.SMTP_DEV_ALLOWED_RECIPIENTS,
  NEXT_PUBLIC_APP_ENV: process.env.NEXT_PUBLIC_APP_ENV,
  NODE_ENV: process.env.NODE_ENV,
});

/** `hint` = what the administrator does instead (invitations: hand the link over). */
export function smtpState(environment: SmtpEnvironment = env(), hint = " Pozvánku předejte odkazem."): MailerState {
  const missing = (["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM"] as const).filter((name) => !environment[name]?.trim());
  if (missing.length) return { configured: false, reason: `Odesílání e-mailů není nastavené (chybí ${missing.join(", ")}).${hint}` };
  const port = Number(environment.SMTP_PORT);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return { configured: false, reason: "SMTP_PORT není platné číslo portu." };
  return { configured: true };
}

export function recipientAllowedIn(email: string, environment: SmtpEnvironment = env()): boolean {
  if (resolveAppEnvironment(environment) !== "development") return true;
  const allowed = (environment.SMTP_DEV_ALLOWED_RECIPIENTS ?? "").split(",").map((entry) => entry.trim().toLowerCase()).filter(Boolean);
  const address = email.trim().toLowerCase();
  return allowed.some((entry) => (entry.startsWith("@") ? address.endsWith(entry) : address === entry));
}

const escapeHtml = (text: string) => text.replace(/[&<>"']/gu, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

export function invitationText(message: InvitationMessage): Readonly<{ subject: string; text: string; html: string }> {
  const greeting = message.displayName ? `Dobrý den, ${message.displayName},` : "Dobrý den,";
  const apps = message.appNames.length ? message.appNames.join(", ") : "aplikace HomeworkStudio";
  const lead = message.kind === "invite"
    ? `byl Vám založen účet HomeworkStudio s přístupem do: ${apps}.`
    : `posíláme odkaz pro nastavení nového hesla k účtu HomeworkStudio (${apps}).`;
  const subject = message.kind === "invite" ? "Pozvánka do aplikací HomeworkStudio" : "Nastavení hesla — HomeworkStudio";
  const text = `${greeting}\n\n${lead}\n\nHeslo si nastavíte tímto jednorázovým odkazem (platí omezenou dobu):\n${message.link}\n\nPokud jste pozvánku nečekali, e-mail ignorujte.\n\nHomeworkStudio`;
  const html = `<p>${escapeHtml(greeting)}</p><p>${escapeHtml(lead)}</p><p><a href="${escapeHtml(message.link)}">Nastavit heslo</a> — jednorázový odkaz, platí omezenou dobu.</p><p>Pokud jste pozvánku nečekali, e-mail ignorujte.</p><p>HomeworkStudio</p>`;
  return { subject, text, html };
}

type Transport = { sendMail(options: Record<string, unknown>): Promise<unknown> };

export type MailContent = Readonly<{ to: string; subject: string; text: string; html: string }>;

/**
 * One message through the company SMTP (shared by invitations and support notifications). Throws
 * InvitationSendError with a short, non-secret reason; never logs the content or the credentials.
 */
export async function sendSmtpMail(mail: MailContent, environment: SmtpEnvironment = env()): Promise<void> {
  const state = smtpState(environment, "");
  if (state.configured === false) throw new InvitationSendError(state.reason);
  if (!recipientAllowedIn(mail.to, environment)) throw new InvitationSendError("Ve vývoji (DEV) lze posílat jen na adresy ze SMTP_DEV_ALLOWED_RECIPIENTS.");
  const port = Number(environment.SMTP_PORT);
  let transport: Transport;
  try {
    const nodemailer = (await import("nodemailer")) as unknown as { default: { createTransport(options: Record<string, unknown>): Transport } };
    transport = nodemailer.default.createTransport({
      host: environment.SMTP_HOST!.trim(),
      port,
      secure: environment.SMTP_SECURE?.trim() === "true" || port === 465,
      auth: { user: environment.SMTP_USER!.trim(), pass: environment.SMTP_PASSWORD },
      // never log message contents (the link) or credentials
      logger: false,
      debug: false,
    });
  } catch {
    throw new InvitationSendError("Odesílání e-mailů se nepodařilo připravit.");
  }
  try {
    await transport.sendMail({ from: environment.SMTP_FROM!.trim(), to: mail.to, subject: mail.subject, text: mail.text, html: mail.html });
  } catch (error) {
    const code = (error as { code?: string; responseCode?: number } | null) ?? {};
    throw new InvitationSendError(`E-mail se nepodařilo odeslat (${code.code ?? code.responseCode ?? "SMTP"}).`);
  }
}

export const smtpInvitationMailer: InvitationMailer = {
  state: () => smtpState(),
  recipientAllowed: (email) => recipientAllowedIn(email),
  async send(message) {
    const environment = env();
    const state = smtpState(environment);
    if (state.configured === false) throw new InvitationSendError(state.reason);
    await sendSmtpMail({ to: message.to, ...invitationText(message) }, environment);
  },
};

let override: InvitationMailer | undefined;
export function invitationMailer(): InvitationMailer {
  return override ?? smtpInvitationMailer;
}
/** Tests only — records messages instead of sending them. */
export function setInvitationMailerForTesting(mailer: InvitationMailer | undefined): void {
  override = mailer;
}
