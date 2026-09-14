import { Button, Field, Input, t, useTheme } from "@perch/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api, RequestFailed, unwrap } from "../../../lib/api.ts";
import { useAppShell } from "../../../shell/app-shell.tsx";
import { ModePage } from "../../../shell/mode-page.tsx";

export const Route = createFileRoute("/_app/settings/profile")({ component: ProfileSettings });

function ProfileSettings() {
  const { shell, me } = useAppShell();
  const queryClient = useQueryClient();
  const theme = useTheme();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const update = useMutation({
    mutationFn: async (body: { name: string; handle: string; locale: string; tz: string }) =>
      unwrap(await api.PATCH("/api/me", { body })),
    onSuccess: () => {
      setError(null);
      setSaved(true);
      void queryClient.invalidateQueries({ queryKey: ["me"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace"] });
    },
    onError: (err) => setError(err instanceof RequestFailed ? err.message : t("common.error")),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    update.mutate({
      name: String(data.get("name") ?? "").trim(),
      handle: String(data.get("handle") ?? "").trim(),
      locale: String(data.get("locale") ?? "en").trim(),
      tz: String(data.get("tz") ?? "UTC").trim(),
    });
  }

  return (
    <ModePage title={t("settings.profile")} shell={shell}>
      <div className="flex flex-col gap-8 p-4">
        <section aria-labelledby="profile-heading" className="flex max-w-lg flex-col gap-3">
          <h2 id="profile-heading" className="text-md font-semibold">
            {t("settings.profileHeading")}
          </h2>
          <p className="text-sm text-fg-muted">{me.email}</p>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <Field id="name" label={t("auth.name")}>
              {(control) => (
                <Input
                  {...control}
                  name="name"
                  defaultValue={me.name}
                  required
                  maxLength={80}
                  autoComplete="name"
                />
              )}
            </Field>
            <Field
              id="handle"
              label={t("settings.handle")}
              hint={t("settings.handleHint")}
              error={error}
            >
              {(control) => (
                <Input
                  {...control}
                  name="handle"
                  defaultValue={me.handle}
                  required
                  maxLength={32}
                  pattern="[a-z0-9][a-z0-9-]*"
                  autoComplete="username"
                />
              )}
            </Field>
            <Field id="locale" label={t("settings.locale")}>
              {(control) => (
                <Input
                  {...control}
                  name="locale"
                  defaultValue={me.locale}
                  required
                  maxLength={16}
                />
              )}
            </Field>
            <Field id="tz" label={t("settings.timezone")}>
              {(control) => (
                <Input {...control} name="tz" defaultValue={me.tz} required maxLength={64} />
              )}
            </Field>
            <div className="flex items-center gap-3">
              <Button type="submit" variant="primary" disabled={update.isPending}>
                {t("common.save")}
              </Button>
              {saved ? (
                <span role="status" className="text-sm text-success">
                  {t("settings.saved")}
                </span>
              ) : null}
            </div>
          </form>
        </section>
        <section aria-labelledby="appearance-heading" className="flex max-w-lg flex-col gap-3">
          <h2 id="appearance-heading" className="text-md font-semibold">
            {t("settings.appearance")}
          </h2>
          <fieldset className="flex flex-wrap gap-4">
            <legend className="mb-1 text-sm font-medium">{t("ui.theme")}</legend>
            {(["system", "dark", "light"] as const).map((name) => (
              <label key={name} className="flex min-h-touch items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="theme"
                  value={name}
                  checked={theme.theme === name}
                  onChange={() => theme.setTheme(name)}
                />
                {t(`ui.theme.${name}`)}
              </label>
            ))}
          </fieldset>
          <fieldset className="flex flex-wrap gap-4">
            <legend className="mb-1 text-sm font-medium">{t("ui.density")}</legend>
            {(["comfortable", "compact"] as const).map((density) => (
              <label key={density} className="flex min-h-touch items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="density"
                  value={density}
                  checked={theme.density === density}
                  onChange={() => theme.setDensity(density)}
                />
                {t(`ui.density.${density}`)}
              </label>
            ))}
          </fieldset>
        </section>
      </div>
    </ModePage>
  );
}
