import "@perch/ui/i18n/work";
import { Button, Field, Input, SidebarItem, SidebarSection, t } from "@perch/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { api, RequestFailed, unwrap } from "../lib/api.ts";
import {
  burndownQuery,
  cyclesQuery,
  intakeQuery,
  type MyWorkspace,
  modulesQuery,
  projectsQuery,
  viewsQuery,
} from "../lib/queries.ts";

/**
 * Work mode's sidebar (spec §4: "sidebar projects, cycles, modules, views, intake") and the
 * burndown that goes with a cycle (task 3.26).
 *
 * Which project, which cycle, which view, and whether intake is open all live in the URL, the way
 * the Inbox's four sections do (task 2.10): a sidebar item is a link, a view somebody saved can be
 * sent to somebody else, and a reload lands where you were.
 */

export type WorkSearch = {
  project?: string;
  cycle?: string;
  module?: string;
  view?: string;
  layout?: string;
  intake?: string;
  item?: string;
};

/** What Work mode is looking at right now, out of the URL. */
export function useWorkSearch(): WorkSearch {
  return useSearch({ strict: false }) as WorkSearch;
}

function message(err: unknown): string {
  return err instanceof RequestFailed ? err.message : t("common.error");
}

/** Everything a sidebar section needs to send somebody somewhere in Work mode. */
function useGo(workspace: MyWorkspace) {
  const navigate = useNavigate();
  const search = useWorkSearch();
  const params = useParams({ strict: false }) as { mode?: string };
  return {
    here: params.mode === "work",
    search,
    go: (next: WorkSearch) =>
      void navigate({
        to: "/$workspace/$mode",
        params: { workspace: workspace.slug, mode: "work" },
        search: { ...search, ...next },
      }),
  };
}

/** The projects a board can be about. Choosing one is what the rest of the sidebar is about. */
export function WorkProjectsSection(props: { workspace: MyWorkspace }) {
  const projects = useQuery(projectsQuery(props.workspace.id)).data ?? [];
  const { here, search, go } = useGo(props.workspace);
  const chosen = search.project || projects[0]?.id || "";
  return (
    <SidebarSection title={t("shell.work.projects")}>
      {projects.length === 0 ? (
        <li className="px-2 py-1 text-sm text-fg-subtle">{t("shell.work.projectsEmpty")}</li>
      ) : (
        projects.map((project) => (
          <SidebarItem
            key={project.id}
            label={project.name}
            active={here && chosen === project.id}
            onSelect={() => go({ project: project.id, cycle: undefined, item: undefined })}
          />
        ))
      )}
    </SidebarSection>
  );
}

/** A project's cycles, and the form that adds one. Choosing a cycle narrows the board to it. */
export function CyclesSection(props: { workspace: MyWorkspace }) {
  const { here, search, go } = useGo(props.workspace);
  const projects = useQuery(projectsQuery(props.workspace.id)).data ?? [];
  const projectId = search.project || projects[0]?.id || "";
  const cycles = useQuery(cyclesQuery(props.workspace.id, projectId)).data?.cycles ?? [];
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: async (name: string) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/cycles", {
          params: { path: { ws: props.workspace.id, project: projectId } },
          body: { name },
        }),
      ),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspace.id, "cycles", projectId],
      });
    },
    onError: (err) => setError(message(err)),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") ?? "").trim();
    if (!name || !projectId) return;
    add.mutate(name, { onSuccess: () => form.reset() });
  }

  return (
    <SidebarSection title={t("shell.work.cycles")}>
      {cycles.length === 0 ? (
        <li className="px-2 py-1 text-sm text-fg-subtle">{t("shell.work.cyclesEmpty")}</li>
      ) : (
        cycles.map((cycle) => (
          <SidebarItem
            key={cycle.id}
            label={`${cycle.name} · ${t(`work.cycle.status.${cycle.status}`)}`}
            active={here && search.cycle === cycle.id}
            onSelect={() =>
              go({ cycle: search.cycle === cycle.id ? undefined : cycle.id, item: undefined })
            }
          />
        ))
      )}
      <li className="px-2 py-1">
        <form onSubmit={onSubmit} className="flex items-end gap-1">
          <Field id="work-cycle-name" label={t("work.cycle.name")} error={error}>
            {(control) => <Input {...control} name="name" maxLength={120} autoComplete="off" />}
          </Field>
          <Button type="submit" size="sm" disabled={add.isPending || !projectId}>
            {t("work.cycle.add")}
          </Button>
        </form>
      </li>
    </SidebarSection>
  );
}

/** A project's modules, and the form that adds one. */
export function ModulesSection(props: { workspace: MyWorkspace }) {
  const { here, search, go } = useGo(props.workspace);
  const projects = useQuery(projectsQuery(props.workspace.id)).data ?? [];
  const projectId = search.project || projects[0]?.id || "";
  const modules = useQuery(modulesQuery(props.workspace.id, projectId)).data?.modules ?? [];
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: async (name: string) =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/projects/{project}/modules", {
          params: { path: { ws: props.workspace.id, project: projectId } },
          body: { name },
        }),
      ),
    onSuccess: () => {
      setError(null);
      void queryClient.invalidateQueries({
        queryKey: ["workspace", props.workspace.id, "modules", projectId],
      });
    },
    onError: (err) => setError(message(err)),
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const name = String(new FormData(form).get("name") ?? "").trim();
    if (!name || !projectId) return;
    add.mutate(name, { onSuccess: () => form.reset() });
  }

  return (
    <SidebarSection title={t("shell.work.modules")}>
      {modules.length === 0 ? (
        <li className="px-2 py-1 text-sm text-fg-subtle">{t("shell.work.modulesEmpty")}</li>
      ) : (
        modules.map((one) => (
          <SidebarItem
            key={one.id}
            label={one.name}
            active={here && search.module === one.id}
            onSelect={() =>
              go({ module: search.module === one.id ? undefined : one.id, item: undefined })
            }
          />
        ))
      )}
      <li className="px-2 py-1">
        <form onSubmit={onSubmit} className="flex items-end gap-1">
          <Field id="work-module-name" label={t("work.module.name")} error={error}>
            {(control) => <Input {...control} name="name" maxLength={120} autoComplete="off" />}
          </Field>
          <Button type="submit" size="sm" disabled={add.isPending || !projectId}>
            {t("work.module.add")}
          </Button>
        </form>
      </li>
    </SidebarSection>
  );
}

