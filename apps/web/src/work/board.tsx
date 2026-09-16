import "@perch/ui/i18n/work";
import { Badge, Button, EmptyState, Field, Input, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { SquareKanban } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import { projectsQuery, workItemsQuery } from "../lib/queries.ts";
import { getSocket } from "../lib/ws.ts";

/**
 * The board (spec §4 "Work (Plane)"; task 3.13). One column per state, in the order §4 names them,
 * and a card per item.
 *
 * Two of the columns are not opinions. `Running` and `Needs you` are where the agent doing the
 * item is, moved by the session rather than by anybody dragging a card — which is why this list
 * listens on the workspace topic and refetches when a `work_item.*` event arrives: the board
 * changes while you are looking at it.
 *
 * Moving a card by hand is a `<select>` rather than a drag, because a drag is a mouse and this
 * has to work on a phone (spec §4: every flow at 390 px).
 */

type Board = ReturnType<typeof useBoard>["data"];
type Item = NonNullable<Board>["items"][number];
type State = Item["state"];

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

function useBoard(workspaceId: string, projectId: string) {
  return useQuery(workItemsQuery(workspaceId, projectId));
}

/** The board changes while you are looking at it, because the sessions doing its items do. */
function useLiveBoard(workspaceId: string, projectId: string) {
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!projectId) return;
    const socket = getSocket();
    socket.subscribe(`ws:${workspaceId}`);
    return socket.onEvent((envelope) => {
      if (envelope.topic === `ws:${workspaceId}` && envelope.type.startsWith("work_item.")) {
        void queryClient.invalidateQueries({
          queryKey: ["workspace", workspaceId, "work", projectId],
        });
      }
    });
  }, [queryClient, workspaceId, projectId]);
}

/** 1 urgent … 4 low; 0 has no badge at all (spec §4's quick-add writes these as `p1`). */
const PRIORITY = {
  1: "work.priority.1",
  2: "work.priority.2",
  3: "work.priority.3",
  4: "work.priority.4",
} as const;

const TONE: Partial<Record<State, "neutral" | "success" | "danger" | "warning">> = {
  running: "success",
  needs_you: "warning",
  in_review: "neutral",
  done: "success",
  cancelled: "neutral",
};

export function WorkMain(props: { workspaceId: string; workspaceSlug: string }) {
  const projects = useQuery(projectsQuery(props.workspaceId)).data ?? [];
  const [projectId, setProjectId] = useState("");
  const chosen = projectId || projects[0]?.id || "";
  useLiveBoard(props.workspaceId, chosen);
  const board = useBoard(props.workspaceId, chosen);

  if (projects.length === 0) {
    return (
      <EmptyState
        icon={<SquareKanban className="size-8" aria-hidden="true" />}
        title={t("shell.work.emptyTitle")}
        hint={t("shell.work.emptyHint")}
      />
    );
  }

  return (
    <section aria-labelledby="board-heading" className="flex min-h-0 flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="board-heading" className="text-md font-semibold">
          {t("work.board")}
        </h2>
        <label className="flex items-center gap-2 text-sm">
          <span className="text-fg-muted">{t("work.project")}</span>
          <select
            className="min-h-touch rounded border border-border bg-surface px-2 py-1"
            value={chosen}
            onChange={(event) => setProjectId(event.currentTarget.value)}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      <AddItem workspaceId={props.workspaceId} projectId={chosen} />

      {board.data && board.data.items.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("work.empty")}</p>
      ) : null}

      {/* Columns scroll sideways on a phone and sit side by side on a desk. */}
      <div className="flex min-h-0 gap-3 overflow-x-auto pb-2">
        {(board.data?.states ?? []).map((state) => (
          <Column
            key={state}
            state={state}
            items={(board.data?.items ?? []).filter((item) => item.state === state)}
            states={board.data?.states ?? []}
            workspaceId={props.workspaceId}
            workspaceSlug={props.workspaceSlug}
            projectId={chosen}
          />
        ))}
      </div>
    </section>
  );
}

