import { Button, Field, Input, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, redirect, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AuthLayout, Card } from "../components/card.tsx";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { instanceQuery } from "../lib/queries.ts";
import { rememberWorkspace } from "../lib/workspace.ts";

/** First run (spec §8, task 0.13): admin account, first workspace, the public URL, telemetry. */
export const Route = createFileRoute("/setup")({
  beforeLoad: async ({ context }) => {
    const instance = await context.queryClient.ensureQueryData(instanceQuery);
    if (instance.setup_complete) throw redirect({ to: "/" });
  },
  component: SetupWizard,
});

function SetupWizard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const instance = useQuery(instanceQuery).data;
  const [error, setError] = useState<string | null>(null);
  const [urlError, setUrlError] = useState<string | null>(null);
  const setup = useMutation({
    mutationFn: async (body: {
      admin: { name: string; email: string; password: string };
      workspace: { name: string };
      public_url: string;
      telemetry: boolean;
    }) => unwrap(await api.POST("/api/setup", { body })),
    onSuccess: async (result) => {
      rememberWorkspace(result.workspace_slug);
      await queryClient.invalidateQueries();
      await navigate({
        to: "/$workspace/$mode",
        params: { workspace: result.workspace_slug, mode: "home" },
      });
    },
    onError: (err) => {
      if (
        err instanceof RequestFailed &&
        err.status === 422 &&
        err.message.includes("PERCH_PUBLIC_URL")
      ) {
        setUrlError(t("setup.publicUrlMismatch", { configured: instance?.public_url ?? "" }));
        return;
      }
      setError(err instanceof RequestFailed ? err.message : t("common.error"));
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setUrlError(null);
    const data = new FormData(event.currentTarget);
    setup.mutate({
      admin: {
        name: String(data.get("name") ?? "").trim(),
        email: String(data.get("email") ?? "").trim(),
        password: String(data.get("password") ?? ""),
      },
      workspace: { name: String(data.get("workspace") ?? "").trim() },
      public_url: String(data.get("public_url") ?? "").trim(),
      telemetry: data.get("telemetry") === "on",
    });
  }

  return (
    <AuthLayout>
      <Card title={t("setup.title")}>
        <p className="mb-4 text-sm text-fg-muted">{t("setup.intro")}</p>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-md font-semibold">{t("setup.admin")}</legend>
            <Field id="name" label={t("auth.name")}>
              {(control) => (
                <Input {...control} name="name" required maxLength={80} autoComplete="name" />
              )}
            </Field>
            <Field id="email" label={t("auth.email")}>
              {(control) => (
                <Input {...control} name="email" type="email" required autoComplete="email" />
              )}
            </Field>
            <Field id="password" label={t("auth.password")} hint={t("auth.passwordHint")}>
              {(control) => (
                <Input
                  {...control}
                  name="password"
                  type="password"
                  required
                  minLength={10}
                  autoComplete="new-password"
                />
              )}
            </Field>
          </fieldset>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-md font-semibold">{t("setup.workspace")}</legend>
            <Field id="workspace" label={t("home.workspaceName")}>
              {(control) => (
                <Input
                  {...control}
                  name="workspace"
                  required
                  maxLength={80}
                  autoComplete="organization"
                />
              )}
            </Field>
          </fieldset>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-md font-semibold">{t("setup.instance")}</legend>
            <Field
              id="public_url"
              label={t("setup.publicUrl")}
              hint={t("setup.publicUrlHint")}
              error={urlError}
            >
              {(control) => (
                <Input
                  {...control}
                  name="public_url"
                  type="url"
                  required
                  defaultValue={instance?.public_url ?? ""}
                />
              )}
            </Field>
            <label className="flex min-h-touch items-start gap-2 text-sm">
              <input type="checkbox" name="telemetry" className="mt-1" />
              <span>
                {t("setup.telemetry")}{" "}
                <a
                  href="https://github.com/12burb/perch/blob/main/docs/telemetry.md"
                  className="underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  {t("setup.telemetryLink")}
                </a>
              </span>
            </label>
          </fieldset>
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <Button type="submit" variant="primary" size="lg" disabled={setup.isPending}>
            {t("setup.submit")}
          </Button>
        </form>
      </Card>
    </AuthLayout>
  );
}
