import { t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Navigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button, Card, ErrorText, Field } from "../components/form.tsx";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { authClient } from "../lib/auth-client.ts";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  const { data: session, isPending } = authClient.useSession();
  if (isPending) return <p>{t("common.loading")}</p>;
  if (!session) return <Navigate to="/sign-in" search={{ redirect: "/" }} />;
  return <Workspaces />;
}

const roleLabel = {
  owner: "home.role.owner",
  admin: "home.role.admin",
  member: "home.role.member",
} as const;

function Workspaces() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const workspaces = useQuery({
    queryKey: ["workspaces"],
    queryFn: async () => unwrap(await api.GET("/api/workspaces")).workspaces,
  });
  const create = useMutation({
    mutationFn: async (name: string) =>
      unwrap(await api.POST("/api/workspaces", { body: { name } })),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["workspaces"] });
    },
    onError: (err) => setError(err instanceof RequestFailed ? err.message : t("common.error")),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") ?? "").trim();
    if (!name) return;
    create.mutate(name, { onSuccess: () => form.reset() });
  }

  return (
    <div className="flex w-full max-w-2xl flex-col gap-6">
      <Card title={t("home.workspaces")}>
        {workspaces.isPending ? <p>{t("common.loading")}</p> : null}
        {workspaces.data && workspaces.data.length === 0 ? (
          <p className="text-sm text-fg-muted">{t("home.noWorkspaces")}</p>
        ) : null}
        {workspaces.data && workspaces.data.length > 0 ? (
          <ul aria-label={t("home.workspaces")} className="flex flex-col gap-2">
            {workspaces.data.map((ws) => (
              <li
                key={ws.id}
                data-workspace-id={ws.id}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2"
              >
                <span className="font-medium">{ws.name}</span>
                <span className="text-xs text-fg-muted">{t(roleLabel[ws.role])}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>
      <Card title={t("home.createWorkspace")}>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field
            id="workspace-name"
            label={t("home.workspaceName")}
            inputProps={{ name: "name", required: true, maxLength: 80, autoComplete: "off" }}
          />
          <ErrorText>{error}</ErrorText>
          <Button type="submit" disabled={create.isPending}>
            {t("home.createWorkspace")}
          </Button>
        </form>
      </Card>
    </div>
  );
}
