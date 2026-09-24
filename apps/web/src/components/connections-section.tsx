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
import { useSearch } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import type { ConnectOutcome } from "../lib/connect-outcome.ts";
import {
  botsQuery,
  type ConnectionProviderRow,
  type ConnectionRow,
  channelsQuery,
  connectionGrantsQuery,
  connectionProvidersQuery,
  connectionsQuery,
} from "../lib/queries.ts";

type Lane = "github_app" | "mcp_oauth" | "oauth2" | "token";

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

export function ConnectionsSection(props: { workspaceId: string; canAdmin: boolean }) {
  const providers = useQuery(connectionProvidersQuery(props.workspaceId));
  const connections = useQuery(connectionsQuery(props.workspaceId));
  // How a provider's callback went, carried here by /connections (task 2.14).
  const outcome = useSearch({ strict: false }) as ConnectOutcome;
  const connectedName =
    providers.data?.find((row) => row.id === outcome.connected)?.name ?? outcome.connected;
  return (
    <section aria-labelledby="connections-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 id="connections-heading" className="text-md font-semibold">
          {t("connections.title")}
        </h2>
        <p className="max-w-prose text-sm text-fg-muted">{t("connections.hint")}</p>
      </div>
      {connectedName ? (
        <p role="status" className="text-sm text-success">
          {t("connections.connected", { name: connectedName })}
        </p>
      ) : null}
      {outcome.error ? (
        <p role="alert" className="text-sm text-danger">
          {outcome.error}
        </p>
      ) : null}
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
  const [open, setOpen] = useState<string | null>(null);
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
              {/* What it speaks as, else the hint of the token, else how it was connected. */}
              <span className="text-sm text-fg-muted">
                {row.account ?? row.hint ?? t(`connections.lane.${row.kind}`)}
              </span>
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
                  variant="ghost"
                  aria-expanded={open === row.id}
                  onClick={() => setOpen(open === row.id ? null : row.id)}
                >
                  {t("connections.grants")}
                </Button>
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
              {open === row.id ? <Grants workspaceId={props.workspaceId} row={row} /> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Who may use a connection (spec §3.5 "grants UI … on-behalf-of rule"; task 2.14). A connection that
 * belongs to one person can be given to a bot the whole workspace talks to only on that person's
 * behalf, and the api refuses anything else — so the box here is a statement of that, not a choice
 * that could quietly widen it.
 */
function Grants(props: { workspaceId: string; row: ConnectionRow }) {
  const queryClient = useQueryClient();
  const id = useId();
  const grants = useQuery(connectionGrantsQuery(props.workspaceId, props.row.id)).data ?? [];
  const bots = useQuery(botsQuery(props.workspaceId)).data ?? [];
  const [botId, setBotId] = useState("");
  const [obo, setObo] = useState(props.row.owner_type === "user");
  const [error, setError] = useState<string | null>(null);
  const chosen = botId || (bots[0]?.id ?? "");
  const invalidate = () =>
    queryClient.invalidateQueries({
      queryKey: ["workspace", props.workspaceId, "connections", props.row.id, "grants"],
    });

  const grant = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/connections/{id}/grants", {
          params: { path: { ws: props.workspaceId, id: props.row.id } },
          body: { subject_type: "bot", subject_id: chosen, obo },
        }),
      ),
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (err) => setError(message(err)),
  });

  const revoke = useMutation({
    mutationFn: async (grantId: string) => {
      const result = await api.DELETE("/api/workspaces/{ws}/connections/{id}/grants/{grant}", {
        params: { path: { ws: props.workspaceId, id: props.row.id, grant: grantId } },
      });
      if (result.error) throw new RequestFailed(result.response.status, result.error);
    },
    onSuccess: () => {
      setError(null);
      void invalidate();
    },
    onError: (err) => setError(message(err)),
  });

  const nameOf = (subjectId: string) => bots.find((one) => one.id === subjectId)?.name ?? subjectId;

  return (
    <section
      aria-label={t("connections.grants")}
      data-testid="connection-grants"
      className="flex w-full flex-col gap-2 border-t border-border pt-2"
    >
      <p className="text-sm text-fg-muted">{t("connections.grantsHint")}</p>
      {grants.length === 0 ? (
        <p className="text-sm text-fg-subtle">{t("connections.grantsEmpty")}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {grants.map((one) => (
            <li key={one.id} data-testid="grant" className="flex items-center gap-2 text-sm">
              <span>{nameOf(one.subject_id)}</span>
              {one.obo ? <Badge>{t("connections.grantObo")}</Badge> : null}
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto"
                aria-label={t("connections.grantRemove", { name: nameOf(one.subject_id) })}
                disabled={revoke.isPending}
                onClick={() => revoke.mutate(one.id)}
              >
                {t("settings.removeShort")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {bots.length === 0 ? (
        <p className="text-sm text-fg-subtle">{t("connections.grantNoBots")}</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Field id={`${id}-bot`} label={t("connections.grantSubject")}>
            {(control) => (
              <select
                {...control}
                className="h-9 rounded border border-border bg-surface px-2"
                value={chosen}
                onChange={(event) => setBotId(event.target.value)}
              >
                {bots.map((one) => (
                  <option key={one.id} value={one.id}>
                    {one.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <label className="flex items-center gap-1 text-sm">
            <input type="checkbox" checked={obo} onChange={(e) => setObo(e.target.checked)} />
            {t("connections.grantObo")}
          </label>
          <Button size="sm" disabled={grant.isPending || !chosen} onClick={() => grant.mutate()}>
            {t("connections.grantAdd")}
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
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
    mutationFn: async (body: {
      provider: string;
      owner_type: "user" | "workspace";
      lane?: "mcp" | "oauth2";
      mcp_url?: string;
    }) =>
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
    // The MCP lane: Perch asks the provider's own MCP server how to authorize (task 2.14).
    if (chosen === "mcp_oauth") {
      const mcpUrl = String(data.get("mcp_url") ?? "").trim();
      start.mutate({
        provider: providerId,
        owner_type: scope,
        lane: "mcp",
        ...(mcpUrl ? { mcp_url: mcpUrl } : {}),
      });
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
        <AppWizard
          formId={formId}
          workspaceId={props.workspaceId}
          canAdmin={props.canAdmin}
          provider={provider}
        />
      ) : null}

      {(chosen === "mcp_oauth" || chosen === "oauth2") && provider ? (
        <ByoApp workspaceId={props.workspaceId} provider={provider} />
      ) : null}

      {chosen === "mcp_oauth" ? (
        <Field
          id={`${formId}-mcp-url`}
          label={t("connections.mcpUrl")}
          hint={t("connections.mcpUrlHint")}
        >
          {(control) => (
            <Input {...control} name="mcp_url" type="url" autoComplete="off" spellCheck={false} />
          )}
        </Field>
      ) : null}

      {chosen === "oauth2" || chosen === "mcp_oauth" ? null : (
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

/**
 * Registering your own app with a provider (spec §3.5's pre-registered lane; task 2.14). Perch
 * prefers an app somebody registered here over registering one itself, so this is the first lane
 * tried once it is filled in.
 */
function ByoApp(props: { workspaceId: string; provider: ConnectionProviderRow }) {
  const id = useId();
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (body: { client_id: string; client_secret?: string }) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/oauth-clients", {
          params: { path: { ws: props.workspaceId } },
          body: { provider: props.provider.id, ...body },
        }),
      ),
    onSuccess: () => {
      setError(null);
      setSaved(true);
    },
    onError: (err) => setError(message(err)),
  });
  return (
    <section
      aria-label={t("connections.byoApp")}
      className="flex flex-col gap-2 rounded border border-border bg-raised p-2"
    >
      <h4 className="text-sm font-semibold">{t("connections.byoApp")}</h4>
      <p className="text-sm text-fg-muted">{t("connections.byoAppHint")}</p>
      <p className="text-sm text-fg-muted">
        {t("connections.callbackUrl")}: <code>{props.provider.callback_url}</code>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field id={`${id}-client`} label={t("connections.clientId")}>
          {(control) => <Input {...control} name="client_id" autoComplete="off" />}
        </Field>
        <Field id={`${id}-secret`} label={t("connections.clientSecret")}>
          {(control) => (
            <Input {...control} name="client_secret" type="password" autoComplete="off" />
          )}
        </Field>
        <Button
          size="sm"
          disabled={save.isPending}
          onClick={(event) => {
            const form = (event.currentTarget as HTMLElement).closest("section");
            const clientId =
              form?.querySelector<HTMLInputElement>('input[name="client_id"]')?.value.trim() ?? "";
            const secret =
              form?.querySelector<HTMLInputElement>('input[name="client_secret"]')?.value ?? "";
            if (!clientId) return;
            save.mutate({ client_id: clientId, ...(secret ? { client_secret: secret } : {}) });
          }}
        >
          {t("connections.saveApp")}
        </Button>
        {saved ? (
          <Badge tone="accent" data-testid="app-saved">
            {t("connections.appSaved")}
          </Badge>
        ) : null}
      </div>
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

/**
 * What a GitHub App needs from Perch, so nobody has to work it out: the callback URL, prefilled,
 * and a webhook endpoint of its own (below) — a URL with that endpoint's id in it and the secret
 * GitHub signs deliveries with.
 */
function AppWizard(props: {
  formId: string;
  workspaceId: string;
  canAdmin: boolean;
  provider: ConnectionProviderRow;
}) {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (label: string, value: string) => {
    void navigator.clipboard?.writeText(value).then(() => setCopied(label));
  };
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
      <CopyRow
        label={t("connections.callbackUrl")}
        value={props.provider.callback_url}
        copied={copied}
        onCopy={copy}
      />
      <AppWebhook
        workspaceId={props.workspaceId}
        canAdmin={props.canAdmin}
        provider={props.provider}
        copied={copied}
        onCopy={copy}
      />
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

/** One value to paste somewhere else, with a button that copies it. */
function CopyRow(props: {
  label: string;
  value: string;
  copied: string | null;
  onCopy: (label: string, value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm font-medium">{props.label}</span>
      {/* Wrapped, not scrolled: a scrollable box would need its own focus stop, and a URL that
          wraps is easier to read on a phone than one that scrolls sideways. */}
      <code className="min-w-0 flex-1 break-all rounded bg-raised px-2 py-1 text-xs">
        {props.value}
      </code>
      <Button
        size="sm"
        onClick={() => props.onCopy(props.label, props.value)}
        aria-label={t("connections.copy", { label: props.label })}
      >
        {props.copied === props.label ? t("connections.copied") : t("common.copy")}
      </Button>
    </div>
  );
}

/**
 * The webhook half of a GitHub App. A delivery lands on an endpoint made under `.../webhooks`: its
 * URL carries the endpoint's id, its secret is what GitHub signs with, and it is wired to the
 * channel its cards go to. So the card makes one — an admin's call, like every webhook — and shows
 * the URL and the secret, the secret exactly once.
 */
function AppWebhook(props: {
  workspaceId: string;
  canAdmin: boolean;
  provider: ConnectionProviderRow;
  copied: string | null;
  onCopy: (label: string, value: string) => void;
}) {
  const id = useId();
  const channels = useQuery({
    ...channelsQuery(props.workspaceId),
    enabled: props.canAdmin && props.workspaceId !== "",
  });
  const named = (channels.data ?? []).filter((row) => row.name);
  const [channelId, setChannelId] = useState("");
  const chosen = channelId || (named[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const make = useMutation({
    mutationFn: async (channel: string) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/webhooks", {
          params: { path: { ws: props.workspaceId } },
          body: {
            provider: props.provider.id,
            name: t("connections.webhookName", { name: props.provider.name }),
            channel_id: channel,
          },
        }),
      ),
    onSuccess: () => setError(null),
    onError: (err) => setError(message(err)),
  });
  if (!props.canAdmin) {
    return <p className="text-sm text-fg-muted">{t("connections.webhookAdminOnly")}</p>;
  }
  const made = make.data;
  return (
    <section
      aria-label={t("connections.webhook")}
      className="flex flex-col gap-2 rounded border border-border bg-raised p-2"
    >
      <h4 className="text-sm font-semibold">{t("connections.webhook")}</h4>
      <p className="text-sm text-fg-muted">{t("connections.webhookHint")}</p>
      {made ? (
        <>
          <CopyRow
            label={t("connections.webhookUrl")}
            value={made.webhook.url}
            copied={props.copied}
            onCopy={props.onCopy}
          />
          {made.secret ? (
            <CopyRow
              label={t("connections.webhookSecret")}
              value={made.secret}
              copied={props.copied}
              onCopy={props.onCopy}
            />
          ) : null}
          <p role="status" className="text-sm text-fg-muted">
            {t("connections.webhookSecretOnce")}
          </p>
        </>
      ) : named.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("connections.webhookNoChannels")}</p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Field id={`${id}-channel`} label={t("connections.webhookChannel")}>
            {(control) => (
              <select
                {...control}
                value={chosen}
                onChange={(event) => setChannelId(event.target.value)}
                className="h-9 rounded border border-border bg-surface px-2"
              >
                {named.map((row) => (
                  <option key={row.id} value={row.id}>
                    {`#${row.name}`}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Button
            size="sm"
            disabled={!chosen || make.isPending}
            onClick={() => make.mutate(chosen)}
          >
            {t("connections.webhookMake")}
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
