import { Button, EmptyState, Field, Input, t } from "@perch/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { FolderPlus } from "lucide-react";
import { type FormEvent, useState } from "react";
import { api, RequestFailed, unwrap } from "../../lib/api.ts";
import { useAppShell } from "../../shell/app-shell.tsx";
import { ModePage } from "../../shell/mode-page.tsx";

export const Route = createFileRoute("/_app/welcome")({ component: Welcome });

/** The first thing a new user sees: create a workspace (the demo workspace lands with task 0.13). */
function Welcome() {
  const { shell, workspaces } = useAppShell();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const create = useMutation({
    mutationFn: async (name: string) =>
      unwrap(await api.POST("/api/workspaces", { body: { name } })),
    onSuccess: async (ws) => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["workspaces"] });
      await navigate({ to: "/$workspace/$mode", params: { workspace: ws.slug, mode: "home" } });
    },
    onError: (err) => setError(err instanceof RequestFailed ? err.message : t("common.error")),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = String(new FormData(event.currentTarget).get("name") ?? "").trim();
    if (name) create.mutate(name);
  }

  const first = workspaces.length === 0;
  return (
    <ModePage title={first ? t("welcome.titleFirst") : t("welcome.title")} shell={shell}>
      <div className="mx-auto flex max-w-lg flex-col gap-6 p-4">
        <EmptyState
          icon={<FolderPlus className="size-8" aria-hidden="true" />}
          title={first ? t("welcome.headingFirst") : t("welcome.heading")}
          hint={t("welcome.hint")}
        />
        <form
          onSubmit={onSubmit}
          aria-label={t("home.createWorkspace")}
          className="flex flex-col gap-3"
        >
          <Field id="workspace-name" label={t("home.workspaceName")} error={error}>
            {(control) => (
              <Input
                {...control}
                name="name"
                required
                maxLength={80}
                autoComplete="off"
                autoFocus
              />
            )}
          </Field>
          <Button type="submit" variant="primary" disabled={create.isPending}>
            {t("home.createWorkspace")}
          </Button>
        </form>
      </div>
    </ModePage>
  );
}
