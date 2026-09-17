import "@perch/ui/i18n/work";
import { Badge, Button, EmptyState, Field, Input, t, useIsMobile } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { SquareKanban } from "lucide-react";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import {
  cyclesQuery,
  intakeQuery,
  modulesQuery,
  projectsQuery,
  viewsQuery,
  type WorkItemRow,
  workItemCostQuery,
  workItemsQuery,
} from "../lib/queries.ts";
import { getSocket } from "../lib/ws.ts";
import { useAppShell } from "../shell/app-shell.tsx";
import { ItemPanel } from "./item-panel.tsx";
import { CalendarView, IntakeQueue, ListView, SpreadsheetView, TimelineView } from "./layouts.tsx";
import { Burndown, useWorkSearch } from "./planning.tsx";

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

function useBoard(workspaceId: string, projectId: string, viewId?: string) {
  return useQuery(workItemsQuery(workspaceId, projectId, viewId));
}

/** The five layouts of §4, in the order the switcher offers them. */
const LAYOUTS = ["board", "list", "calendar", "timeline", "spreadsheet"] as const;
type Layout = (typeof LAYOUTS)[number];

function layoutOf(value: string | undefined): Layout {
  return LAYOUTS.includes(value as Layout) ? (value as Layout) : "board";
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
  const navigate = useNavigate();
  const search = useWorkSearch();
  const { setPanel, shell } = useAppShell();
  const mobile = useIsMobile();
  const projects = useQuery(projectsQuery(props.workspaceId)).data ?? [];
  const chosen = search.project || projects[0]?.id || "";
  const layout = layoutOf(search.layout);
  useLiveBoard(props.workspaceId, chosen);
  const board = useBoard(props.workspaceId, chosen, search.view);
  // `?? []` inside a render makes a new array every time, and the panel below is memoised on
  // these: an unstable identity there is a render loop.
  const cyclesData = useQuery(cyclesQuery(props.workspaceId, chosen)).data?.cycles;
  const modulesData = useQuery(modulesQuery(props.workspaceId, chosen)).data?.modules;
  const cycles = useMemo(() => cyclesData ?? [], [cyclesData]);
  const modules = useMemo(() => modulesData ?? [], [modulesData]);
  const views = useQuery(viewsQuery(props.workspaceId, chosen)).data?.views ?? [];
  const intake = useQuery(intakeQuery(props.workspaceId, chosen)).data?.items ?? [];
  const queryClient = useQueryClient();

  // Stable while the URL is: the panel below is memoised on it, and a new closure every render
  // would rebuild the panel every render.
  const go = useCallback(
    (next: Record<string, string | undefined>) =>
      void navigate({
        to: "/$workspace/$mode",
        params: { workspace: props.workspaceSlug, mode: "work" },
        search: { ...search, ...next },
      }),
    [navigate, search, props.workspaceSlug],
  );

  // The sidebar narrows the board without changing what it is: a cycle and a module are filters
  // on top of whatever view is open (task 3.26).
  const rows = board.data?.items;
  const all = useMemo(() => rows ?? [], [rows]);
  const items = useMemo(
    () =>
      all.filter(
        (item) =>
          (!search.cycle || item.cycle_id === search.cycle) &&
          (!search.module || item.module_id === search.module),
      ),
    [all, search.cycle, search.module],
  );
  const open = items.find((item) => item.id === search.item) ?? null;
  const stateList = board.data?.states;
  const states = useMemo(() => stateList ?? [], [stateList]);

  const triage = useMutation({
    mutationFn: async (input: { id: string; decision: "accept" | "decline" }) =>
      unwrap(
        input.decision === "accept"
          ? await api.POST("/api/work-items/{id}/intake/accept", {
              params: { path: { id: input.id } },
              body: {},
            })
          : await api.POST("/api/work-items/{id}/intake/decline", {
              params: { path: { id: input.id } },
            }),
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "intake", chosen],
      });
      void queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "work", chosen],
      });
    },
  });

  // The item somebody opened goes in the shell's panel, which is where §4 puts it. Memoised on
  // what it draws, so the effect below runs when the item changes and not on every render.
  const panel = useMemo(
    () =>
      open
        ? {
            title: open.identifier,
            content: (
              <ItemPanel
                item={open}
                workspaceId={props.workspaceId}
                projectId={chosen}
                cycles={cycles}
                modules={modules}
                states={states}
                resolve={(identifier) =>
                  all.find((one) => one.identifier.toUpperCase() === identifier.toUpperCase())
                }
                onOpen={(item) => go({ item: item.id })}
                onClose={() => go({ item: undefined })}
              />
            ),
          }
        : null,
    [open, chosen, cycles, modules, states, all, go, props.workspaceId],
  );

  useEffect(() => {
    setPanel(panel);
    return () => setPanel(null);
  }, [panel, setPanel]);

  // Opening an item shows the panel, once per item: the person can still fold it away with ⌘.
  // and it stays away until they open another one (the same rule Code mode's sessions follow).
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    const id = open?.id ?? null;
    if (!id) {
      shownFor.current = null;
      return;
    }
    if (shownFor.current === id) return;
    shownFor.current = id;
    // On a phone the panel is a sheet over the page, the way Code mode's session pane is.
    shell.onStateChange(
      mobile ? { ...shell.state, mobileSheet: "panel" } : { ...shell.state, panelOpen: true },
    );
  }, [open, mobile, shell]);

  if (projects.length === 0) {
    return (
      <EmptyState
        icon={<SquareKanban className="size-8" aria-hidden="true" />}
        title={t("shell.work.emptyTitle")}
        hint={t("shell.work.emptyHint")}
      />
    );
  }

  const onOpen = (item: WorkItemRow) => go({ item: item.id });
  const cycle = cycles.find((one) => one.id === search.cycle) ?? null;

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
            onChange={(event) => go({ project: event.currentTarget.value, item: undefined })}
          >
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>

        {/* The five layouts of §4. Which one is in the URL, so a link carries it. */}
        <label className="flex items-center gap-2 text-sm">
          <span className="text-fg-muted">{t("work.layout")}</span>
          <select
            className="min-h-touch rounded border border-border bg-surface px-2 py-1"
            value={layout}
            data-testid="work-layout"
            onChange={(event) => go({ layout: event.currentTarget.value })}
          >
            {LAYOUTS.map((one) => (
              <option key={one} value={one}>
                {t(`work.layout.${one}`)}
              </option>
            ))}
          </select>
        </label>

        <label className="flex items-center gap-2 text-sm">
          <span className="text-fg-muted">{t("work.view")}</span>
          <select
            className="min-h-touch rounded border border-border bg-surface px-2 py-1"
            value={search.view ?? ""}
            data-testid="work-view"
            onChange={(event) => {
              const id = event.currentTarget.value;
              const picked = views.find((one) => one.id === id);
              go({
                view: id || undefined,
                ...(picked ? { layout: picked.layout } : {}),
                item: undefined,
              });
            }}
          >
            <option value="">{t("work.view.none")}</option>
            {views.map((view) => (
              <option key={view.id} value={view.id}>
                {view.name}
              </option>
            ))}
          </select>
        </label>

        <SaveView
          workspaceId={props.workspaceId}
          projectId={chosen}
          layout={layout}
          {...(search.cycle ? { cycleId: search.cycle } : {})}
          {...(search.module ? { moduleId: search.module } : {})}
        />
      </div>

      <AddItem workspaceId={props.workspaceId} projectId={chosen} />

      {cycle ? (
        <Burndown workspaceId={props.workspaceId} cycleId={cycle.id} cycleName={cycle.name} />
      ) : null}

      {search.intake === "1" ? (
        <section aria-label={t("work.intake")} className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">
            {t("work.intake")} · {t("work.intake.waiting", { count: intake.length })}
          </h3>
          <IntakeQueue
            items={intake}
            busy={triage.isPending}
            onAccept={(item) => triage.mutate({ id: item.id, decision: "accept" })}
            onDecline={(item) => triage.mutate({ id: item.id, decision: "decline" })}
            onOpen={onOpen}
          />
        </section>
      ) : null}

      {board.data && items.length === 0 ? (
        <p className="text-sm text-fg-muted">{t("work.empty")}</p>
      ) : null}

      {layout === "board" ? (
        // Columns scroll sideways on a phone and sit side by side on a desk.
        /* biome-ignore lint/a11y/noNoninteractiveTabindex: a region that scrolls on its own has to
           be reachable by a keyboard as well as a thumb (axe: scrollable-region-focusable), and an
           empty board holds nothing focusable to reach it by. Unnamed on purpose: a second landmark
           inside the board's own would be a violation of its own (task 4.11). */
        <div className="flex min-h-0 gap-3 overflow-x-auto pb-2" tabIndex={0}>
          {states.map((state) => (
            <Column
              key={state}
              state={state}
              items={items.filter((item) => item.state === state)}
              states={states}
              workspaceId={props.workspaceId}
              workspaceSlug={props.workspaceSlug}
              projectId={chosen}
              onOpen={onOpen}
            />
          ))}
        </div>
      ) : null}
      {layout === "list" ? <ListView items={items} onOpen={onOpen} /> : null}
      {layout === "calendar" ? <CalendarView items={items} onOpen={onOpen} /> : null}
      {layout === "timeline" ? <TimelineView items={items} onOpen={onOpen} /> : null}
      {layout === "spreadsheet" ? (
        <SpreadsheetView
          items={items}
          {...(board.data?.view?.display.properties
            ? { properties: board.data.view.display.properties }
            : {})}
          cycles={cycles}
          modules={modules}
          onOpen={onOpen}
        />
      ) : null}
    </section>
  );
}

