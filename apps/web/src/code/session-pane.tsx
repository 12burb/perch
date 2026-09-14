/**
 * The session pane (spec §5.1, task 1.12): one agent session in the panel: its transcript
 * (replayed from the api, then live from the session:<id> topic), the permission prompt, the
 * usage and cost footer, a plan/build switch, the composer in session mode, rename, fork, cancel.
 */
import type { WsServerEnvelope } from "@perch/events";
import { Badge, Button, Composer, Input, t } from "@perch/ui";
import { type PermissionAnswerKind, SessionTranscript } from "@perch/ui/session";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { GitFork, Pencil, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, unwrap } from "../lib/api.ts";
import { type SessionEventRecord, sessionQuery } from "../lib/queries.ts";
import { getSocket } from "../lib/ws.ts";
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

  return { records, answers };
}

export type SessionPaneProps = {
  workspaceId: string;
  projectId: string;
  sessionId: string;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
};

export function SessionPane(props: SessionPaneProps) {
  const { sessionId } = props;
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery(sessionId));
  const { records, answers } = useTranscript(sessionId);
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

  const send = useCallback(
    (text: string) =>
      act(async () =>
        unwrap(
          await api.POST("/api/sessions/{s}/turns", {
            params: { path: { s: sessionId } },
            body: { text, mode },
          }),
        ),
      ),
    [act, sessionId, mode],
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

  const name = session.data?.title ?? t("session.untitled");
  const usage = transcript.usage;
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
      <SessionTranscript
        items={transcript.items}
        status={status}
        onPermission={(id, choice) => void answer(id, choice)}
      />
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
