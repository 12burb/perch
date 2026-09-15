/**
 * Shipping a project, and looking at its database (spec §5.5; task 2.15).
 *
 * Two drawer tabs that both run on a connection. Deploy asks the provider to build this project and
 * says so in a channel — the card in the thread is the deploy's record, and this panel keeps asking
 * the provider until the build stops moving, so the card in chat fills itself in. Database lists
 * what a connection's database has and runs one read; a statement that writes is refused here the
 * same way it is refused by the api, because a panel that reads should say so before you press it.
 */
import "@perch/ui/i18n/code";
import { Badge, Button, EmptyState, Field, Input, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useId, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { channelsQuery, connectionsQuery, projectsQuery } from "../lib/queries.ts";

function message(error: unknown): string {
  return error instanceof RequestFailed ? error.message : t("common.error");
}

type Deployment = {
  id: string;
  state: "queued" | "building" | "ready" | "error" | "canceled";
  target: "preview" | "production";
  url: string | null;
  inspector_url: string | null;
  message_id: string;
};

const DONE = new Set(["ready", "error", "canceled"]);
const TONE: Record<Deployment["state"], "accent" | "neutral" | "danger" | "success"> = {
  queued: "neutral",
  building: "accent",
  ready: "success",
  error: "danger",
  canceled: "neutral",
};

/** The Deploy button, and the one card it keeps up to date. */
export function DeployPanel(props: { workspaceId: string; projectId: string }) {
  const id = useId();
  const queryClient = useQueryClient();
  const connections = useQuery(connectionsQuery(props.workspaceId));
  const channels = useQuery(channelsQuery(props.workspaceId));
  const projects = useQuery(projectsQuery(props.workspaceId));
  const project = (projects.data ?? []).find((row) => row.id === props.projectId);
  const [connectionId, setConnectionId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [target, setTarget] = useState<"preview" | "production">("preview");
  const [deployment, setDeployment] = useState<Deployment | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Only a connection that can deploy: the rest of the list would be a choice with one right answer.
  const deployable = (connections.data ?? []).filter((row) => row.provider === "vercel");
  const named = (channels.data ?? []).filter((row) => row.name);
  const chosenConnection = connectionId || (deployable[0]?.id ?? "");
  const chosenChannel = channelId || (named[0]?.id ?? "");

  const start = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/deploys", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: { connection_id: chosenConnection, channel_id: chosenChannel, target },
        }),
      ),
    onSuccess: (row) => {
      setError(null);
      setDeployment(row as Deployment);
    },
    onError: (err) => setError(message(err)),
  });

  const refresh = useMutation({
    mutationFn: async (row: Deployment) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/deploys/refresh", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: { connection_id: chosenConnection, message_id: row.message_id },
        }),
      ),
    onSuccess: (row) => setDeployment(row as Deployment),
    onError: (err) => setError(message(err)),
  });

  // A build takes minutes, so the panel asks again until it stops moving. The card in the thread is
  // rewritten by the same call, which is how chat catches up without anybody watching this tab.
  const pending = deployment && !DONE.has(deployment.state) ? deployment : null;
  const ask = refresh.mutate;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(() => ask(pending), 5_000);
    return () => clearInterval(timer);
  }, [pending, ask]);

  // A git-based deploy needs a repository. A project made empty and pushed somewhere later has one
  // and has never been able to say so, so the panel asks rather than refusing.
  const repo = useMutation({
    mutationFn: async (repoUrl: string) =>
      unwrap(
        await api.PATCH("/api/workspaces/{ws}/projects/{project}", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: { repo_url: repoUrl },
        }),
      ),
    onSuccess: async () => {
      setError(null);
      await queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "projects"],
      });
    },
    onError: (err) => setError(message(err)),
  });

  if (deployable.length === 0) {
    return <EmptyState title={t("deploy.noConnection")} hint={t("deploy.noConnectionHint")} />;
  }

  if (project && !project.repo_url) {
    return (
      <section aria-label={t("deploy.title")} className="flex flex-col gap-3 p-2">
        <p className="text-sm text-fg-muted">{t("deploy.noRepo")}</p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const value = String(new FormData(event.currentTarget).get("repo_url") ?? "").trim();
            if (value) repo.mutate(value);
          }}
        >
          <Field id={`${id}-repo`} label={t("deploy.repo")} hint={t("deploy.repoHint")}>
            {(control) => (
              <Input {...control} name="repo_url" type="url" required spellCheck={false} />
            )}
          </Field>
          <Button type="submit" disabled={repo.isPending}>
            {t("common.save")}
          </Button>
        </form>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : null}
      </section>
    );
  }

  return (
    <section aria-label={t("deploy.title")} className="flex flex-col gap-3 p-2">
      <p className="text-sm text-fg-muted">{t("deploy.hint")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <Field id={`${id}-connection`} label={t("deploy.connection")}>
          {(control) => (
            <select
              {...control}
              className="h-9 rounded border border-border bg-surface px-2"
              value={chosenConnection}
              onChange={(event) => setConnectionId(event.target.value)}
            >
              {deployable.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.account ?? row.provider_name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={`${id}-channel`} label={t("deploy.channel")}>
          {(control) => (
            <select
              {...control}
              className="h-9 rounded border border-border bg-surface px-2"
              value={chosenChannel}
              onChange={(event) => setChannelId(event.target.value)}
            >
              {named.map((row) => (
                <option key={row.id} value={row.id}>
                  #{row.name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Field id={`${id}-target`} label={t("deploy.target")}>
          {(control) => (
            <select
              {...control}
              className="h-9 rounded border border-border bg-surface px-2"
              value={target}
              onChange={(event) => setTarget(event.target.value as "preview" | "production")}
            >
              <option value="preview">{t("deploy.target.preview")}</option>
              <option value="production">{t("deploy.target.production")}</option>
            </select>
          )}
        </Field>
        <Button
          variant="primary"
          disabled={start.isPending || !chosenConnection || !chosenChannel}
          onClick={() => start.mutate()}
        >
          {start.isPending ? t("deploy.starting") : t("deploy.start")}
        </Button>
      </div>

      {deployment ? (
        <div
          data-testid="deployment"
          className="flex flex-wrap items-center gap-2 rounded border border-border p-2"
        >
          <Badge tone={TONE[deployment.state]}>{t(`deploy.state.${deployment.state}`)}</Badge>
          {deployment.url ? (
            <a
              className="break-all text-sm text-accent underline"
              href={deployment.url}
              target="_blank"
              rel="noreferrer"
            >
              {deployment.url}
            </a>
          ) : (
            <span role="status" className="text-sm text-fg-muted">
              {t("deploy.waiting")}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate(deployment)}
          >
            {t("deploy.refresh")}
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}

type Table = {
  schema: string;
  name: string;
  rows: number | null;
  columns: { name: string; type: string; nullable: boolean }[];
};

/** The schema browser, and one read-only query box. */
export function DbPanel(props: { workspaceId: string }) {
  const id = useId();
  const connections = useQuery(connectionsQuery(props.workspaceId));
  const [connectionId, setConnectionId] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [sql, setSql] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{
    columns: string[];
    rows: Record<string, unknown>[];
  } | null>(null);

  // Which connections have a database Perch can browse comes from their manifests.
  const browsable = (connections.data ?? []).filter((row) => row.provider === "supabase");
  const chosen = connectionId || (browsable[0]?.id ?? "");

  const tables = useQuery({
    queryKey: ["workspace", props.workspaceId, "connections", chosen, "db", "tables"],
    enabled: chosen !== "",
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/connections/{id}/db/tables", {
          params: { path: { ws: props.workspaceId, id: chosen }, query: {} },
        }),
      ).tables as Table[],
  });

  const run = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/connections/{id}/db/query", {
          params: { path: { ws: props.workspaceId, id: chosen } },
          body: { sql },
        }),
      ),
    onSuccess: (rows) => {
      setError(null);
      setResult(rows as { columns: string[]; rows: Record<string, unknown>[] });
    },
    onError: (err) => {
      setResult(null);
      setError(message(err));
    },
  });

  if (browsable.length === 0) {
    return <EmptyState title={t("db.noConnection")} hint={t("db.noConnectionHint")} />;
  }

  return (
    <section aria-label={t("db.title")} className="flex flex-col gap-3 p-2">
      <div className="flex flex-wrap items-end gap-2">
        <Field id={`${id}-connection`} label={t("db.connection")}>
          {(control) => (
            <select
              {...control}
              className="h-9 rounded border border-border bg-surface px-2"
              value={chosen}
              onChange={(event) => setConnectionId(event.target.value)}
            >
              {browsable.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.account ?? row.provider_name}
                </option>
              ))}
            </select>
          )}
        </Field>
        <Badge>{t("db.readOnly")}</Badge>
      </div>

      {tables.isError ? (
        <p role="alert" className="text-sm text-danger">
          {message(tables.error)}
        </p>
      ) : null}

      {(tables.data ?? []).length === 0 && tables.isSuccess ? (
        <EmptyState title={t("db.empty")} hint={t("db.emptyHint")} className="py-6" />
      ) : (
        <ul aria-label={t("db.tables")} className="flex flex-col gap-1">
          {(tables.data ?? []).map((table) => {
            const key = `${table.schema}.${table.name}`;
            return (
              <li key={key} className="rounded border border-border">
                <button
                  type="button"
                  aria-expanded={open === key}
                  onClick={() => setOpen(open === key ? null : key)}
                  className="flex w-full items-center gap-2 px-2 py-1 text-left text-sm"
                >
                  <span className="font-medium">{key}</span>
                  {table.rows === null ? null : (
                    <span className="text-fg-muted">{t("db.rows", { count: table.rows })}</span>
                  )}
                </button>
                {open === key ? (
                  <ul className="flex flex-col gap-0.5 border-t border-border px-2 py-1">
                    {table.columns.map((column) => (
                      <li key={column.name} className="flex gap-2 font-mono text-xs">
                        <span>{column.name}</span>
                        <span className="text-fg-muted">{column.type}</span>
                        {column.nullable ? <span className="text-fg-subtle">null</span> : null}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2 [&>*:first-child]:flex-1">
        <Field id={`${id}-sql`} label={t("db.sql")} hint={t("db.sqlHint")}>
          {(control) => (
            <Input
              {...control}
              value={sql}
              spellCheck={false}
              className="font-mono"
              onChange={(event) => setSql(event.target.value)}
            />
          )}
        </Field>
        <Button disabled={run.isPending || !sql.trim()} onClick={() => run.mutate()}>
          {t("db.run")}
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}

      {result ? (
        <div className="overflow-x-auto">
          <table className="w-full text-sm" aria-label={t("db.result")}>
            <thead>
              <tr className="text-left text-fg-muted">
                {result.columns.map((column) => (
                  <th key={column} scope="col" className="py-1 pr-3 font-medium">
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: a result set has no key of its own
                <tr key={index} className="border-t border-border">
                  {result.columns.map((column) => (
                    <td key={column} className="py-1 pr-3 font-mono text-xs">
                      {String(row[column] ?? "")}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
