/**
 * Connections: the services Perch can reach on your behalf (spec §3.5, §5.5; task 1.16).
 *
 * A token is typed once and never comes back: a row shows the account it speaks as and a hint, so
 * this screen has nothing to redact. Which lanes a service offers comes from its manifest, so a
 * new connector needs no code here.
 */
import "@perch/ui/i18n/settings";
import { Badge, Button, EmptyState, Field, Input, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import {
  type ConnectionProviderRow,
  type ConnectionRow,
  connectionProvidersQuery,
  connectionsQuery,
} from "../lib/queries.ts";

type Lane = "github_app" | "oauth2" | "token";

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

export function ConnectionsSection(props: { workspaceId: string; canAdmin: boolean }) {
  const providers = useQuery(connectionProvidersQuery(props.workspaceId));
  const connections = useQuery(connectionsQuery(props.workspaceId));
  return (
    <section aria-labelledby="connections-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="connections-heading" className="text-md font-semibold">
          {t("connections.title")}
        </h2>
        <p className="max-w-prose text-sm text-fg-muted">{t("connections.hint")}</p>
      </div>
      <ConnectionList workspaceId={props.workspaceId} rows={connections.data ?? []} />
      <Connect
        workspaceId={props.workspaceId}
        canAdmin={props.canAdmin}
        providers={providers.data ?? []}
      />
    </section>
  );
}

function ConnectionList(props: { workspaceId: string; rows: ConnectionRow[] }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [tested, setTested] = useState<Record<string, string>>({});
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId, "connections"] });
  const test = useMutation({
    mutationFn: async (row: ConnectionRow) => ({
      row,
      result: unwrap(
        await api.POST("/api/workspaces/{ws}/connections/{id}/test", {
          params: { path: { ws: props.workspaceId, id: row.id } },
        }),
      ),
    }),
    onSuccess: ({ row, result }) => {
      setError(null);
      setTested((seen) => ({
        ...seen,
        [row.id]: t("connections.tested", { account: result.account ?? row.provider_name }),
      }));
      void invalidate();
    },
    onError: (err) => setError(message(err)),
  });
  const remove = useMutation({
    mutationFn: async (row: ConnectionRow) => {
      const result = await api.DELETE("/api/workspaces/{ws}/connections/{id}", {
        params: { path: { ws: props.workspaceId, id: row.id } },
      });
      if (result.error) throw new RequestFailed(result.response.status, result.error);
    },
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (err) => setError(message(err)),
  });
  if (props.rows.length === 0) {
    // The title says what is missing rather than repeating the section's own heading.
    return <EmptyState title={t("connections.emptyTitle")} hint={t("connections.empty")} />;
  }
  return (
    <div className="flex flex-col gap-2">
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      <ul className="flex flex-col gap-2">
        {props.rows.map((row) => {
          const name = row.account ?? row.provider_name;
          return (
            <li
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded border border-border p-2"
            >
              <span className="font-medium">{row.provider_name}</span>
              <span className="text-sm text-fg-muted">{row.account ?? row.hint ?? row.kind}</span>
              <Badge tone={row.owner_type === "workspace" ? "accent" : "neutral"}>
                {t(
                  row.owner_type === "workspace"
                    ? "connections.scope.workspace"
                    : "connections.scope.user",
                )}
              </Badge>
              {row.status === "invalid" ? (
                <Badge tone="danger">{t("connections.invalid")}</Badge>
              ) : null}
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
                  aria-label={t("connections.test", { name })}
                >
                  {t("common.test")}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => remove.mutate(row)}
                  disabled={remove.isPending}
                  aria-label={t("connections.disconnect", { name })}
                >
                  {t("settings.removeShort")}
                </Button>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Connect(props: {
  workspaceId: string;
  canAdmin: boolean;
  providers: ConnectionProviderRow[];
}) {
  const queryClient = useQueryClient();
  const formId = useId();
  const [providerId, setProviderId] = useState("github");
  const [lane, setLane] = useState<Lane>("token");
  const [error, setError] = useState<string | null>(null);
  const provider = props.providers.find((row) => row.id === providerId);
  const lanes = (provider?.lanes ?? ["token"]) as Lane[];
  const chosen: Lane = lanes.includes(lane) ? lane : (lanes[0] ?? "token");
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId, "connections"] });

  const connect = useMutation({
    mutationFn: async (body: Record<string, unknown>) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/connections", {
          params: { path: { ws: props.workspaceId } },
          // The body is a discriminated union the SDK types per lane; the form builds one shape.
          body: body as never,
        }),
      ),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (err) => setError(message(err)),
  });

  const start = useMutation({
    mutationFn: async (body: { provider: string; owner_type: "user" | "workspace" }) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/connections/start", {
          params: { path: { ws: props.workspaceId } },
          body,
        }),
      ),
    // The provider takes it from here; the callback lands back on this page.
    onSuccess: (result) => {
      window.location.href = result.url;
    },
    onError: (err) => setError(message(err)),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const scope = data.get("owner_type") === "workspace" ? "workspace" : "user";
    if (chosen === "oauth2") {
      start.mutate({ provider: providerId, owner_type: scope });
      return;
    }
    // Where the service lives, for anyone running it themselves: an empty box is the public one.
    const apiBase = String(data.get("api_base") ?? "").trim();
    const base = apiBase ? { api_base: apiBase } : {};
    connect.mutate(
      chosen === "token"
        ? {
            kind: "token",
            provider: providerId,
            token: String(data.get("token") ?? "").trim(),
            owner_type: scope,
            ...base,
          }
        : {
            kind: "github_app",
            provider: providerId,
            app_id: String(data.get("app_id") ?? "").trim(),
            private_key: String(data.get("private_key") ?? ""),
            installation_id: String(data.get("installation_id") ?? "").trim(),
            owner_type: scope,
            ...base,
          },
    );
    form.reset();
  }

  return (
    <form
      onSubmit={onSubmit}
      aria-label={t("connections.connect")}
      className="flex max-w-lg flex-col gap-3"
    >
      <Field id={`${formId}-provider`} label={t("connections.provider")}>
        {(control) => (
          <select
            {...control}
            value={providerId}
            onChange={(event) => setProviderId(event.target.value)}
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
      <Field id={`${formId}-lane`} label={t("connections.lane")}>
        {(control) => (
          <select
            {...control}
            value={chosen}
            onChange={(event) => setLane(event.target.value as Lane)}
            className="h-9 rounded border border-border bg-surface px-2"
          >
            {lanes.map((option) => (
              <option key={option} value={option}>
                {t(`connections.lane.${option}`)}
              </option>
            ))}
          </select>
        )}
      </Field>

      {chosen === "token" ? (
        <Field
          id={`${formId}-token`}
          label={t("connections.token")}
          hint={provider?.token_prefix.join(", ")}
        >
          {(control) => (
            <Input {...control} name="token" type="password" required autoComplete="off" />
          )}
        </Field>
      ) : null}

      {chosen === "github_app" && provider ? (
        <AppWizard formId={formId} provider={provider} />
      ) : null}

      {chosen === "oauth2" ? null : (
        <Field
          id={`${formId}-api-base`}
          label={t("connections.apiBase")}
          hint={t("connections.apiBaseHint")}
        >
          {(control) => (
            <Input {...control} name="api_base" type="url" autoComplete="off" spellCheck={false} />
          )}
        </Field>
      )}

      <Field id={`${formId}-scope`} label={t("connections.scope")} error={error}>
        {(control) => (
          <select
            {...control}
            name="owner_type"
            defaultValue="user"
            className="h-9 rounded border border-border bg-surface px-2"
          >
            <option value="user">{t("connections.scope.user")}</option>
            {props.canAdmin ? (
              <option value="workspace">{t("connections.scope.workspace")}</option>
            ) : null}
          </select>
        )}
      </Field>
      <div>
        <Button type="submit" variant="primary" disabled={connect.isPending || start.isPending}>
          {start.isPending ? t("connections.connecting") : t("connections.connect")}
        </Button>
      </div>
    </form>
  );
}

/** The two URLs a GitHub App needs, prefilled, because nobody should have to work them out. */
function AppWizard(props: { formId: string; provider: ConnectionProviderRow }) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => setCopied(label));
  };
  const rows: { label: string; value: string }[] = [
    { label: t("connections.callbackUrl"), value: props.provider.callback_url },
    { label: t("connections.webhookUrl"), value: props.provider.webhook_url },
  ];
  return (
    <div className="flex flex-col gap-3 rounded border border-border p-3">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-semibold">{t("connections.wizard")}</h3>
        <p className="text-sm text-fg-muted">{t("connections.wizardHint")}</p>
        {props.provider.docs_url ? (
          <a
            className="text-sm text-accent underline"
            href={props.provider.docs_url}
            target="_blank"
            rel="noreferrer"
          >
            {t("connections.docs")}
          </a>
        ) : null}
      </div>
      {rows.map((row) => (
        <div key={row.label} className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">{row.label}</span>
          {/* Wrapped, not scrolled: a scrollable box would need its own focus stop, and a URL
              that wraps is easier to read on a phone than one that scrolls sideways. */}
          <code className="min-w-0 flex-1 break-all rounded bg-raised px-2 py-1 text-xs">
            {row.value}
          </code>
          <Button
            size="sm"
            onClick={() => copy(row.label, row.value)}
            aria-label={t("connections.copy", { label: row.label })}
          >
            {copied === row.label ? t("connections.copied") : t("common.copy")}
          </Button>
        </div>
      ))}
      <Field id={`${props.formId}-app-id`} label={t("connections.appId")}>
        {(control) => <Input {...control} name="app_id" required maxLength={64} />}
      </Field>
      <Field id={`${props.formId}-installation`} label={t("connections.installationId")}>
        {(control) => <Input {...control} name="installation_id" required maxLength={64} />}
      </Field>
      <Field id={`${props.formId}-key`} label={t("connections.privateKey")}>
        {(control) => (
          <textarea
            {...control}
            name="private_key"
            required
            rows={4}
            autoComplete="off"
            className="rounded border border-border bg-surface px-2 py-1 font-mono text-xs"
          />
        )}
      </Field>
    </div>
  );
}
