import { EmptyState, t } from "@perch/ui";
import { createFileRoute, notFound, Outlet } from "@tanstack/react-router";
import { workspacesQuery } from "../../lib/queries.ts";

/** Resolves the workspace slug once for every route under it; unknown slugs are not found. */
export const Route = createFileRoute("/_app/$workspace")({
  beforeLoad: async ({ context, params }) => {
    const workspaces = await context.queryClient.ensureQueryData(workspacesQuery);
    const workspace = workspaces.find((ws) => ws.slug === params.workspace);
    if (!workspace) throw notFound();
    return { workspace };
  },
  notFoundComponent: () => (
    <EmptyState title={t("shell.workspaceNotFound")} hint={t("shell.workspaceNotFoundHint")} />
  ),
  component: () => <Outlet />,
});
