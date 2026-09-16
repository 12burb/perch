import { Button, Field, Input, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api, RequestFailed, unwrap } from "../../../lib/api.ts";
import { passkeyAuth } from "../../../lib/passkeys.ts";
import { useAppShell } from "../../../shell/app-shell.tsx";
import { ModePage } from "../../../shell/mode-page.tsx";

export const Route = createFileRoute("/_app/settings/security")({ component: SecuritySettings });

const SCOPES = ["read", "write", "admin"] as const;
type Scope = (typeof SCOPES)[number];

function SecuritySettings() {
  const { shell } = useAppShell();
  return (
    <ModePage title={t("settings.security")} shell={shell}>
      <div className="flex flex-col gap-8 p-4">
        <Passkeys />
        <Tokens />
      </div>
    </ModePage>
  );
}

function Passkeys() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const passkeys = useQuery({
    queryKey: ["passkeys"],
    queryFn: async () => {
      const result = await passkeyAuth.passkey.listUserPasskeys();
      if (result.error) throw new Error(result.error.message ?? t("common.error"));
      return result.data ?? [];
    },
  });
  const add = useMutation({
    mutationFn: async (name: string) => {
      const result = await passkeyAuth.passkey.addPasskey({ name });
      if (result?.error) throw new Error(result.error.message ?? t("common.error"));
    },
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({ queryKey: ["passkeys"] });
    },
    onError: (err) => setError(err.message),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const result = await passkeyAuth.passkey.deletePasskey({ id });
      if (result.error) throw new Error(result.error.message ?? t("common.error"));
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["passkeys"] }),
    onError: (err) => setError(err.message),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name =
      String(new FormData(form).get("name") ?? "").trim() || t("security.defaultPasskeyName");
    add.mutate(name, { onSuccess: () => form.reset() });
  }

  return (
    <section aria-labelledby="passkeys-heading" className="flex max-w-lg flex-col gap-3">
      <h2 id="passkeys-heading" className="text-md font-semibold">
        {t("security.passkeys")}
      </h2>
      {passkeys.data && passkeys.data.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("security.passkeysEmpty")}</p>
      ) : null}
      {passkeys.data && passkeys.data.length > 0 ? (
        <ul aria-label={t("security.passkeys")} className="flex flex-col gap-2">
          {passkeys.data.map((pk) => (
            <li
              key={pk.id}
              className="flex items-center justify-between rounded border border-border px-3 py-2"
            >
              <span>{pk.name ?? pk.id}</span>
              <Button
                variant="danger"
                size="sm"
                aria-label={t("security.removePasskey", { name: pk.name ?? pk.id })}
                onClick={() => remove.mutate(pk.id)}
              >
                {t("common.delete")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field id="passkey-name" label={t("security.passkeyName")} error={error}>
          {(control) => <Input {...control} name="name" maxLength={80} autoComplete="off" />}
        </Field>
        <Button type="submit" variant="primary" disabled={add.isPending}>
          {t("security.addPasskey")}
        </Button>
      </form>
    </section>
  );
}

function Tokens() {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<string | null>(null);
  const tokens = useQuery({
    queryKey: ["tokens"],
    queryFn: async () => unwrap(await api.GET("/api/me/tokens")).tokens,
  });
  const create = useMutation({
    mutationFn: async (input: { name: string; scopes: Scope[] }) =>
      unwrap(await api.POST("/api/me/tokens", { body: input })),
    onSuccess: (data) => {
      setError(null);
      setCreated(data.token);
      void queryClient.invalidateQueries({ queryKey: ["tokens"] });
    },
    onError: (err) => setError(err instanceof RequestFailed ? err.message : t("common.error")),
  });
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      const result = await api.DELETE("/api/me/tokens/{id}", { params: { path: { id } } });
      if (result.error) throw new RequestFailed(result.response.status, result.error);
    },
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["tokens"] }),
    onError: (err) => setError(err instanceof RequestFailed ? err.message : t("common.error")),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    const scopes = SCOPES.filter((scope) => data.get(`scope-${scope}`) === "on");
    if (!name || scopes.length === 0) return;
    create.mutate({ name, scopes }, { onSuccess: () => form.reset() });
  }

  return (
    <section aria-labelledby="tokens-heading" className="flex max-w-lg flex-col gap-3">
      <h2 id="tokens-heading" className="text-md font-semibold">
        {t("security.tokens")}
      </h2>
      {tokens.data && tokens.data.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("security.tokensEmpty")}</p>
      ) : null}
      {tokens.data && tokens.data.length > 0 ? (
        <ul aria-label={t("security.tokens")} className="flex flex-col gap-2">
          {tokens.data.map((token) => (
            <li
              key={token.id}
              className="flex items-center justify-between rounded border border-border px-3 py-2"
            >
              <span>
                {token.name}{" "}
                <span className="text-sm text-fg-muted">{token.scopes.join(", ")}</span>
              </span>
              <Button
                variant="danger"
                size="sm"
                aria-label={t("security.revokeToken", { name: token.name })}
                onClick={() => revoke.mutate(token.id)}
              >
                {t("common.delete")}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {created ? (
        <div className="rounded border border-warning p-3">
          <p className="text-sm">{t("security.tokenShownOnce")}</p>
          <output className="mt-2 block break-all font-mono text-sm" data-testid="created-token">
            {created}
          </output>
        </div>
      ) : null}
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <Field id="token-name" label={t("security.tokenName")} error={error}>
          {(control) => (
            <Input {...control} name="name" required maxLength={80} autoComplete="off" />
          )}
        </Field>
        <fieldset className="flex flex-wrap gap-4">
          <legend className="mb-1 text-sm font-medium">{t("security.scopes")}</legend>
          {SCOPES.map((scope) => (
            <label key={scope} className="flex min-h-touch items-center gap-2 text-sm">
              <input type="checkbox" name={`scope-${scope}`} defaultChecked={scope !== "admin"} />
              {t(`security.scope.${scope}`)}
            </label>
          ))}
        </fieldset>
        <Button type="submit" variant="primary" disabled={create.isPending}>
          {t("security.createToken")}
        </Button>
      </form>
    </section>
  );
}
