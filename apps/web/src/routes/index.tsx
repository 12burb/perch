import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "../lib/auth-client.ts";
import { workspacesQuery } from "../lib/queries.ts";
import { rememberedWorkspace } from "../lib/workspace.ts";

/** "/" lands where the user left off: sign-in, the first workspace, or the welcome page. */
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    const session = await authClient.getSession();
    if (!session.data) throw redirect({ to: "/sign-in", search: { redirect: "/" } });
    const workspaces = await context.queryClient.ensureQueryData(workspacesQuery);
    const remembered = rememberedWorkspace();
    const target = workspaces.find((ws) => ws.slug === remembered) ?? workspaces[0];
    if (!target) throw redirect({ to: "/welcome" });
    throw redirect({ to: "/$workspace/$mode", params: { workspace: target.slug, mode: "home" } });
  },
  component: () => null,
});
