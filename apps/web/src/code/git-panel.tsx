/**
 * The Git panel (spec §4 "drawer: terminal, console, git, problems"; §5.1; task 1.20).
 *
 * What changed, what to include, a message you can write or have written for you, and the two
 * buttons that get it somewhere else: Push, and Open PR. Everything runs on the project's runner;
 * the credentials for the last two come from a connection and are minted for that one call.
 */
import "@perch/ui/i18n/code";
import { Button, EmptyState, Field, Input, t } from "@perch/ui";
import { VirtualList } from "@perch/ui/virtual-list";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useId, useMemo, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { connectionsQuery, gitBranchesQuery, gitStatusQuery } from "../lib/queries.ts";

function message(error: unknown): string {
  return error instanceof RequestFailed ? error.message : t("common.error");
}

/** What the scanner found, when a commit was stopped by one (task 2.12). */
export type SecretFinding = { name: string; path: string; line: number; sample: string };

export function findingsIn(error: unknown): SecretFinding[] {
  if (!(error instanceof RequestFailed) || error.code !== "policy_violation") return [];
  const found = error.details?.findings;
  if (!Array.isArray(found)) return [];
  return found.filter(
    (one): one is SecretFinding =>
      typeof one === "object" &&
      one !== null &&
      typeof (one as SecretFinding).path === "string" &&
      typeof (one as SecretFinding).name === "string",
  );
}

/** The letter git uses for a change, as a word. */
function statusLabel(file: { index: string; working_tree: string }): string {
  const code = (file.working_tree.trim() || file.index.trim() || "?").toUpperCase();
  const key = ["M", "A", "D", "R", "?"].includes(code) ? code : "M";
  return t(`git.status.${key}` as "git.status.M");
}

