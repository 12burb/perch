import { MOBILE_QUERY } from "@perch/ui";
import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "../lib/auth-client.ts";
import { inboxQuery, instanceQuery, workspacesQuery } from "../lib/queries.ts";
import { rememberedWorkspace } from "../lib/workspace.ts";

/**
 * On a phone, Inbox is the launch tab when something needs you (spec §4 "Mobile … Inbox is the
 * launch tab when something needs you"; task 2.10). On anything wider, Home is where you left off.
 */
async function landingMode(queryClient: {
  ensureQueryData: (options: ReturnType<typeof inboxQuery>) => Promise<{ open: number }>;
}): Promise<"home" | "inbox"> {
  if (typeof window === "undefined" || !window.matchMedia(MOBILE_QUERY).matches) return "home";
  try {
    const queue = await queryClient.ensureQueryData(inboxQuery());
    return queue.open > 0 ? "inbox" : "home";
  } catch {
    // A queue that cannot be read is not a reason to land nowhere.
    return "home";
  }
}

/** "/" lands where the user left off: sign-in, the first workspace, or the welcome page. */
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    const instance = await context.queryClient.ensureQueryData(instanceQuery);
    if (!instance.setup_complete) throw redirect({ to: "/setup" });
    const session = await authClient.getSession();
    if (!session.data) throw redirect({ to: "/sign-in", search: { redirect: "/" } });
    const workspaces = await context.queryClient.ensureQueryData(workspacesQuery);
    const remembered = rememberedWorkspace();
    const target = workspaces.find((ws) => ws.slug === remembered) ?? workspaces[0];
    if (!target) throw redirect({ to: "/welcome" });
    const mode = await landingMode(context.queryClient);
    throw redirect({ to: "/$workspace/$mode", params: { workspace: target.slug, mode } });
  },
  component: () => null,
});
