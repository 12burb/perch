/**
 * better-auth's own tables (spec §6: auth_user, auth_session, auth_account, auth_verification,
 * auth_passkey), owned by its Drizzle adapter. Column names are better-auth's field names verbatim so the
 * adapter needs no field mapping (ADR-0034). Perch's `users` row (identity.ts) is keyed 1:1 to auth_user.
 */
import { boolean, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const authUser = pgTable("auth_user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("emailVerified").notNull().default(false),
  image: text("image"),
  createdAt: tz("createdAt").notNull().defaultNow(),
  updatedAt: tz("updatedAt").notNull().defaultNow(),
});

export const authSession = pgTable(
  "auth_session",
  {
    id: text("id").primaryKey(),
    expiresAt: tz("expiresAt").notNull(),
    token: text("token").notNull().unique(),
    createdAt: tz("createdAt").notNull().defaultNow(),
    updatedAt: tz("updatedAt").notNull().defaultNow(),
    ipAddress: text("ipAddress"),
    userAgent: text("userAgent"),
    userId: text("userId")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
  },
  (t) => [index("auth_session_user_idx").on(t.userId)],
);

export const authAccount = pgTable(
  "auth_account",
  {
    id: text("id").primaryKey(),
    accountId: text("accountId").notNull(),
    providerId: text("providerId").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    accessToken: text("accessToken"),
    refreshToken: text("refreshToken"),
    idToken: text("idToken"),
    accessTokenExpiresAt: tz("accessTokenExpiresAt"),
    refreshTokenExpiresAt: tz("refreshTokenExpiresAt"),
    scope: text("scope"),
    password: text("password"),
    createdAt: tz("createdAt").notNull().defaultNow(),
    updatedAt: tz("updatedAt").notNull().defaultNow(),
  },
  (t) => [index("auth_account_user_idx").on(t.userId)],
);

export const authVerification = pgTable(
  "auth_verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: tz("expiresAt").notNull(),
    createdAt: tz("createdAt").notNull().defaultNow(),
    updatedAt: tz("updatedAt").notNull().defaultNow(),
  },
  (t) => [index("auth_verification_identifier_idx").on(t.identifier)],
);

export const authPasskey = pgTable(
  "auth_passkey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    publicKey: text("publicKey").notNull(),
    userId: text("userId")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    credentialID: text("credentialID").notNull(),
    counter: integer("counter").notNull(),
    deviceType: text("deviceType").notNull(),
    backedUp: boolean("backedUp").notNull(),
    transports: text("transports"),
    createdAt: tz("createdAt").defaultNow(),
    aaguid: text("aaguid"),
  },
  (t) => [
    index("auth_passkey_user_idx").on(t.userId),
    index("auth_passkey_credential_idx").on(t.credentialID),
  ],
);

/** The schema map better-auth's Drizzle adapter expects (model name → table). */
export const authSchema = {
  user: authUser,
  session: authSession,
  account: authAccount,
  verification: authVerification,
  passkey: authPasskey,
};
