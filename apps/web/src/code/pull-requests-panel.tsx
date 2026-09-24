/**
 * The Pull Requests page (spec §5.1 "Pull Requests page in Phase 3 with inline comments, request
 * changes, 'ask the agent to address review'"; task 3.20).
 *
 * Everything here is the connection's. Perch keeps no copy of a pull request, so this reads them
 * live and writes a review straight back — and the one thing it adds is the button that hands the
 * review to an agent.
 */
import "@perch/ui/i18n/code";
import { Badge, Button, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { connectionsQuery, pullRequestQuery, pullRequestsQuery } from "../lib/queries.ts";

function said(error: unknown): string {
  return error instanceof RequestFailed ? error.message : t("common.error");
}

/** Green, red, or still going. */
function checkTone(conclusion: string | null, status: string) {
  if (status !== "completed") return "warning" as const;
  return conclusion === "success" ? ("success" as const) : ("danger" as const);
}

export function PullRequestsPanel(props: {
  workspaceId: string;
  projectId: string;
  /** Opening the session the agent answers in is the route's business, not this panel's. */
  onOpenSession?: (sessionId: string) => void;
}) {
  const connections = useQuery(connectionsQuery(props.workspaceId));
  const [connectionId, setConnectionId] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const [note, setNote] = useState("");
  /** Said once the agent's session started, so the button never succeeds in silence. */
  const [started, setStarted] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const list = useQuery(pullRequestsQuery(props.workspaceId, props.projectId, connectionId));
  const one = useQuery(
    pullRequestQuery(props.workspaceId, props.projectId, connectionId, open ?? 0),
  );

  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: ["pull-requests", props.workspaceId, props.projectId],
    });

  const review = useMutation({
    mutationFn: async (verdict: "approve" | "request_changes" | "comment") =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/pull-requests/{number}/reviews", {
          params: {
            path: { ws: props.workspaceId, project: props.projectId, number: open ?? 0 },
          },
          body: {
            connection_id: connectionId,
            verdict,
            ...(note.trim() ? { body: note.trim() } : {}),
          },
        }),
      ),
    onSuccess: () => {
      setNote("");
      void refresh();
    },
  });

  const address = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/pull-requests/{number}/address", {
          params: {
            path: { ws: props.workspaceId, project: props.projectId, number: open ?? 0 },
          },
          body: { connection_id: connectionId },
        }),
      ),
    onMutate: () => setStarted(null),
    onSuccess: (made) => {
      // The session list shows it, and the route opens it in the panel.
      void queryClient.invalidateQueries({
        queryKey: ["sessions", props.workspaceId, props.projectId],
      });
      setStarted(t("pr.addressStarted", { branch: made.branch }));
      props.onOpenSession?.(made.session_id);
    },
  });

  const usable = connections.data ?? [];
  const pr = one.data;

  return (
    <div className="flex h-full flex-col gap-2 overflow-y-auto p-2" data-testid="pull-requests">
      <label className="flex items-center gap-2 text-sm">
        <span className="text-fg-muted">{t("git.connection")}</span>
        <select
          aria-label={t("git.connection")}
          className="rounded border border-border bg-surface px-2 py-1"
          value={connectionId}
          onChange={(event) => {
            setConnectionId(event.target.value);
            setOpen(null);
          }}
        >
          <option value="">{t("git.connectionNone")}</option>
          {usable.map((row) => (
            <option key={row.id} value={row.id}>
              {row.provider}
            </option>
          ))}
        </select>
      </label>

      {!connectionId ? (
        <p className="text-sm text-fg-subtle">{t("pr.pickConnection")}</p>
      ) : open === null ? (
        <ul aria-label={t("pr.title")} className="flex flex-col gap-1">
          {(list.data?.pull_requests ?? []).length === 0 ? (
            <li className="text-sm text-fg-subtle">{t("pr.none")}</li>
          ) : (
            (list.data?.pull_requests ?? []).map((row) => (
              <li key={row.number}>
                <button
                  type="button"
                  data-testid="pr-row"
                  className="flex w-full flex-col gap-0.5 rounded px-2 py-1 text-left hover:bg-surface-2"
                  onClick={() => setOpen(row.number)}
                >
                  <span className="truncate text-sm">
                    #{row.number} {row.title}
                  </span>
                  <span className="text-xs text-fg-subtle">
                    {row.head.branch} → {row.base.branch} · {row.author}
                    {row.draft ? ` · ${t("pr.draft")}` : ""}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
      ) : (
        <div className="flex flex-col gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setOpen(null);
              setStarted(null);
            }}
          >
            {t("pr.back")}
          </Button>
          {one.isPending ? (
            <p className="text-sm text-fg-muted">{t("common.loading")}</p>
          ) : pr ? (
            <>
              <span className="flex flex-wrap items-center gap-2">
                <a href={pr.url} className="font-medium hover:underline">
                  #{pr.number} {pr.title}
                </a>
                <span className="font-mono text-xs text-fg-subtle">{pr.head.branch}</span>
              </span>

              {pr.checks.length > 0 ? (
                <span className="flex flex-wrap items-center gap-1">
                  {pr.checks.map((check) => (
                    <Badge key={check.name} tone={checkTone(check.conclusion, check.status)}>
                      {check.name}
                    </Badge>
                  ))}
                </span>
              ) : null}

              <ul aria-label={t("pr.comments")} className="flex flex-col gap-1">
                {pr.comments.length === 0 ? (
                  <li className="text-sm text-fg-subtle">{t("pr.noComments")}</li>
                ) : (
                  pr.comments.map((comment) => (
                    <li
                      key={comment.id}
                      data-testid="pr-comment"
                      className="rounded border border-border bg-raised p-2 text-sm"
                    >
                      <span className="font-mono text-xs text-fg-subtle">
                        {comment.path}
                        {comment.line === null ? "" : `:${comment.line}`} · {comment.author}
                      </span>
                      <p className="whitespace-pre-wrap break-words">{comment.body}</p>
                    </li>
                  ))
                )}
              </ul>

              <label className="flex flex-col gap-1 text-sm">
                <span className="text-fg-muted">{t("pr.say")}</span>
                <textarea
                  className="min-h-16 rounded border border-border bg-surface px-2 py-1"
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                />
              </label>
              <span className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  disabled={review.isPending}
                  onClick={() => review.mutate("approve")}
                >
                  {t("pr.approve")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={review.isPending}
                  onClick={() => review.mutate("request_changes")}
                >
                  {t("pr.requestChanges")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={review.isPending}
                  onClick={() => review.mutate("comment")}
                >
                  {t("pr.comment")}
                </Button>
                <Button
                  size="sm"
                  disabled={address.isPending || pr.comments.length === 0}
                  onClick={() => address.mutate()}
                >
                  {t("pr.address")}
                </Button>
              </span>
              {started ? (
                <span role="status" className="text-sm text-fg-muted">
                  {started}
                </span>
              ) : null}
              {review.error || address.error ? (
                <span role="alert" className="text-sm text-danger">
                  {said(review.error ?? address.error)}
                </span>
              ) : null}
            </>
          ) : (
            <p role="alert" className="text-sm text-danger">
              {said(one.error)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
