import { createFileRoute, redirect } from "@tanstack/react-router";
import { connectOutcome } from "../lib/connect-outcome.ts";
import { workspacesQuery } from "../lib/queries.ts";
import { rememberedWorkspace } from "../lib/workspace.ts";

/**
 * Where a provider sends somebody back (task 2.14). The api knows the exchange worked; it does not
 * know which workspace's settings page this browser came from, so this route does that part and
 * carries the outcome through to the Connections card.
 */
export const Route = createFileRoute("/connections")({
  validateSearch: connectOutcome,
  beforeLoad: async ({ context, search }) => {
    const workspaces = await context.queryClient.ensureQueryData(workspacesQuery);
    const remembered = rememberedWorkspace();
    const target = workspaces.find((ws) => ws.slug === remembered) ?? workspaces[0];
    if (!target) throw redirect({ to: "/welcome" });
    throw redirect({ to: "/$workspace/settings", params: { workspace: target.slug }, search });
  },
  component: () => null,
});
