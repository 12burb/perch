import { Button, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { AuthLayout, Card } from "../components/card.tsx";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { authClient } from "../lib/auth-client.ts";
import { rememberWorkspace } from "../lib/workspace.ts";

export const Route = createFileRoute("/invite/$token")({ component: InvitePage });

function InvitePage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data: session, isPending: sessionPending } = authClient.useSession();
  const [error, setError] = useState<string | null>(null);
  const preview = useQuery({
    queryKey: ["invite", token],
    queryFn: async () =>
      unwrap(await api.GET("/api/invites/{token}", { params: { path: { token } } })),
  });
  const accept = useMutation({
    mutationFn: async () =>
      unwrap(await api.POST("/api/invites/{token}/accept", { params: { path: { token } } })),
    onSuccess: async (joined) => {
      rememberWorkspace(joined.slug);
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      await navigate({ to: "/$workspace/$mode", params: { workspace: joined.slug, mode: "home" } });
    },
    onError: (err) => {
      if (err instanceof RequestFailed && err.code === "forbidden")
        setError(t("invite.wrongEmail"));
      else if (err instanceof RequestFailed) setError(err.message);
      else setError(t("common.error"));
    },
  });
  const redirect = `/invite/${token}`;

  if (preview.isPending || sessionPending) {
    return (
      <AuthLayout>
        <p>{t("common.loading")}</p>
      </AuthLayout>
    );
  }
  if (preview.isError || !preview.data) {
    return (
      <AuthLayout>
        <Card title={t("invite.title")}>
          <p role="alert" className="text-sm text-danger">
            {t("invite.notFound")}
          </p>
        </Card>
      </AuthLayout>
    );
  }
  const invite = preview.data;
  return (
    <AuthLayout>
      <Card title={t("invite.title")}>
        <p className="text-sm" data-testid="invite-body">
          {t("invite.body", {
            email: invite.email,
            workspace: invite.workspace.name,
            role: t(`home.role.${invite.role}`),
          })}
        </p>
        {invite.status === "accepted" ? (
          <p className="mt-3 text-sm">{t("invite.accepted")}</p>
        ) : null}
        {invite.status === "expired" ? <p className="mt-3 text-sm">{t("invite.expired")}</p> : null}
        {invite.status === "pending" && session ? (
          <div className="mt-4 flex flex-col gap-2">
            {error ? (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            ) : null}
            <Button
              variant="primary"
              size="lg"
              onClick={() => accept.mutate()}
              disabled={accept.isPending}
            >
              {t("invite.accept")}
            </Button>
          </div>
        ) : null}
        {invite.status === "pending" && !session ? (
          <div className="mt-4 flex flex-col gap-2">
            <Link to="/sign-up" search={{ redirect }} className="underline">
              {t("invite.signUpToAccept")}
            </Link>
            <Link to="/sign-in" search={{ redirect }} className="underline">
              {t("invite.signInToAccept")}
            </Link>
          </div>
        ) : null}
      </Card>
    </AuthLayout>
  );
}
