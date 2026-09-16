/**
 * The passkey half of the auth client (spec §7.1 `/api/auth/*`; task 0.8).
 *
 * Kept apart from `auth-client.ts` on purpose. Every page loads the auth client — the shell asks it
 * who you are before it draws anything — and better-auth composes plugins when a client is made,
 * so a plugin in that client is a plugin in the first paint. The passkey plugin is 3.9 KB gzipped
 * and belongs to exactly two screens: signing in, and the security page. It rides with them instead.
 *
 * Both clients speak to the same endpoints and the same cookie, so this is one session, not two:
 * what they do not share is the code you have to download before you can see anything.
 */
import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

export const passkeyAuth = createAuthClient({
  basePath: "/api/auth",
  plugins: [passkeyClient()],
});
