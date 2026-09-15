import { Button, Drawer, EmptyState, t, useIsMobile } from "@perch/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { EditorPane } from "../../../code/editor-pane.tsx";
import { useEditorStore } from "../../../code/editor-store.ts";
import { SessionPane } from "../../../code/session-pane.tsx";
import { projectsQuery } from "../../../lib/queries.ts";
import { useAppShell } from "../../../shell/app-shell.tsx";
import { ModePage } from "../../../shell/mode-page.tsx";

// xterm.js loads when the drawer first shows the terminal, not with the editor route.
const TerminalDrawer = lazy(() =>
  import("../../../code/terminal.tsx").then((m) => ({ default: m.TerminalDrawer })),
);

// The Git panel loads with the drawer tab that shows it.
const GitPanel = lazy(() =>
  import("../../../code/git-panel.tsx").then((m) => ({ default: m.GitPanel })),
);

// The Preview pane loads when somebody asks for it, not with the editor.
const PreviewPane = lazy(() =>
  import("../../../code/preview-pane.tsx").then((m) => ({ default: m.PreviewPane })),
);

// Deploy and the database browser (task 2.15): one chunk, loaded with whichever tab asks for it.
const DeployPanel = lazy(() =>
  import("../../../code/ship-panel.tsx").then((m) => ({ default: m.DeployPanel })),
);
const DbPanel = lazy(() =>
  import("../../../code/ship-panel.tsx").then((m) => ({ default: m.DbPanel })),
);

/** A project open in Code mode (task 1.6): the file tree in the sidebar, the editor in main. */
export const Route = createFileRoute("/_app/$workspace/code/$project")({
  component: ProjectCode,
  validateSearch,
});

/**
 * `?session=<id>` names the session in the panel; `?view=preview` puts the Preview in main and
 * `?port=<n>` picks which one (spec §4). Checked by hand: Zod would join the initial bundle
 * (ADR-0078).
 */
function validateSearch(search: Record<string, unknown>): {
  session?: string;
  view?: "preview";
  port?: number;
} {
  const port = Number(search.port);
  return {
    ...(typeof search.session === "string" && search.session ? { session: search.session } : {}),
    ...(search.view === "preview" ? { view: "preview" as const } : {}),
    ...(Number.isInteger(port) && port > 0 && port <= 65535 ? { port } : {}),
  };
}

