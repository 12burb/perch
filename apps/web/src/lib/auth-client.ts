import { createAuthClient } from "better-auth/react";

/**
 * Same-origin better-auth client (spec §7.1: /api/auth/*). Vite proxies /api in development.
 *
 * No plugins: this one is downloaded before anything is drawn, because the shell asks it who you
 * are. Passkeys live in `passkeys.ts` and are downloaded with the two screens that use them.
 */
export const authClient = createAuthClient({
  basePath: "/api/auth",
});

export type Session = NonNullable<ReturnType<typeof authClient.useSession>["data"]>;
