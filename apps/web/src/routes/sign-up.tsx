import { Button, Field, Input, t } from "@perch/ui";
import { createFileRoute, Link, redirect } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AuthLayout, Card } from "../components/card.tsx";
import { authClient } from "../lib/auth-client.ts";
import { startFresh } from "../lib/fresh-start.ts";
import { instanceQuery } from "../lib/queries.ts";
import { redirectSearch } from "../lib/redirect.ts";

export const Route = createFileRoute("/sign-up")({
  validateSearch: redirectSearch,
  beforeLoad: async ({ context }) => {
    const instance = await context.queryClient.ensureQueryData(instanceQuery);
    if (!instance.setup_complete) throw redirect({ to: "/setup" });
  },
  component: SignUp,
});

function SignUp() {
  const { redirect } = Route.useSearch();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const result = await authClient.signUp.email({
      name: String(form.get("name") ?? ""),
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    setBusy(false);
    if (result.error) {
      setError(result.error.message ?? t("auth.signUpFailed"));
      return;
    }
    // A full load: nothing a previous person left in this tab's memory is shown to this one.
    startFresh(redirect ?? "/");
  }

  return (
    <AuthLayout>
      <Card title={t("auth.signUpTitle")}>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
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
          <Field
            id="password"
            label={t("auth.password")}
            hint={t("auth.passwordHint")}
            error={error}
          >
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
          <Button type="submit" variant="primary" size="lg" disabled={busy}>
            {t("auth.signUp")}
          </Button>
        </form>
        <p className="mt-4 text-sm text-fg-muted">
          {t("auth.haveAccount")}{" "}
          <Link to="/sign-in" search={redirect ? { redirect } : {}} className="underline">
            {t("auth.signIn")}
          </Link>
        </p>
      </Card>
    </AuthLayout>
  );
}