function Column(props: {
  state: State;
  items: Item[];
  states: State[];
  workspaceId: string;
  workspaceSlug: string;
  projectId: string;
}) {
  return (
    <section
      aria-label={t("work.column", {
        state: t(`work.state.${props.state}`),
        count: props.items.length,
      })}
      className="flex w-64 shrink-0 flex-col gap-2"
    >
      <h3 className="flex items-center gap-2 text-sm font-medium">
        {t(`work.state.${props.state}`)}
        <span className="text-fg-muted">{props.items.length}</span>
      </h3>
      {/* A column scrolls on its own, so a long backlog does not stretch the page. */}
      <ul className="flex max-h-[70vh] flex-col gap-2 overflow-y-auto">
        {props.items.map((item) => (
          <li key={item.id}>
            <Card
              item={item}
              states={props.states}
              workspaceId={props.workspaceId}
              workspaceSlug={props.workspaceSlug}
              projectId={props.projectId}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

function Card(props: {
  item: Item;
  states: State[];
  workspaceId: string;
  workspaceSlug: string;
  projectId: string;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const refresh = () =>
    queryClient.invalidateQueries({
      queryKey: ["workspace", props.workspaceId, "work", props.projectId],
    });

  const move = useMutation({
    mutationFn: async (state: State) =>
      unwrap(
        await api.PATCH("/api/work-items/{id}", {
          params: { path: { id: props.item.id } },
          body: { state },
        }),
      ),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (err) => setError(message(err)),
  });

  const hand = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/work-items/{id}/start-session", {
          params: { path: { id: props.item.id } },
          body: {},
        }),
      ),
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (err) => setError(message(err)),
  });

  return (
    <article className="flex flex-col gap-2 rounded border border-border bg-surface p-3">
      <div className="flex items-center gap-2">
        <span className="font-mono text-sm text-fg-muted">{props.item.identifier}</span>
        <Badge tone={TONE[props.item.state] ?? "neutral"}>
          {t(`work.type.${props.item.type}`)}
        </Badge>
        {props.item.priority in PRIORITY ? (
          <Badge tone={props.item.priority === 1 ? "danger" : "neutral"}>
            {t(PRIORITY[props.item.priority as keyof typeof PRIORITY])}
          </Badge>
        ) : null}
      </div>
      <p className="text-sm">{props.item.title}</p>

      {props.item.session_id ? (
        <Link
          to="/$workspace/code/$project"
          params={{ workspace: props.workspaceSlug, project: props.projectId }}
          search={{ session: props.item.session_id }}
          className="text-sm underline"
        >
          {t("work.openSession")}
        </Link>
      ) : null}
      {props.item.pr_url ? (
        <a href={props.item.pr_url} className="text-sm underline" rel="noreferrer noopener">
          {t("work.openPr")}
        </a>
      ) : null}
      {props.item.thread_root_id ? (
        <span className="text-sm text-fg-muted">{t("work.fromThread")}</span>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <span className="sr-only">{t("work.moveTo", { identifier: props.item.identifier })}</span>
        <select
          className="min-h-touch w-full rounded border border-border bg-surface px-2 py-1"
          value={props.item.state}
          disabled={move.isPending}
          onChange={(event) => move.mutate(event.currentTarget.value as State)}
        >
          {props.states.map((state) => (
            <option key={state} value={state}>
              {t(`work.state.${state}`)}
            </option>
          ))}
        </select>
      </label>

      {props.item.session_id ? (
        <span className="text-sm text-fg-muted">{t("work.watching")}</span>
      ) : (
        <Button size="sm" disabled={hand.isPending} onClick={() => hand.mutate()}>
          {hand.isPending ? t("work.handing") : t("work.hand")}
        </Button>
      )}
      {error ? <p className="text-sm text-danger">{error}</p> : null}
    </article>
  );
}

function AddItem(props: { workspaceId: string; projectId: string }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const add = useMutation({
    mutationFn: async (title: string) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/work-items", {
          params: { path: { ws: props.workspaceId, project: props.projectId } },
          body: { title },
        }),
      ),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "work", props.projectId],
      });
    },
    onError: (err) => setError(message(err)),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const title = String(new FormData(form).get("title") ?? "").trim();
    if (!title || !props.projectId) return;
    add.mutate(title, { onSuccess: () => form.reset() });
  }

  return (
    <form onSubmit={onSubmit} className="flex max-w-lg items-end gap-2">
      <Field id="work-title" label={t("work.title")} error={error}>
        {(control) => (
          <Input {...control} name="title" required maxLength={300} autoComplete="off" />
        )}
      </Field>
      <Button type="submit" variant="primary" disabled={add.isPending}>
        {t("work.add")}
      </Button>
    </form>
  );
}
