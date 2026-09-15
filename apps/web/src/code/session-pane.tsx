/**
 * The session pane (spec §5.1, task 1.12): one agent session in the panel: its transcript
 * (replayed from the api, then live from the session:<id> topic), the permission prompt, the
 * usage and cost footer, a plan/build switch, the composer in session mode, rename, fork, cancel.
 */
import "@perch/ui/i18n/code";
import type { WsServerEnvelope } from "@perch/events";
// The pure diff helpers, not the schema barrel: it would bring Zod into the bundle (ADR-0079).
import { parseHunks } from "@perch/events/diff";
import { Badge, Button, Composer, Dialog, Input, t } from "@perch/ui";
import { type DiffDecisionKind, type DiffFileView, DiffView } from "@perch/ui/diff";
import { type CodeBlock, type PermissionAnswerKind, SessionTranscript } from "@perch/ui/session";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitFork, Pencil, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, unwrap } from "../lib/api.ts";
import {
  checkpointsQuery,
  fsKey,
  type SessionEventRecord,
  sessionDiffQuery,
  sessionQuery,
} from "../lib/queries.ts";
import { getSocket } from "../lib/ws.ts";
import { type ContextChip, useContextChips, withChips } from "./context-store.ts";
import { editorFor, useEditorStore } from "./editor-store.ts";
import { reduceTranscript, type TranscriptRecord } from "./transcript.ts";

type Mode = "plan" | "build";

/** The transcript so far: a replay, then every event the topic announces (deltas inline). */
function useTranscript(sessionId: string) {
  const [records, setRecords] = useState<TranscriptRecord[]>([]);
  const [answers, setAnswers] = useState<Map<string, PermissionAnswerKind>>(() => new Map());
  const lastSeq = useRef(0);
  const fetching = useRef<Promise<void> | null>(null);
  const queryClient = useQueryClient();

  const fetchAfter = useCallback(
    async (after: number) => {
      const result = unwrap(
        await api.GET("/api/sessions/{s}/events", {
          params: { path: { s: sessionId }, query: { after_seq: after, limit: 1000 } },
        }),
      );
      const rows = result.events as SessionEventRecord[];
      setRecords((current) => {
        const known = new Set(current.map((r) => r.seq));
        const fresh = rows
          .filter((r) => !known.has(r.seq))
          .map((r) => ({ seq: r.seq, event: r.event as TranscriptRecord["event"] }));
        if (fresh.length === 0) return current;
        const merged = [...current, ...fresh].sort((a, b) => a.seq - b.seq);
        lastSeq.current = merged.at(-1)?.seq ?? lastSeq.current;
        return merged;
      });
    },
    [sessionId],
  );

  const catchUp = useCallback(() => {
    if (fetching.current) return fetching.current;
    const run = fetchAfter(lastSeq.current).finally(() => {
      fetching.current = null;
    });
    fetching.current = run;
    return run;
  }, [fetchAfter]);

  useEffect(() => {
    setRecords([]);
    setAnswers(new Map());
    lastSeq.current = 0;
    void catchUp();
    const socket = getSocket();
    const topic = `session:${sessionId}`;
    socket.subscribe(topic);
    const off = socket.onEvent((envelope: WsServerEnvelope) => {
      if (envelope.topic !== topic) return;
      const payload = envelope.payload as {
        seq?: number;
        delta?: string;
        permissionId?: string;
        answer?: PermissionAnswerKind;
      };
      if (envelope.type === "session.delta" && typeof payload.seq === "number") {
        if (payload.seq === lastSeq.current + 1 && typeof payload.delta === "string") {
          lastSeq.current = payload.seq;
          const delta = payload.delta;
          setRecords((current) => [
            ...current,
            { seq: payload.seq as number, event: { type: "text", delta } },
          ]);
        } else {
          void catchUp();
        }
        return;
      }
      if (envelope.type === "session.permission_answered" && payload.permissionId) {
        const id = payload.permissionId;
        const answer = payload.answer ?? "allow";
        setAnswers((current) => new Map(current).set(id, answer));
      }
      if (envelope.type === "session.status" || envelope.type === "session.done") {
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
      }
      void catchUp();
    });
    return () => {
      off();
      socket.unsubscribe(topic);
    };
  }, [sessionId, catchUp, queryClient]);

  return { records, answers, catchUp };
}