/**
 * Saving what you are looking at (spec §4 "saved views with filters and display properties"): the
 * layout, and whatever the sidebar has narrowed the board to. Shared by default is wrong — a view
 * is somebody's way of looking at the work before it is the team's.
 */
function SaveView(props: {
  workspaceId: string;
  projectId: string;
  layout: Layout;
  cycleId?: string;
  moduleId?: string;
}) {
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: async (input: { name: string; shared: boolean }) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/views", {
          params: { path: { ws: props.workspaceId } },
          body: {
            name: input.name,
            project_id: props.projectId,
            layout: props.layout,
            filters: {
              ...(props.cycleId ? { cycleId: props.cycleId } : {}),
              ...(props.moduleId ? { moduleId: props.moduleId } : {}),
            },
            display: {},
            shared: input.shared,
          },
        }),
      ),
    onSuccess: (view) => {
      setError(null);
      setSaved(view.name);
      void queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspaceId, "views", props.projectId],
      });
    },
    onError: (err) => setError(message(err)),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const name = String(data.get("name") ?? "").trim();
    if (!name || !props.projectId) return;
    save.mutate({ name, shared: data.get("shared") === "on" }, { onSuccess: () => form.reset() });
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-wrap items-end gap-2">
      <Field id="work-view-name" label={t("work.view.name")} error={error}>
        {(control) => <Input {...control} name="name" maxLength={120} autoComplete="off" />}
      </Field>
      <label className="flex items-center gap-1 text-sm">
        <input type="checkbox" name="shared" className="size-4" />
        {t("work.view.shared")}
      </label>
      <Button type="submit" size="sm" disabled={save.isPending}>
        {t("work.view.save")}
      </Button>
      {saved ? (
        <span role="status" className="text-sm text-fg-muted">
          {t("work.view.saved", { name: saved })}
        </span>
      ) : null}
    </form>
  );
}

