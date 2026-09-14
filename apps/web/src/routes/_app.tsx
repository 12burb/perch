import { t } from "@perch/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, redirect, useParams } from "@tanstack/react-router";
import { authClient } from "../lib/auth-client.ts";
import { instanceQuery, meQuery, workspacesQuery } from "../lib/queries.ts";
import { AppShell } from "../shell/app-shell.tsx";

/** Everything behind sign-in renders inside the shell; the workspace comes from the URL when present. */
export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const instance = await context.queryClient.ensureQueryData(instanceQuery);
    if (!instance.setup_complete) throw redirect({ to: "/setup" });
    const session = await authClient.getSession();
    if (!session.data) {
      throw redirect({ to: "/sign-in", search: { redirect: location.pathname } });
    }
    const [me, workspaces] = await Promise.all([
      context.queryClient.ensureQueryData(meQuery),
      context.queryClient.ensureQueryData(workspacesQuery),
    ]);
    return { me, workspaces };
  },
  component: AppLayout,
});

function AppLayout() {
  const params = useParams({ strict: false });
  const me = useQuery(meQuery).data;
  const workspaces = useQuery(workspacesQuery).data ?? [];
  const slug = "workspace" in params ? params.workspace : undefined;
  const workspace = workspaces.find((ws) => ws.slug === slug) ?? null;
  if (!me) return <p className="p-4">{t("common.loading")}</p>;
  return (
    <AppShell me={me} workspace={workspace}>
      <Outlet />
    </AppShell>
  );
}