type View = "transcript" | "changes";
/** Which diff the Changes view shows: the whole session or one turn. */
type Scope = "all" | number;

const decisionKey = (path: string, header: string) => `${path}@@${header}`;

export type SessionPaneProps = {
  workspaceId: string;
  projectId: string;
  sessionId: string;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
};

/** One array, so the chip selector does not hand React a new one on every render. */
const EMPTY_CHIPS: ContextChip[] = [];

export function SessionPane(props: SessionPaneProps) {
  const { sessionId } = props;
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery(sessionId));
  const { records, answers, catchUp } = useTranscript(sessionId);
  const status = session.data?.status ?? "idle";
  const running = status === "running" || status === "needs_you";
  const transcript = useMemo(
    () => reduceTranscript(records, answers, status === "running"),
    [records, answers, status],
  );
  const [mode, setMode] = useState<Mode>("build");
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [view, setView] = useState<View>("transcript");
  const [scope, setScope] = useState<Scope>("all");
  /** Hunks accepted in this view: a review decision, the edit itself is already in the tree (ADR-0079). */
  const [accepted, setAccepted] = useState<ReadonlySet<string>>(() => new Set());
  const [reviewing, setReviewing] = useState(false);
  const [restoreTurn, setRestoreTurn] = useState<number | null>(null);
  const checkpoints = useQuery({ ...checkpointsQuery(sessionId), enabled: view === "changes" });
  const diff = useQuery({
    ...sessionDiffQuery(sessionId, scope === "all" ? null : scope),
    enabled: view === "changes",
  });
  const files = useMemo<DiffFileView[]>(
    () =>
      (diff.data?.files ?? []).map((file) => ({
        path: file.path,
        ...(file.oldPath ? { oldPath: file.oldPath } : {}),
        ...(file.status ? { status: file.status } : {}),
        additions: file.additions,
        deletions: file.deletions,
        binary: /\nBinary files .* differ/.test(file.patch),
        hunks: parseHunks(file.patch).hunks.map((hunk, index) => ({
          index,
          header: hunk.header,
          lines: hunk.lines,
          ...(accepted.has(decisionKey(file.path, hunk.header))
            ? { decision: "accept" as const }
            : {}),
        })),
      })),
    [diff.data, accepted],
  );

  useEffect(() => {
    if (session.data?.mode) setMode(session.data.mode);
  }, [session.data?.mode]);

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ["session", sessionId] });
    void queryClient.invalidateQueries({
      queryKey: ["sessions", props.workspaceId, props.projectId],
    });
  }, [queryClient, sessionId, props.workspaceId, props.projectId]);

  const act = useCallback(
    async (run: () => Promise<unknown>) => {
      setError(null);
      try {
        await run();
        refresh();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    },
    [refresh],
  );

  // What the Preview tab put on the turn (task 2.16): the element that was clicked, the console
  // line that was sent over, the screenshot that was taken. They ride once and are then cleared.
  const projectId = props.projectId;
  const chips = useContextChips((store) => store.byProject[projectId] ?? EMPTY_CHIPS);
  const dropChip = useContextChips((store) => store.remove);
  const clearChips = useContextChips((store) => store.clear);

  const send = useCallback(
    (text: string) =>
      act(async () => {
        const turn = await api.POST("/api/sessions/{s}/turns", {
          params: { path: { s: sessionId } },
          body: { text: withChips(text, chips), mode },
        });
        clearChips(projectId);
        return unwrap(turn);
      }),
    [act, sessionId, mode, chips, clearChips, projectId],
  );

  const cancel = useCallback(
    () =>
      act(async () =>
        unwrap(await api.POST("/api/sessions/{s}/cancel", { params: { path: { s: sessionId } } })),
      ),
    [act, sessionId],
  );

  const answer = useCallback(
    (id: string, choice: PermissionAnswerKind) =>
      act(async () =>
        unwrap(
          await api.POST("/api/sessions/{s}/permissions/{id}", {
            params: { path: { s: sessionId, id } },
            body: { answer: choice },
          }),
        ),
      ),
    [act, sessionId],
  );

  const rename = useCallback(
    (value: string) =>
      act(async () => {
        await unwrap(
          await api.PATCH("/api/sessions/{s}", {
            params: { path: { s: sessionId } },
            body: { title: value.trim() || null },
          }),
        );
        setRenaming(false);
      }),
    [act, sessionId],
  );

  const fork = useCallback(
    () =>
      act(async () => {
        const created = unwrap(
          await api.POST("/api/sessions/{s}/fork", { params: { path: { s: sessionId } } }),
        );
        props.onOpenSession(created.id);
      }),
    [act, sessionId, props.onOpenSession],
  );

  /** The disk changed under the editor and the tree: fetch both again. */
  const filesChanged = useCallback(
    (paths?: readonly string[]) => {
      useEditorStore.getState().reload(props.projectId, paths);
      void queryClient.invalidateQueries({ queryKey: fsKey(props.workspaceId, props.projectId) });
      void queryClient.invalidateQueries({ queryKey: ["session", sessionId, "diff"] });
    },
    [queryClient, props.projectId, props.workspaceId, sessionId],
  );

  const reject = useCallback(
    async (decisions: { path: string; hunk: number; header: string }[]) => {
      if (decisions.length === 0) return;
      setReviewing(true);
      setError(null);
      try {
        const result = unwrap(
          await api.POST("/api/sessions/{s}/diff/apply", {
            params: { path: { s: sessionId } },
            body: {
              ...(scope === "all" ? {} : { turn: scope }),
              decisions: decisions.map((d) => ({ ...d, action: "reject" as const })),
            },
          }),
        );
        filesChanged(result.files);
        refresh();
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : String(failure));
        // The diff may have moved on under us (409): show what is actually there now.
        void queryClient.invalidateQueries({ queryKey: ["session", sessionId, "diff"] });
      } finally {
        setReviewing(false);
      }
    },
    [sessionId, scope, filesChanged, refresh, queryClient],
  );

  const decide = useCallback(
    (path: string, hunkIndex: number, action: DiffDecisionKind) => {
      const file = files.find((f) => f.path === path);
      const hunk = file?.hunks.find((h) => h.index === hunkIndex);
      if (!hunk) return;
      if (action === "accept") {
        setAccepted((current) => new Set(current).add(decisionKey(path, hunk.header)));
        return;
      }
      void reject([{ path, hunk: hunk.index, header: hunk.header }]);
    },
    [files, reject],
  );

  const decideFile = useCallback(
    (path: string, action: DiffDecisionKind) => {
      const file = files.find((f) => f.path === path);
      if (!file) return;
      const open = file.hunks.filter((h) => !h.decision);
      if (action === "accept") {
        setAccepted((current) => {
          const next = new Set(current);
          for (const hunk of open) next.add(decisionKey(path, hunk.header));
          return next;
        });
        return;
      }
      void reject(open.map((h) => ({ path, hunk: h.index, header: h.header })));
    },
    [files, reject],
  );

  const restore = useCallback(
    (turn: number) =>
      act(async () => {
        const result = unwrap(
          await api.POST("/api/sessions/{s}/checkpoints/{turn}/restore", {
            params: { path: { s: sessionId, turn } },
          }),
        );
        setRestoreTurn(null);
        setAccepted(new Set());
        filesChanged(result.files);
        await catchUp();
      }),
    [act, sessionId, filesChanged, catchUp],
  );

  const apply = useCallback(
    (block: CodeBlock) =>
      act(async () => {
        const target = block.path ?? editorFor(useEditorStore.getState(), props.projectId).active;
        if (!target) throw new Error(t("session.applyNoTarget"));
        const content = block.code.endsWith("\n") ? block.code : `${block.code}\n`;
        unwrap(
          await api.PUT("/api/workspaces/{ws}/projects/{project}/fs/write", {
            params: { path: { ws: props.workspaceId, project: props.projectId } },
            body: { path: target, content, encoding: "utf8" },
          }),
        );
        useEditorStore.getState().saved(props.projectId, target, content);
        filesChanged([target]);
        setNotice(t("session.applied", { path: target }));
        setScope("all");
        setView("changes");
      }),
    [act, props.projectId, props.workspaceId, filesChanged],
  );

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 3_000);
    return () => clearTimeout(timer);
  }, [notice]);

  const name = session.data?.title ?? t("session.untitled");
  const usage = transcript.usage;
  const tabs: { id: View; label: string }[] = [
    { id: "transcript", label: t("session.tab.transcript") },
    { id: "changes", label: t("session.tab.changes") },
  ];
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="session-pane">
      <div className="flex items-center gap-2 border-border border-b px-3 py-2">
        {renaming ? (
          <form
            className="flex min-w-0 flex-1 items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void rename(title);
            }}
          >
            <Input
              aria-label={t("session.renameLabel")}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="h-8"
            />
            <Button type="submit" size="sm">
              {t("common.save")}
            </Button>
          </form>
        ) : (
          <h2 className="min-w-0 flex-1 truncate font-semibold" data-testid="session-title">
            {name}
          </h2>
        )}
        <Badge
          tone={status === "error" ? "danger" : status === "needs_you" ? "warning" : "neutral"}
        >
          <span data-testid="session-status">{t(`session.status.${status}`)}</span>
        </Badge>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("session.rename")}
          onClick={() => {
            setTitle(session.data?.title ?? "");
            setRenaming(true);
          }}
        >
          <Pencil aria-hidden className="size-4" />
        </Button>
        <Button
          size="sm"
          variant="ghost"
          aria-label={t("session.fork")}
          disabled={running}
          onClick={() => void fork()}
        >
          <GitFork aria-hidden className="size-4" />
        </Button>
        <Button size="sm" variant="ghost" aria-label={t("session.close")} onClick={props.onClose}>
          <X aria-hidden className="size-4" />
        </Button>
      </div>
      {session.data?.forked_from_id ? (
        <p className="px-3 py-1 text-fg-muted text-xs">{t("session.forkedFrom")}</p>
      ) : null}
      <div
        role="tablist"
        aria-label={t("session.tabs")}
        className="flex items-center gap-1 border-border border-b px-3 py-1"
      >
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`session-tab-${tab.id}-${sessionId}`}
            aria-selected={view === tab.id}
            aria-controls={`session-view-${tab.id}-${sessionId}`}
            className={
              view === tab.id
                ? "rounded bg-accent-soft px-2 py-0.5 text-sm"
                : "rounded px-2 py-0.5 text-fg-muted text-sm hover:bg-raised"
            }
            onClick={() => setView(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {view === "transcript" ? (
        <div
          role="tabpanel"
          id={`session-view-transcript-${sessionId}`}
          aria-labelledby={`session-tab-transcript-${sessionId}`}
          className="flex min-h-0 flex-1 flex-col"
        >
          <SessionTranscript
            items={transcript.items}
            status={status}
            onPermission={(id, choice) => void answer(id, choice)}
            onRestore={running ? undefined : (turn) => setRestoreTurn(turn)}
            onApply={(block) => void apply(block)}
          />
        </div>
      ) : (
        <div
          role="tabpanel"
          id={`session-view-changes-${sessionId}`}
          aria-labelledby={`session-tab-changes-${sessionId}`}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="flex items-center gap-2 px-3 py-1 text-xs">
            <select
              aria-label={t("session.scope")}
              className="h-7 rounded border border-border bg-surface px-1 text-sm"
              value={scope === "all" ? "all" : String(scope)}
              onChange={(event) => {
                const value = event.target.value;
                setScope(value === "all" ? "all" : Number(value));
                setAccepted(new Set());
              }}
            >
              <option value="all">{t("session.scope.all")}</option>
              {(checkpoints.data ?? []).map((checkpoint) => (
                <option key={checkpoint.turn} value={String(checkpoint.turn)}>
                  {t("session.scope.turn", { turn: String(checkpoint.turn) })}
                </option>
              ))}
            </select>
            {diff.isError ? <span className="text-danger">{t("session.diffError")}</span> : null}
          </div>
          <DiffView
            files={files}
            busy={reviewing || running}
            onDecide={decide}
            onDecideFile={decideFile}
            onOpen={(path) => useEditorStore.getState().open(props.projectId, path)}
          />
        </div>
      )}
      <Dialog
        open={restoreTurn !== null}
        onOpenChange={(open) => {
          if (!open) setRestoreTurn(null);
        }}
        title={t("session.restoreTitle", { turn: String(restoreTurn ?? 0) })}
        description={t("session.restoreBody")}
      >
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setRestoreTurn(null)}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            onClick={() => {
              if (restoreTurn !== null) void restore(restoreTurn);
            }}
          >
            {t("session.restoreConfirm")}
          </Button>
        </div>
      </Dialog>
      {notice ? (
        <p role="status" className="px-3 py-1 text-fg-muted text-xs">
          {notice}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="px-3 py-1 text-danger text-sm">
          {error}
        </p>
      ) : null}
      <div className="border-border border-t px-3 py-2">
        <div className="mb-2 flex items-center justify-between gap-2 text-fg-muted text-xs">
          <fieldset className="flex items-center gap-1" aria-label={t("session.modeLabel")}>
            {(["plan", "build"] as const).map((option) => (
              <label
                key={option}
                className={
                  mode === option
                    ? "rounded bg-accent-soft px-2 py-0.5 text-fg"
                    : "rounded px-2 py-0.5 hover:bg-raised"
                }
              >
                <input
                  type="radio"
                  name={`mode-${sessionId}`}
                  value={option}
                  className="sr-only"
                  checked={mode === option}
                  onChange={() => setMode(option)}
                />
                {t(`session.mode.${option}`)}
              </label>
            ))}
          </fieldset>
          <span data-testid="session-usage">
            {t("session.usage", {
              input: String(usage.input),
              output: String(usage.output),
              cost: usage.costUsd.toFixed(4),
            })}
          </span>
          {running ? (
            <Button size="sm" variant="ghost" onClick={() => void cancel()}>
              {t("session.cancel")}
            </Button>
          ) : null}
        </div>
        {chips.length > 0 ? (
          <ul
            aria-label={t("inspect.chips")}
            data-testid="context-chips"
            className="flex flex-wrap gap-1"
          >
            {chips.map((chip) => (
              <li key={chip.id}>
                <Badge tone="accent">
                  <span className="max-w-40 truncate">{chip.label}</span>
                  <button
                    type="button"
                    className="ml-1"
                    aria-label={t("inspect.chipRemove", { name: chip.label })}
                    onClick={() => dropChip(projectId, chip.id)}
                  >
                    ×
                  </button>
                </Badge>
              </li>
            ))}
          </ul>
        ) : null}
        <Composer
          draftKey={`session:${sessionId}`}
          placeholder={t("session.composerPlaceholder")}
          label={t("session.composerLabel")}
          onSend={send}
          onCancel={() => void cancel()}
          running={running}
          disabled={status === "ended"}
        />
      </div>
    </div>
  );
}