export function GitPanel(props: { workspaceId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const status = useQuery(gitStatusQuery(props.workspaceId, props.projectId));
  const branches = useQuery(gitBranchesQuery(props.workspaceId, props.projectId));
  const connections = useQuery(connectionsQuery(props.workspaceId));
  const [selected, setSelected] = useState<string[]>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [blocked, setBlocked] = useState<SecretFinding[]>([]);
  /** Bot directories the last sync could not read (task 3.1). */
  const [botErrors, setBotErrors] = useState<{ handle: string; error: string }[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [prTitle, setPrTitle] = useState("");
  const messageId = useId();
  const branchId = useId();
  const prId = useId();

  const files = useMemo(() => status.data?.files ?? [], [status.data]);
  const paths = useMemo(() => files.map((file) => file.path), [files]);
  // A file that stopped being changed stops being selected; the rest of the choice survives.
  useEffect(() => {
    setSelected((previous) => previous.filter((path) => paths.includes(path)));
  }, [paths]);

  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ["git", props.workspaceId, props.projectId] }),
      queryClient.invalidateQueries({ queryKey: ["fs", props.workspaceId, props.projectId] }),
    ]);

  const chosen = selected.length > 0 ? selected : paths;

  const draft = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/git/message", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: selected.length > 0 ? { paths: selected } : {},
        }),
      ),
    onSuccess: (drafted) => {
      setText(drafted.message);
      setError(null);
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const commit = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/git/commit", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: { message: text.trim(), ...(selected.length > 0 ? { paths: selected } : {}) },
        }),
      ),
    onSuccess: async (made) => {
      setNote(t("git.committed", { commit: made.commit.slice(0, 7) }));
      setError(null);
      setBlocked([]);
      setText("");
      setSelected([]);
      await refresh();
    },
    onError: (err: unknown) => {
      // A commit stopped by the scanner is a card, not a line of red text (spec §5.7; task 2.12).
      const found = findingsIn(err);
      setBlocked(found);
      setError(found.length > 0 ? null : message(err));
    },
  });

  const push = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/git/push", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: connectionId ? { connection_id: connectionId } : {},
        }),
      ),
    onSuccess: async (pushed) => {
      setNote(t("git.pushed", { remote: pushed.remote }));
      setError(null);
      await refresh();
    },
    onError: (err: unknown) => setError(message(err)),
  });

  /**
   * A push hot-reloads this project's spec bots on its own (spec §5.3; task 3.1). This is for when
   * the files changed without one — a pull, an edit in the editor — and for seeing what went wrong
   * with a bot the repository defines.
   */
  const reloadBots = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/bots/reload", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
        }),
      ),
    onSuccess: (synced) => {
      setError(null);
      setNote(
        t("git.botsSynced", {
          added: synced.added.length,
          updated: synced.updated.length,
          removed: synced.removed.length,
        }),
      );
      setBotErrors(synced.failed);
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const openPr = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/pull-request", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: { connection_id: connectionId, title: prTitle.trim() || text.split("\n")[0] || "" },
        }),
      ),
    onSuccess: (pr) => {
      setNote(t("git.prOpened", { number: pr.number }));
      setError(null);
      setPrTitle("");
    },
    onError: (err: unknown) => setError(message(err)),
  });

  const branch = useMutation({
    mutationFn: async (input: { name: string; create: boolean }) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/git/branches", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: input,
        }),
      ),
    onSuccess: async () => {
      setError(null);
      setNewBranch("");
      await refresh();
    },
    onError: (err: unknown) => setError(message(err)),
  });

  if (status.isError) {
    return (
      <div className="p-3">
        <EmptyState title={t("git.title")} hint={message(status.error)} />
      </div>
    );
  }

  const current = status.data?.branch ?? branches.data?.current ?? "";
  const usable = connections.data ?? [];

  return (
    <section aria-label={t("git.title")} className="flex h-full flex-col gap-3 overflow-auto p-3">
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-fg-muted">{t("git.branch")}</span>
          <select
            id={branchId}
            aria-label={t("git.branch")}
            className="h-8 min-w-40 rounded-md border border-border bg-bg px-2 text-sm"
            value={current}
            onChange={(event) => branch.mutate({ name: event.target.value, create: false })}
          >
            {(branches.data?.branches ?? [current]).filter(Boolean).map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </label>
        <form
          className="flex items-end gap-1"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            if (newBranch.trim()) branch.mutate({ name: newBranch.trim(), create: true });
          }}
        >
          <Field id={`${branchId}-new`} label={t("git.branchNew")}>
            {(control) => (
              <Input
                {...control}
                value={newBranch}
                placeholder="perch/fix-login"
                onChange={(event) => setNewBranch(event.target.value)}
                className="w-48"
              />
            )}
          </Field>
          <Button type="submit" size="sm" variant="ghost" disabled={!newBranch.trim()}>
            {t("git.branchCreate")}
          </Button>
        </form>
        {status.data && (status.data.ahead > 0 || status.data.behind > 0) ? (
          <p className="text-sm text-fg-muted">
            {t("git.tracking", { ahead: status.data.ahead, behind: status.data.behind })}
          </p>
        ) : null}
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t("git.changes")}</h3>
          {files.length > 0 ? (
            <div className="flex items-center gap-1">
              <span className="text-sm text-fg-muted">
                {t("git.stagedCount", { count: chosen.length })}
              </span>
              <Button size="sm" variant="ghost" onClick={() => setSelected(paths)}>
                {t("git.selectAll")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setSelected([])}>
                {t("git.selectNone")}
              </Button>
            </div>
          ) : null}
        </div>
        {files.length === 0 ? (
          <p role="status" className="text-sm text-fg-subtle">
            {t("git.clean")}
          </p>
        ) : (
          // A refactor can touch thousands of files; the panel renders the window (ADR-0113).
          <VirtualList
            rows={files}
            label={t("git.changes")}
            keyOf={(file) => file.path}
            estimateSize={24}
            className="max-h-[40vh]"
          >
            {(file) => (
              <div className="flex items-center gap-2 py-0.5 text-sm">
                <input
                  type="checkbox"
                  aria-label={file.path}
                  checked={selected.includes(file.path)}
                  onChange={(event) =>
                    setSelected((previous) =>
                      event.target.checked
                        ? [...previous, file.path]
                        : previous.filter((path) => path !== file.path),
                    )
                  }
                />
                <span className="w-20 shrink-0 text-fg-muted">{statusLabel(file)}</span>
                <span className="truncate font-mono">{file.path}</span>
              </div>
            )}
          </VirtualList>
        )}
      </div>

      <div className="flex flex-col gap-2">
        <Field id={messageId} label={t("git.message")}>
          {(control) => (
            <textarea
              {...control}
              rows={3}
              value={text}
              onChange={(event) => setText(event.target.value)}
              className="w-full rounded-md border border-border bg-bg p-2 font-mono text-sm"
            />
          )}
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={files.length === 0 || draft.isPending}
            onClick={() => draft.mutate()}
          >
            {draft.isPending ? t("git.drafting") : t("git.draft")}
          </Button>
          <Button
            size="sm"
            disabled={files.length === 0 || !text.trim() || commit.isPending}
            onClick={() => commit.mutate()}
          >
            {t("git.commit")}
          </Button>
          <label className="flex items-center gap-1 text-sm">
            <span className="text-fg-muted">{t("git.connection")}</span>
            <select
              aria-label={t("git.connection")}
              className="h-8 rounded-md border border-border bg-bg px-2 text-sm"
              value={connectionId}
              onChange={(event) => setConnectionId(event.target.value)}
            >
              <option value="">{t("git.connectionNone")}</option>
              {usable.map((row) => (
                <option key={row.id} value={row.id}>
                  {row.provider_name} · {row.account ?? row.provider}
                </option>
              ))}
            </select>
          </label>
          <Button size="sm" variant="ghost" disabled={push.isPending} onClick={() => push.mutate()}>
            {t("git.push")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={reloadBots.isPending}
            onClick={() => reloadBots.mutate()}
          >
            {t("git.reloadBots")}
          </Button>
        </div>
        {botErrors.length > 0 ? (
          <ul aria-label={t("git.reloadBots")} className="flex flex-col gap-1">
            {botErrors.map((one) => (
              <li key={one.handle} data-testid="bot-sync-error" className="text-sm text-danger">
                {t("git.botsFailed", { handle: one.handle, error: one.error })}
              </li>
            ))}
          </ul>
        ) : null}
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            openPr.mutate();
          }}
        >
          <Field id={prId} label={t("git.prTitle")}>
            {(control) => (
              <Input
                {...control}
                value={prTitle}
                onChange={(event) => setPrTitle(event.target.value)}
                className="w-64"
              />
            )}
          </Field>
          <Button
            type="submit"
            size="sm"
            variant="ghost"
            disabled={!connectionId || openPr.isPending}
          >
            {t("git.openPr")}
          </Button>
          {usable.length === 0 ? (
            <p className="text-sm text-fg-subtle">{t("git.noConnection")}</p>
          ) : null}
        </form>
      </div>

      {blocked.length > 0 ? (
        <section
          role="alert"
          aria-label={t("git.secrets.title")}
          data-testid="secrets-card"
          className="flex flex-col gap-1 rounded border border-danger bg-raised p-2"
        >
          <h3 className="text-sm font-semibold text-danger">{t("git.secrets.title")}</h3>
          <ul className="flex flex-col gap-0.5 text-sm">
            {blocked.map((one) => (
              <li key={`${one.path}:${one.line}:${one.sample}`}>
                {t("git.secrets.found", {
                  name: one.name,
                  path: one.path,
                  line: one.line,
                  sample: one.sample,
                })}
              </li>
            ))}
          </ul>
          <p className="text-sm text-fg-muted">{t("git.secrets.hint")}</p>
          <div>
            <Button size="sm" variant="ghost" onClick={() => setBlocked([])}>
              {t("git.secrets.dismiss")}
            </Button>
          </div>
        </section>
      ) : null}
      {note ? (
        <p role="status" data-testid="git-note" className="text-sm text-success">
          {note}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </section>
  );
}
