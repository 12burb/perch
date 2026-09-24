/**
 * better-auth (spec §2, §7.1 /api/auth/*): email + password, passkeys, generic OIDC, with the Drizzle
 * adapter over the auth_* tables. A Perch `users` profile row is created for every auth user
 * (databaseHooks). Passkeys use the instance's public origin as rpID/origin.
 */
import { passkey } from "@better-auth/passkey";
import { authSchema, type DbHandle } from "@perch/db";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import type { Logger } from "pino";
import type { Env } from "../env.ts";
import { MAIL, mailerFor } from "../mail.ts";
import { ensureProfile } from "../services/users.ts";
import { trustedOrigins } from "./edge.ts";

export type CreateAuthOptions = { env: Env; db: DbHandle; log: Logger };

export function createAuth(options: CreateAuthOptions) {
  const { env, db, log } = options;
  const origin = new URL(env.publicUrl);
  const mailer = mailerFor(env, log);

  return betterAuth({
    appName: "Perch",
    baseURL: env.publicUrl,
    basePath: "/api/auth",
    secret: env.sessionSecret,
    database: drizzleAdapter(db.db, { provider: "pg", schema: authSchema }),
    trustedOrigins: [...trustedOrigins(env)],
    logger: {
      disabled: env.logLevel === "silent",
      disableColors: true,
      // better-auth's own lines ride the pino logger so they carry the same redaction and format.
      log: (level, message, ...args) => {
        const fields = args.length > 0 ? { better_auth: args } : {};
        log[level](fields, `[better-auth] ${message}`);
      },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: 10,
      sendResetPassword: async ({ user, url }) => {
        // The link goes by mail (PERCH_SMTP_URL) and nowhere else: it carries a reset token, so
        // it never reaches a log line (spec §1.6, ADR-0172), whether or not mail is configured.
        const sent = await mailer.send({ to: user.email, ...MAIL.passwordReset(url) });
        log.info({ email: user.email, sent }, "password reset requested");
      },
    },
    session: {
      cookieCache: { enabled: true, maxAge: 5 * 60 },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await ensureProfile(db.db, { authUserId: user.id, email: user.email, name: user.name });
          },
        },
      },
    },
    plugins: [
      passkey({ rpID: origin.hostname, rpName: "Perch", origin: env.publicUrl }),
      ...(env.oidc
        ? [
            genericOAuth({
              config: [
                {
                  providerId: "oidc",
                  clientId: env.oidc.clientId,
                  clientSecret: env.oidc.clientSecret,
                  discoveryUrl: `${env.oidc.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
                  scopes: ["openid", "profile", "email"],
                  pkce: true,
                },
              ],
            }),
          ]
        : []),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