/** The views this person can see: their own, and the ones somebody shared. */
export function ViewsSection(props: { workspace: MyWorkspace }) {
  const { here, search, go } = useGo(props.workspace);
  const projects = useQuery(projectsQuery(props.workspace.id)).data ?? [];
  const projectId = search.project || projects[0]?.id || "";
  const views = useQuery(viewsQuery(props.workspace.id, projectId)).data?.views ?? [];
  return (
    <SidebarSection title={t("shell.work.views")}>
      <SidebarItem
        label={t("work.view.none")}
        active={here && !search.view}
        onSelect={() => go({ view: undefined, item: undefined })}
      />
      {views.length === 0 ? (
        <li className="px-2 py-1 text-sm text-fg-subtle">{t("shell.work.viewsEmpty")}</li>
      ) : (
        views.map((view) => (
          <SidebarItem
            key={view.id}
            label={view.name}
            active={here && search.view === view.id}
            onSelect={() => go({ view: view.id, layout: view.layout, item: undefined })}
          />
        ))
      )}
    </SidebarSection>
  );
}

/** What is waiting to be triaged, with how much of it there is. */
export function IntakeSection(props: { workspace: MyWorkspace }) {
  const { here, search, go } = useGo(props.workspace);
  const projects = useQuery(projectsQuery(props.workspace.id)).data ?? [];
  const projectId = search.project || projects[0]?.id || "";
  const queue = useQuery(intakeQuery(props.workspace.id, projectId)).data?.items ?? [];
  return (
    <SidebarSection title={t("shell.work.intake")}>
      <SidebarItem
        label={t("work.intake")}
        active={here && search.intake === "1"}
        {...(queue.length > 0 ? { unread: queue.length } : {})}
        onSelect={() => go({ intake: search.intake === "1" ? undefined : "1", item: undefined })}
      />
      {queue.length === 0 ? (
        <li className="px-2 py-1 text-sm text-fg-subtle">{t("shell.work.intakeEmpty")}</li>
      ) : null}
    </SidebarSection>
  );
}

/**
 * The burndown of the cycle somebody is looking at (spec §4 "cycles with burndown and agent
 * throughput"). Bars rather than a canvas: it has to be readable at 390 px and by a screen reader,
 * and every day's numbers are in the table underneath the drawing.
 */
export function Burndown(props: { workspaceId: string; cycleId: string; cycleName: string }) {
  const queryClient = useQueryClient();
  const chart = useQuery(burndownQuery(props.cycleId)).data;
  const [closed, setClosed] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const close = useMutation({
    mutationFn: async () =>
      unwrap(
        await api.POST("/api/cycles/{id}/close", {
          params: { path: { id: props.cycleId } },
          body: {},
        }),
      ),
    onSuccess: (result) => {
      setError(null);
      setClosed(result.carried_over);
      void queryClient.invalidateQueries({ queryKey: ["cycle", props.cycleId, "burndown"] });
      void queryClient.invalidateQueries({ queryKey: ["workspace", props.workspaceId] });
    },
    onError: (err) => setError(message(err)),
  });

  if (!chart) return null;
  if (chart.scope === 0) {
    return (
      <p role="status" className="text-sm text-fg-subtle">
        {t("work.burndown.empty")}
      </p>
    );
  }
  const highest = Math.max(1, ...chart.days.map((day) => day.remaining));
  return (
    <section
      aria-label={t("work.burndown")}
      data-testid="work-burndown"
      className="flex flex-col gap-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">
          {t("work.burndown")} · {props.cycleName}
        </h3>
        <span className="text-sm text-fg-muted">
          {t("work.burndown.scope", { done: chart.done, scope: chart.scope })}
        </span>
        <Button size="sm" variant="ghost" disabled={close.isPending} onClick={() => close.mutate()}>
          {close.isPending ? t("work.cycle.closing") : t("work.cycle.close")}
        </Button>
      </div>
      {closed === null ? null : (
        <p role="status" className="text-sm text-fg-muted" data-testid="work-cycle-closed">
          {t("work.cycle.closed", { count: closed })}
        </p>
      )}
      {error ? (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      ) : null}
      {/* The drawing is decoration; the list below it is the data, and it is what is read out. */}
      <div aria-hidden="true" className="flex h-24 items-end gap-1 overflow-x-auto">
        {chart.days.map((day) => (
          <span
            key={day.date}
            className="w-3 shrink-0 rounded-t bg-accent"
            style={{ height: `${Math.round((day.remaining / highest) * 100)}%` }}
          />
        ))}
      </div>
      <ul className="max-h-40 overflow-y-auto text-sm text-fg-muted">
        {/* A cycle is at most ninety days, which is what the API will draw. */}
        {chart.days.map((day, at) => (
          <li key={day.date}>
            {t("work.burndown.day", {
              date: day.date,
              remaining: day.remaining,
              done: day.done,
              agent: chart.throughput[at]?.by_agent ?? 0,
            })}
          </li>
        ))}
      </ul>
    </section>
  );
}
