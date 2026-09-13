import { t } from "@perch/ui";
import { useMutation, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button, Card, ErrorText } from "../components/form.tsx";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { authClient } from "../lib/auth-client.ts";

export const Route = createFileRoute("/invite/$token")({ component: InvitePage });

function InvitePage() {
  const { token } = Route.useParams();
  const navigate = useNavigate();
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
    onSuccess: () => navigate({ to: "/" }),
    onError: (err) => {
      if (err instanceof RequestFailed && err.code === "forbidden")
        setError(t("invite.wrongEmail"));
      else if (err instanceof RequestFailed) setError(err.message);
      else setError(t("common.error"));
    },
  });
  const redirect = `/invite/${token}`;

  if (preview.isPending || sessionPending) return <p>{t("common.loading")}</p>;
  if (preview.isError || !preview.data) {
    return (
      <Card title={t("invite.title")}>
        <ErrorText>{t("invite.notFound")}</ErrorText>
      </Card>
    );
  }
  const invite = preview.data;
  return (
    <Card title={t("invite.title")}>
      <p className="text-sm" data-testid="invite-body">
        {t("invite.body", {
          email: invite.email,
          workspace: invite.workspace.name,
          role: t(`home.role.${invite.role}`),
        })}
      </p>
      {invite.status === "accepted" ? <p className="mt-3 text-sm">{t("invite.accepted")}</p> : null}
      {invite.status === "expired" ? <p className="mt-3 text-sm">{t("invite.expired")}</p> : null}
      {invite.status === "pending" && session ? (
        <div className="mt-4 flex flex-col gap-2">
          <ErrorText>{error}</ErrorText>
          <Button onClick={() => accept.mutate()} disabled={accept.isPending}>
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
  );
}
