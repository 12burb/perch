import { t } from "@perch/ui";
import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { Button, Card, ErrorText, Field } from "../components/form.tsx";
import { authClient } from "../lib/auth-client.ts";
import { redirectSearch } from "../lib/redirect.ts";

export const Route = createFileRoute("/sign-up")({
  validateSearch: redirectSearch,
  component: SignUp,
});

function SignUp() {
  const { redirect } = Route.useSearch();
  const router = useRouter();
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
    router.history.push(redirect ?? "/");
  }

  return (
    <Card title={t("auth.signUpTitle")}>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field
          id="name"
          label={t("auth.name")}
          inputProps={{ name: "name", required: true, maxLength: 80, autoComplete: "name" }}
        />
        <Field
          id="email"
          label={t("auth.email")}
          inputProps={{ name: "email", type: "email", required: true, autoComplete: "email" }}
        />
        <Field
          id="password"
          label={t("auth.password")}
          hint={t("auth.passwordHint")}
          inputProps={{
            name: "password",
            type: "password",
            required: true,
            minLength: 10,
            autoComplete: "new-password",
          }}
        />
        <ErrorText>{error}</ErrorText>
        <Button type="submit" disabled={busy}>
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
  );
}
