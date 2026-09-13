import { Button, Field, Input, t } from "@perch/ui";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { AuthLayout, Card } from "../components/card.tsx";
import { authClient } from "../lib/auth-client.ts";
import { useInstance } from "../lib/instance.ts";
import { redirectSearch } from "../lib/redirect.ts";

export const Route = createFileRoute("/sign-in")({
  validateSearch: redirectSearch,
  component: SignIn,
});

function SignIn() {
  const { redirect } = Route.useSearch();
  const router = useRouter();
  const instance = useInstance();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const destination = redirect ?? "/";

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    const result = await authClient.signIn.email({
      email: String(form.get("email") ?? ""),
      password: String(form.get("password") ?? ""),
    });
    setBusy(false);
    if (result.error) {
      setError(t("auth.invalidCredentials"));
      return;
    }
    router.history.push(destination);
  }

  async function withPasskey() {
    setBusy(true);
    const result = await authClient.signIn.passkey();
    setBusy(false);
    if (result?.error) {
      setError(t("auth.passkeyFailed"));
      return;
    }
    router.history.push(destination);
  }

  async function withOidc() {
    // Generic OIDC providers ride the social sign-in route in better-auth 1.7 (ADR-0034).
    await authClient.signIn.social({ provider: "oidc", callbackURL: destination });
  }

  return (
    <AuthLayout>
      <Card title={t("auth.signInTitle")}>
        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <Field id="email" label={t("auth.email")}>
            {(control) => (
              <Input
                {...control}
                name="email"
                type="email"
                required
                autoComplete="username webauthn"
              />
            )}
          </Field>
          <Field id="password" label={t("auth.password")} error={error}>
            {(control) => (
              <Input
                {...control}
                name="password"
                type="password"
                required
                autoComplete="current-password"
              />
            )}
          </Field>
          <Button type="submit" variant="primary" size="lg" disabled={busy}>
            {t("auth.signIn")}
          </Button>
        </form>
        <div className="mt-4 flex flex-col gap-2">
          <Button variant="secondary" size="lg" onClick={withPasskey} disabled={busy}>
            {t("auth.withPasskey")}
          </Button>
          {instance.data?.auth.oidc ? (
            <Button variant="secondary" size="lg" onClick={withOidc} disabled={busy}>
              {t("auth.withOidc")}
            </Button>
          ) : null}
        </div>
        <p className="mt-4 text-sm text-fg-muted">
          {t("auth.noAccount")}{" "}
          <Link to="/sign-up" search={redirect ? { redirect } : {}} className="underline">
            {t("auth.signUp")}
          </Link>
        </p>
      </Card>
    </AuthLayout>
  );
}
