/**
 * Brains: the keys and endpoints a workspace runs models on, and the named models themselves
 * (spec §3.4, §3.6 lane A; task 1.15).
 *
 * A secret is typed once and never comes back: the API answers with a hint like `sk…4f2a`, so
 * this screen has nothing to redact. "Test" asks the provider for its model list — a provider that
 * answers is a provider that took the key — and the same list fills the model picker.
 */
import { Badge, Button, EmptyState, Field, Input, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import {
  type CredentialRow,
  catalogQuery,
  credentialsQuery,
  modelProfilesQuery,
  providersQuery,
} from "../lib/queries.ts";

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

/** What tells two credentials of one provider apart: the key's hint, or the endpoint it points at. */
function subtitle(row: CredentialRow): string {
  return row.hint ?? row.base_url ?? "";
}

export function BrainsSection(props: { workspaceId: string; canAdmin: boolean }) {
  const providers = useQuery(providersQuery(props.workspaceId));
  const credentials = useQuery(credentialsQuery(props.workspaceId));
  return (
    <section aria-labelledby="brains-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="brains-heading" className="text-md font-semibold">
          {t("brains.title")}
        </h2>
        <p className="max-w-prose text-sm text-fg-muted">{t("brains.hint")}</p>
      </div>
      <CredentialList
        workspaceId={props.workspaceId}
        canAdmin={props.canAdmin}
        rows={credentials.data ?? []}
      />
      <AddCredential
        workspaceId={props.workspaceId}
        canAdmin={props.canAdmin}
        providers={providers.data?.providers ?? []}
        ollama={providers.data?.ollama ?? null}
      />
      <ProfileList
        workspaceId={props.workspaceId}
        canAdmin={props.canAdmin}
        credentials={credentials.data ?? []}
      />
    </section>
  );
}

function CredentialList(props: { workspaceId: string; canAdmin: boolean; rows: CredentialRow[] }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId] });
  const test = useMutation({
    mutationFn: async (row: CredentialRow) => ({
      row,
      models: await queryClient.fetchQuery(catalogQuery(props.workspaceId, row.id)),
    }),
    onSuccess: ({ row, models }) => {
      setError(null);
      setTested((seen) => ({ ...seen, [row.id]: t("brains.tested", { count: models.length }) }));
      void invalidate();
    },
    onError: (err) => setError(message(err)),
  });
  const remove = useMutation({
    mutationFn: async (row: CredentialRow) =>
      unwrap(
        await api.DELETE("/api/workspaces/{ws}/credentials/{id}", {
          params: { path: { ws: props.workspaceId, id: row.id } },
        }),
      ),
    onSuccess: (result) => {
      setError(
        result.profiles.length > 0
          ? t("brains.removed", { names: result.profiles.join(", ") })
          : null,
      );
      void invalidate();
    },
    onError: (err) => setError(message(err)),
  });
  if (props.rows.length === 0) {
    return <EmptyState title={t("brains.credentials")} hint={t("brains.credentialsEmpty")} />;
  }
  return (
    <div className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold text-fg-muted">{t("brains.credentials")}</h3>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {props.rows.map((row) => (
          <li
            key={row.id}
            className="flex flex-wrap items-center gap-2 rounded border border-border p-2"
          >
            <span className="font-medium">{row.label}</span>
            <span className="text-sm text-fg-muted">
              {subtitle(row) ? `${row.provider_name} · ${subtitle(row)}` : row.provider_name}
            </span>
            <Badge tone={row.scope === "workspace" ? "accent" : "neutral"}>
              {t(row.scope === "workspace" ? "brains.scope.workspace" : "brains.scope.user")}
            </Badge>
            {row.status === "invalid" ? <Badge tone="danger">{t("brains.invalid")}</Badge> : null}
            {tested[row.id] ? (
              <span role="status" className="text-sm text-success">
                {tested[row.id]}
              </span>
            ) : null}
            <span className="ml-auto flex gap-2">
              <Button
                size="sm"
                onClick={() => test.mutate(row)}
                disabled={test.isPending}
                aria-label={t("brains.test", { label: row.label })}
              >
                {t("common.test")}
              </Button>
              {row.scope === "user" || props.canAdmin ? (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => remove.mutate(row)}
                  disabled={remove.isPending}
                  aria-label={t("brains.remove", { label: row.label })}
                >
                  {t("settings.removeShort")}
                </Button>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

type ProviderOption = { id: string; name: string; kind: "api_key" | "endpoint"; base_url: string };

function AddCredential(props: {
  workspaceId: string;
  canAdmin: boolean;
  providers: ProviderOption[];
  ollama: { base_url: string; models: { id: string }[] } | null;
}) {
  const queryClient = useQueryClient();
  const formId = useId();
  const [provider, setProvider] = useState("openai");
  const [error, setError] = useState<string | null>(null);
  const chosen = props.providers.find((row) => row.id === provider);
  const wantsKey = chosen?.kind !== "endpoint";
  const add = useMutation({
    mutationFn: async (body: {
      provider: string;
      kind: "api_key" | "endpoint";
      scope: "user" | "workspace";
      label: string;
      secret?: string;
      base_url?: string;
    }) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/credentials", {
          params: { path: { ws: props.workspaceId } },
          body,
        }),
      ),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId] });
    },
    onError: (err) => setError(message(err)),
  });
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const secret = String(data.get("secret") ?? "").trim();
    const baseUrl = String(data.get("base_url") ?? "").trim();
    add.mutate({
      provider,
      kind: wantsKey ? "api_key" : "endpoint",
      scope: data.get("scope") === "workspace" ? "workspace" : "user",
      label: String(data.get("label") ?? "").trim(),
      ...(secret ? { secret } : {}),
      ...(baseUrl ? { base_url: baseUrl } : {}),
    });
    form.reset();
  }
  return (
    <form onSubmit={onSubmit} aria-label={t("brains.add")} className="flex max-w-lg flex-col gap-3">
      <h3 className="text-sm font-semibold text-fg-muted">{t("brains.add")}</h3>
      {props.ollama ? (
        <p className="flex items-center gap-2 text-sm">
          <span>{t("brains.ollamaFound", { url: props.ollama.base_url })}</span>
          <Button
            size="sm"
            onClick={() =>
              add.mutate({
                provider: "ollama",
                kind: "endpoint",
                scope: "user",
                label: "Ollama",
                base_url: props.ollama?.base_url ?? "",
              })
            }
          >
            {t("brains.ollamaAdd")}
          </Button>
        </p>
      ) : null}
      <Field id={`${formId}-provider`} label={t("brains.provider")}>
        {(control) => (
          <select
            {...control}
            name="provider"
            value={provider}
            onChange={(event) => setProvider(event.target.value)}
            className="h-9 rounded border border-border bg-surface px-2"
          >
            {props.providers.map((row) => (
              <option key={row.id} value={row.id}>
                {row.name}
              </option>
            ))}
          </select>
        )}
      </Field>
      <Field id={`${formId}-label`} label={t("brains.label")}>
        {(control) => <Input {...control} name="label" required maxLength={120} />}
      </Field>
      {wantsKey ? (
        <Field id={`${formId}-secret`} label={t("brains.secret")}>
          {(control) => (
            <Input {...control} name="secret" type="password" required autoComplete="off" />
          )}
        </Field>
      ) : null}
      <Field id={`${formId}-base`} label={t("brains.baseUrl")} hint={chosen?.base_url || undefined}>
        {(control) => (
          <Input
            {...control}
            name="base_url"
            type="url"
            required={!wantsKey && !chosen?.base_url}
            placeholder={chosen?.base_url}
          />
        )}
      </Field>
      <Field id={`${formId}-scope`} label={t("brains.scope")} error={error}>
        {(control) => (
          <select
            {...control}
            name="scope"
            defaultValue="user"
            className="h-9 rounded border border-border bg-surface px-2"
          >
            <option value="user">{t("brains.scope.user")}</option>
            {props.canAdmin ? (
              <option value="workspace">{t("brains.scope.workspace")}</option>
            ) : null}
          </select>
        )}
      </Field>
      <div>
        <Button type="submit" variant="primary" disabled={add.isPending}>
          {t("brains.save")}
        </Button>
      </div>
    </form>
  );
}

