import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";

/** Same-origin better-auth client (spec §7.1: /api/auth/*). Vite proxies /api in development. */
export const authClient = createAuthClient({
  basePath: "/api/auth",
  plugins: [passkeyClient()],
});

export type Session = NonNullable<ReturnType<typeof authClient.useSession>["data"]>;