function ProjectCode() {
  const { shell, workspace, setDrawer, setPanel } = useAppShell();
  const { project: key } = Route.useParams();
  const { session: sessionId, view, port } = Route.useSearch();
  const navigate = useNavigate();
  const mobile = useIsMobile();
  const projects = useQuery({ ...projectsQuery(workspace?.id ?? ""), enabled: workspace !== null });
  const openFile = useEditorStore((state) => state.open);
  const project = projects.data?.find((p) => p.key === key) ?? null;
  const projectId = project?.status === "ready" ? project.id : null;
  const projectName = project?.name ?? "";
  const workspaceId = workspace?.id ?? null;
  const workspaceSlug = workspace?.slug ?? "";

  const showPreview = useCallback(
    (on: boolean, forPort?: number) => {
      void navigate({
        to: "/$workspace/code/$project",
        params: { workspace: workspaceSlug, project: key },
        search: (previous: Record<string, unknown>) => ({
          ...previous,
          ...(on ? { view: "preview" as const } : { view: undefined }),
          ...(forPort ? { port: forPort } : {}),
        }),
      });
    },
    [navigate, workspaceSlug, key],
  );

  // ⌘⇧P toggles the Preview (spec §4 keyboard).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || !event.shiftKey) return;
      if (event.key.toLowerCase() !== "p") return;
      event.preventDefault();
      showPreview(view !== "preview");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [showPreview, view]);

  const openSession = useCallback(
    (id: string | null) => {
      void navigate({
        to: "/$workspace/code/$project",
        params: { workspace: workspaceSlug, project: key },
        search: id ? { session: id } : {},
      });
    },
    [navigate, workspaceSlug, key],
  );

  // The panel holds the session pane (spec §4: panel = agent session) while ?session= names one.
  useEffect(() => {
    if (!workspaceId || !projectId || !sessionId) return;
    setPanel({
      title: t("session.openInPanel"),
      content: (
        <SessionPane
          workspaceId={workspaceId}
          projectId={projectId}
          sessionId={sessionId}
          onClose={() => openSession(null)}
          onOpenSession={(id) => openSession(id)}
        />
      ),
    });
    return () => setPanel(null);
  }, [workspaceId, projectId, sessionId, setPanel, openSession]);

  // Opening a session shows the panel (the sheet on a phone), once per session; the person can
  // still fold it away with ⌘. and it stays away until the next session opens.
  const shownFor = useRef<string | null>(null);
  useEffect(() => {
    if (!sessionId) {
      shownFor.current = null;
      return;
    }
    if (shownFor.current === sessionId) return;
    shownFor.current = sessionId;
    shell.onStateChange(
      mobile ? { ...shell.state, mobileSheet: "panel" } : { ...shell.state, panelOpen: true },
    );
  }, [sessionId, mobile, shell]);

  // The drawer holds the terminal and the Git panel (⌘J); the shell keeps running on the runner
  // while it is closed.
  const [drawerTab, setDrawerTab] = useState("terminal");
  useEffect(() => {
    if (!workspaceId || !projectId) return;
    setDrawer(
      <Drawer
        tabs={[
          {
            id: "terminal",
            label: t("terminal.title"),
            content: (
              <Suspense
                fallback={<p className="p-2 text-sm text-fg-muted">{t("common.loading")}</p>}
              >
                <TerminalDrawer
                  workspaceId={workspaceId}
                  projectId={projectId}
                  projectName={projectName}
                  onOpenPath={(path, line) =>
                    openFile(projectId, path, line === undefined ? undefined : { line })
                  }
                />
              </Suspense>
            ),
          },
          {
            id: "git",
            label: t("git.title"),
            content: (
              <Suspense
                fallback={<p className="p-2 text-sm text-fg-muted">{t("common.loading")}</p>}
              >
                <GitPanel workspaceId={workspaceId} projectId={projectId} />
              </Suspense>
            ),
          },
          {
            id: "deploy",
            label: t("deploy.title"),
            content: (
              <Suspense
                fallback={<p className="p-2 text-sm text-fg-muted">{t("common.loading")}</p>}
              >
                <DeployPanel workspaceId={workspaceId} projectId={projectId} />
              </Suspense>
            ),
          },
          {
            id: "db",
            label: t("db.title"),
            content: (
              <Suspense
                fallback={<p className="p-2 text-sm text-fg-muted">{t("common.loading")}</p>}
              >
                <DbPanel workspaceId={workspaceId} />
              </Suspense>
            ),
          },
        ]}
        active={drawerTab}
        onSelect={setDrawerTab}
      />,
    );
    return () => setDrawer(null);
  }, [openFile, projectId, projectName, setDrawer, workspaceId, drawerTab]);

  if (!workspace) return null;
  if (projects.isSuccess && !project) {
    return (
      <ModePage title={t("ui.mode.code")} subtitle={workspace.name} shell={shell}>
        <EmptyState title={t("projects.notFound")} hint={t("projects.notFoundHint")} />
      </ModePage>
    );
  }
  if (!project) return null;
  return (
    <ModePage
      title={project.name}
      subtitle={
        <Link to="/$workspace/$mode" params={{ workspace: workspace.slug, mode: "code" }}>
          {t("files.backToProjects")}
        </Link>
      }
      shell={shell}
    >
      {project.status === "ready" ? (
        view === "preview" ? (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center justify-between gap-2 px-2 pt-2">
              <h2 className="text-sm font-semibold">{t("preview.title")}</h2>
              <Button variant="ghost" size="sm" onClick={() => showPreview(false)}>
                {t("preview.close")}
              </Button>
            </div>
            <Suspense fallback={<p className="p-4 text-sm text-fg-muted">{t("common.loading")}</p>}>
              <PreviewPane
                workspaceId={workspace.id}
                projectId={project.id}
                projectName={project.name}
                port={port ?? null}
                onPort={(next) => showPreview(true, next)}
              />
            </Suspense>
          </div>
        ) : (
          <EditorPane workspaceId={workspace.id} projectId={project.id} />
        )
      ) : (
        <EmptyState
          title={t(`projects.status.${project.status}`)}
          hint={project.status_message ?? t("files.notReady")}
        />
      )}
    </ModePage>
  );
}