function Column(props: {
  state: State;
  items: Item[];
  states: State[];
  workspaceId: string;
  workspaceSlug: string;
  projectId: string;
  onOpen: (item: Item) => void;
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
              onOpen={props.onOpen}
            />
          </li>
        ))}
      </ul>
    </section>
  );
}

/** States where the work is over, and the bill is the whole bill. */
const FINISHED: Partial<Record<State, true>> = { done: true, cancelled: true };

function minutes(ms: number): string {
  const total = Math.round(ms / 60_000);
  if (total < 60) return `${total}m`;
  return `${Math.floor(total / 60)}h ${total % 60}m`;
}

/**
 * What the item cost and where its time went (spec §5.7; task 3.22). Shown on a finished card,
 * because that is the moment the question is asked — and the two clocks are different numbers: the
 * time the item took, and the time an agent spent on it, which is larger when a race ran three at
 * once.
 */
function Cost(props: { item: Item }) {
  const rolled = useQuery({ ...workItemCostQuery(props.item.id), enabled: true }).data;
  if (!rolled) return null;
  const spent = rolled.cost_usd > 0 ? `$${rolled.cost_usd.toFixed(2)}` : t("work.free");
  const turns = rolled.turns === 1 ? t("work.turn") : t("work.turns", { count: rolled.turns });
  const time = minutes(rolled.elapsed_ms);
  return (
    <p className="text-sm text-fg-muted">
      {/* Compact enough for a card at 390 px, read out in full by anything reading it aloud. */}
      <span aria-hidden="true">{t("work.cost", { cost: spent, turns, time })}</span>
      <span className="sr-only">
        {t("work.costLabel", {
          identifier: props.item.identifier,
          cost: spent,
          turns,
          time: minutes(rolled.working_ms),
        })}
      </span>
    </p>
  );
}

function Card(props: {
  item: Item;
  states: State[];
  workspaceId: string;
  workspaceSlug: string;
  projectId: string;
  onOpen: (item: Item) => void;
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
        {/* The identifier opens the item in the panel, from every layout including this one. */}
        <button
          type="button"
          className="font-mono text-sm text-fg-muted underline"
          onClick={() => props.onOpen(props.item)}
          aria-label={t("work.select", { identifier: props.item.identifier })}
        >
          {props.item.identifier}
        </button>
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
      {FINISHED[props.item.state] ? <Cost item={props.item} /> : null}

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