function ProfileList(props: {
  workspaceId: string;
  canAdmin: boolean;
  credentials: CredentialRow[];
}) {
  const queryClient = useQueryClient();
  const formId = useId();
  const profiles = useQuery(modelProfilesQuery(props.workspaceId));
  const [credentialId, setCredentialId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const credential = props.credentials.find((row) => row.id === credentialId);
  // The picker fills from the credential's own catalog; a typed id is still allowed.
  const models = useQuery(catalogQuery(props.workspaceId, credentialId));
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId, "model-profiles"] });
  const add = useMutation({
    mutationFn: async (body: {
      name: string;
      provider: string;
      model_id: string;
      credential_id?: string;
      default_for?: "chat" | "code";
    }) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/model-profiles", {
          params: { path: { ws: props.workspaceId } },
          body,
        }),
      ),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (err) => setError(message(err)),
  });
  const promote = useMutation({
    mutationFn: async (id: string) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/model-profiles/{id}/default", {
          params: { path: { ws: props.workspaceId, id } },
          body: { for: "code" },
        }),
      ),
    onSuccess: () => void invalidate(),
    onError: (err) => setError(message(err)),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      const result = await api.DELETE("/api/workspaces/{ws}/model-profiles/{id}", {
        params: { path: { ws: props.workspaceId, id } },
      });
      if (result.error) throw new RequestFailed(result.response.status, result.error);
    },
    onSuccess: () => void invalidate(),
    onError: (err) => setError(message(err)),
  });
  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    add.mutate({
      name: String(data.get("name") ?? "").trim(),
      // A brain with no credential runs on whatever the engine is already logged in as.
      provider: credential?.provider ?? "custom",
      model_id: String(data.get("model_id") ?? "").trim(),
      ...(credentialId ? { credential_id: credentialId } : {}),
      ...(data.get("default_for") === "on" ? { default_for: "code" as const } : {}),
    });
    form.reset();
  }
  const rows = profiles.data ?? [];
  return (
    <div className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold text-fg-muted">{t("brains.profiles")}</h3>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState title={t("brains.profiles")} hint={t("brains.profilesEmpty")} />
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((row) => (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded border border-border p-2"
            >
              <span className="font-medium">{row.name}</span>
              <span className="text-sm text-fg-muted">{row.model_id}</span>
              {row.default_for === "code" ? (
                <Badge tone="accent">{t("brains.default")}</Badge>
              ) : null}
              {props.canAdmin ? (
                <span className="ml-auto flex gap-2">
                  {row.default_for === "code" ? null : (
                    <Button
                      size="sm"
                      onClick={() => promote.mutate(row.id)}
                      aria-label={t("brains.makeDefault", { name: row.name })}
                    >
                      {t("brains.default")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="danger"
                    onClick={() => remove.mutate(row.id)}
                    aria-label={t("brains.removeProfile", { name: row.name })}
                  >
                    {t("settings.removeShort")}
                  </Button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {props.canAdmin ? (
        <form
          onSubmit={onSubmit}
          aria-label={t("brains.addProfile")}
          className="flex max-w-lg flex-col gap-3"
        >
          <Field id={`${formId}-name`} label={t("brains.profileName")}>
            {(control) => <Input {...control} name="name" required maxLength={120} />}
          </Field>
          <Field id={`${formId}-credential`} label={t("brains.credential")}>
            {(control) => (
              <select
                {...control}
                name="credential_id"
                value={credentialId}
                onChange={(event) => setCredentialId(event.target.value)}
                className="h-9 rounded border border-border bg-surface px-2"
              >
                <option value="">{t("brains.credentialNone")}</option>
                {props.credentials.map((row) => (
                  <option key={row.id} value={row.id}>
                    {row.label}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field id={`${formId}-model`} label={t("brains.model")} hint={t("brains.modelHint")}>
            {(control) => (
              <>
                <Input {...control} name="model_id" required list={`${formId}-models`} />
                <datalist id={`${formId}-models`}>
                  {(models.data ?? []).map((model) => (
                    <option key={model.id} value={model.id} />
                  ))}
                </datalist>
              </>
            )}
          </Field>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="default_for" className="size-4" />
            {t("brains.default")}
          </label>
          <div>
            <Button type="submit" variant="primary" disabled={add.isPending}>
              {t("brains.addProfile")}
            </Button>
          </div>
        </form>
      ) : null}
    </div>
  );
}
