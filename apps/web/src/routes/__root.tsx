import { t } from "@perch/ui";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Link, Outlet, useNavigate } from "@tanstack/react-router";
import { Button } from "../components/form.tsx";
import { authClient } from "../lib/auth-client.ts";
import { resetSocket } from "../lib/ws.ts";

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  component: RootLayout,
});

function RootLayout() {
  const { data: session } = authClient.useSession();
  const navigate = useNavigate();
  return (
    <div className="flex min-h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-surface px-4 py-3">
        <Link to="/" className="font-semibold">
          {t("app.name")}
        </Link>
        {session ? (
          <nav aria-label="Account" className="flex flex-wrap items-center gap-3 text-sm">
            <span data-testid="signed-in-as">
              {t("auth.signedInAs", { name: session.user.name })}
            </span>
            <Link to="/settings/security" className="underline">
              {t("nav.security")}
            </Link>
            <Button
              variant="secondary"
              onClick={async () => {
                // Leave the guarded page first so its redirect-to-sign-in does not race the sign-out.
                await navigate({ to: "/sign-in" });
                resetSocket();
                await authClient.signOut();
              }}
            >
              {t("nav.signOut")}
            </Button>
          </nav>
        ) : null}
      </header>
      <main className="flex flex-1 flex-col items-center px-4 py-6">
        <Outlet />
      </main>
    </div>
  );
}
