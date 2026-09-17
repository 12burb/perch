import { Badge, Button, EmptyState, Field, Input, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { api, RequestFailed, unwrap } from "../../../lib/api.ts";
import { hubQuery } from "../../../lib/queries.ts";
import { useAppShell } from "../../../shell/app-shell.tsx";
import { ModePage } from "../../../shell/mode-page.tsx";

/**
 * The Hub (task 4.12): one page for the connectors, bots, skills and templates this build ships,
 * with an Install on each that does the thing rather than explaining where to go and do it.
 *
 * The exception is a connection, which needs a person to sign in or paste a token: its Install
 * takes you to the Connections card, and the row says so before you press it.
 */
export const Route = createFileRoute("/_app/$workspace/hub")({ component: Hub });

type HubItem = {
  kind: "connector" | "bot" | "skill" | "template";
  id: string;
  name: string;
  blurb: string;
  installs: string;
  tags: string[];
  from: string;
  handle?: string;
  parent?: string;
  docs_url?: string;
  port?: number;
};

const KINDS = ["connector", "bot", "skill", "template"] as const;
type Kind = (typeof KINDS)[number];

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

function Hub() {
  const { shell, workspace } = useAppShell();
  const [kind, setKind] = useState<Kind | null>(null);
  const [typed, setTyped] = useState("");
  const hub = useQuery(hubQuery({ ...(kind ? { kind } : {}) }));
  if (!workspace) return null;
  const counts = hub.data?.counts ?? {};
  const q = typed.trim().toLowerCase();
  const items = ((hub.data?.items ?? []) as HubItem[]).filter(
    (item) =>
      !q ||
      item.name.toLowerCase().includes(q) ||
      item.blurb.toLowerCase().includes(q) ||
      item.tags.some((tag) => tag.toLowerCase().includes(q)),
  );
  return (
    <ModePage title={t("hub.title")} subtitle={t("hub.subtitle")} shell={shell}>
      <div className="flex flex-col gap-4 p-4">
        <div className="flex flex-wrap items-end gap-3">
          <fieldset className="flex flex-wrap items-center gap-1 border-0 p-0">
            <legend className="sr-only">{t("hub.filter")}</legend>
            <Button
              size="sm"
              variant={kind === null ? "primary" : "ghost"}
              aria-pressed={kind === null}
              onClick={() => setKind(null)}
            >
              {t("hub.all")}
            </Button>
            {KINDS.map((one) => (
              <Button
                key={one}
                size="sm"
                variant={kind === one ? "primary" : "ghost"}
                aria-pressed={kind === one}
                onClick={() => setKind(one)}
              >
                {t(`hub.kind.${one}`)}
                <Badge className="ml-2">{counts[one] ?? 0}</Badge>
              </Button>
            ))}
          </fieldset>
          <div className="min-w-[14rem] flex-1">
            <Field id="hub-search" label={t("hub.search")}>
              {(control) => (
                <Input
                  {...control}
                  type="search"
                  value={typed}
                  autoComplete="off"
                  onChange={(event) => setTyped(event.target.value)}
                />
              )}
            </Field>
          </div>
        </div>

        <p role="status" className="text-sm text-fg-muted">
          {t("hub.results", { count: items.length })}
        </p>

        {hub.isSuccess && items.length === 0 ? (
          <EmptyState title={t("hub.empty")} hint={t("hub.emptyHint")} />
        ) : (
          <ul aria-label={t("hub.title")} className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {items.map((item) => (
              <HubCard key={`${item.kind}/${item.id}`} item={item} workspaceId={workspace.id} />
            ))}
          </ul>
        )}
      </div>
    </ModePage>
  );
}

function HubCard(props: { item: HubItem; workspaceId: string }) {
  const { item } = props;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [bot, setBot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [href, setHref] = useState<string | null>(null);
  const install = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/hub/install", {
          params: { path: { ws: props.workspaceId } },
          body: {
            kind: item.kind,
            id: item.id,
            ...(item.kind === "skill" && bot.trim() ? { bot: bot.trim() } : {}),
          },
        }),
      ),
    onSuccess: async (result) => {
      setError(null);
      setDone(result.detail);
      setHref(result.href ?? null);
      // A connection is not installed here: it is a trip to Settings, so go.
      if (item.kind === "connector" && result.href) {
        await navigate({ to: result.href });
        return;
      }
      await queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId] });
    },
    onError: (err) => setError(message(err)),
  });
  const headingId = `hub-${item.kind}-${item.id}`;
  return (
    <li className="flex flex-col gap-2 rounded border border-border bg-surface p-3">
      <div className="flex items-start gap-2">
        <h2 id={headingId} className="text-sm font-semibold">
          {item.name}
        </h2>
        <Badge className="ml-auto shrink-0">{t(`hub.one.${item.kind}`)}</Badge>
      </div>
      <p className="text-sm text-fg-muted">{item.blurb}</p>
      <p className="text-xs text-fg-subtle">{item.installs}</p>
      {item.kind === "skill" ? (
        <Field
          id={`${headingId}-bot`}
          label={t("hub.skillNeedsBot")}
          hint={t("hub.skillNeedsBotHint")}
        >
          {(control) => (
            <Input
              {...control}
              value={bot}
              autoComplete="off"
              placeholder="dawn"
              onChange={(event) => setBot(event.target.value)}
            />
          )}
        </Field>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {done ? (
        <p role="status" className="text-sm text-fg-muted">
          {done}
        </p>
      ) : null}
      <div className="mt-auto flex items-center gap-2 pt-1">
        <Button
          size="sm"
          variant="primary"
          disabled={install.isPending}
          aria-label={`${t("hub.install")}: ${item.name}`}
          onClick={() => install.mutate()}
        >
          {install.isPending ? t("hub.installing") : t("hub.install")}
        </Button>
        {href && item.kind !== "connector" ? (
          <Button size="sm" variant="ghost" onClick={() => void navigate({ to: href })}>
            {t("hub.open")}
          </Button>
        ) : null}
        <span className="ml-auto text-xs text-fg-subtle">{t("hub.from", { path: item.from })}</span>
      </div>
    </li>
  );
}
