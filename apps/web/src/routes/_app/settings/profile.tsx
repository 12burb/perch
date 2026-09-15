import { Button, Field, Input, t, useTheme } from "@perch/ui";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { api, RequestFailed, unwrap } from "../../../lib/api.ts";
import { type PushState, state as pushState, turnOff, turnOn } from "../../../lib/push.ts";
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
        <NotificationSettings />
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

/**
 * Notifications for this device (task 2.3). One switch, and the truth about where the browser
 * stands: a person who has told it no cannot be asked again from here, and is told why.
 */
function NotificationSettings() {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    void pushState().then((current) => {
      if (live) setState(current);
    });
    return () => {
      live = false;
    };
  }, []);

  const flip = async () => {
    setBusy(true);
    try {
      setState(state === "on" ? await turnOff() : await turnOn());
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby="notifications-heading" className="flex max-w-lg flex-col gap-3">
      <h2 id="notifications-heading" className="text-md font-semibold">
        {t("settings.notifications")}
      </h2>
      <p className="text-sm text-fg-muted">{t("settings.notificationsHint")}</p>
      {state === "unsupported" ? (
        <p className="text-sm text-fg-subtle">{t("settings.notificationsUnsupported")}</p>
      ) : state === "denied" ? (
        <p className="text-sm text-warning">{t("settings.notificationsDenied")}</p>
      ) : (
        <div className="flex items-center gap-3">
          <Button
            variant={state === "on" ? "ghost" : "primary"}
            disabled={busy || state === null}
            onClick={() => void flip()}
          >
            {state === "on" ? t("settings.notificationsOff") : t("settings.notificationsOn")}
          </Button>
          {state === "on" ? (
            <span role="status" className="text-sm text-success">
              {t("settings.notificationsIsOn")}
            </span>
          ) : null}
        </div>
      )}
    </section>
  );
}
