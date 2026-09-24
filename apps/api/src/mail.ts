/**
 * Mail (spec §8 `PERCH_SMTP_URL`): invite and password-reset links, sent over SMTP when the
 * instance has a mail server, and never written to a log (spec §1.6: the links carry tokens).
 *
 * Built from the environment where it is needed rather than wired through the app's deps, so the
 * two callers — better-auth's reset hook and the invite route — share one transport per URL.
 * Without PERCH_SMTP_URL nothing is sent: an invite's link is still returned to the inviter to
 * share by hand, and a password reset is recorded as requested but not delivered (ADR-0172).
 */
import { createTransport } from "nodemailer";
import type { Logger } from "pino";
import type { Env } from "./env.ts";

export type MailMessage = { to: string; subject: string; text: string };

export type Mailer = {
  /** Whether a mail server is configured at all. */
  readonly configured: boolean;
  /**
   * Sends one message. Resolves true once the server accepted it, false when there is no server or
   * it refused; never rejects. The message itself is never logged, because its links carry tokens.
   */
  send(message: MailMessage): Promise<boolean>;
};

/** The part of a nodemailer transport this module uses. */
type Transport = {
  sendMail(options: MailMessage & { from: string }): Promise<unknown>;
};

const transports = new Map<string, Transport>();

function transportFor(url: string): Transport {
  const existing = transports.get(url);
  if (existing) return existing;
  const created: Transport = createTransport(url);
  transports.set(url, created);
  return created;
}

/** The From address: PERCH_SMTP_FROM, or a no-reply address on the instance's own host. */
export function senderOf(env: Pick<Env, "smtpFrom" | "publicUrl">): string {
  return env.smtpFrom ?? `Perch <no-reply@${new URL(env.publicUrl).hostname}>`;
}

export function mailerFor(
  env: Pick<Env, "smtpUrl" | "smtpFrom" | "publicUrl">,
  log: Logger,
  transport: (url: string) => Transport = transportFor,
): Mailer {
  const url = env.smtpUrl;
  if (!url) {
    return {
      configured: false,
      async send(message) {
        log.warn(
          { to: message.to, subject: message.subject },
          "mail not sent: no mail server is configured (PERCH_SMTP_URL)",
        );
        return false;
      },
    };
  }
  const from = senderOf(env);
  return {
    configured: true,
    async send(message) {
      try {
        await transport(url).sendMail({ from, ...message });
        return true;
      } catch (error) {
        log.error({ err: error, to: message.to, subject: message.subject }, "sending mail failed");
        return false;
      }
    },
  };
}

/** What Perch sends, in one place (English only, like the rest of the server's own text). */
export const MAIL = {
  passwordReset(url: string): Omit<MailMessage, "to"> {
    return {
      subject: "Reset your Perch password",
      text: [
        "Someone asked to reset the password for this Perch account.",
        "",
        `To choose a new password, open this link within the hour: ${url}`,
        "",
        "If it was not you, ignore this message: your password stays as it is.",
      ].join("\n"),
    };
  },
  invite(input: { workspace: string; inviter: string; role: string; url: string }) {
    return {
      subject: `${input.inviter} invited you to ${input.workspace} on Perch`,
      text: [
        `${input.inviter} invited you to join ${input.workspace} as ${input.role}.`,
        "",
        `Accept the invite: ${input.url}`,
        "",
        "The link works once and expires in seven days.",
      ].join("\n"),
    } satisfies Omit<MailMessage, "to">;
  },
} as const;
