import { Drawer, EmptyState, t } from "@perch/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { lazy, Suspense, useEffect } from "react";
import { EditorPane } from "../../../code/editor-pane.tsx";
import { useEditorStore } from "../../../code/editor-store.ts";
import { projectsQuery } from "../../../lib/queries.ts";
import { useAppShell } from "../../../shell/app-shell.tsx";
import { ModePage } from "../../../shell/mode-page.tsx";

// xterm.js loads when the drawer first shows the terminal, not with the editor route.
const TerminalDrawer = lazy(() =>
  import("../../../code/terminal.tsx").then((m) => ({ default: m.TerminalDrawer })),
);

/** A project open in Code mode (task 1.6): the file tree in the sidebar, the editor in main. */
export const Route = createFileRoute("/_app/$workspace/code/$project")({ component: ProjectCode });

function ProjectCode() {
  const { shell, workspace, setDrawer } = useAppShell();
  const { project: key } = Route.useParams();
  const projects = useQuery({ ...projectsQuery(workspace?.id ?? ""), enabled: workspace !== null });
  const openFile = useEditorStore((state) => state.open);
  const project = projects.data?.find((p) => p.key === key) ?? null;
  const projectId = project?.status === "ready" ? project.id : null;
  const projectName = project?.name ?? "";
  const workspaceId = workspace?.id ?? null;

  // The drawer holds the terminal (⌘J); the shell keeps running on the runner while it is closed.
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
        ]}
        active="terminal"
        onSelect={() => {}}
      />,
    );
    return () => setDrawer(null);
  }, [openFile, projectId, projectName, setDrawer, workspaceId]);

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
        <EditorPane workspaceId={workspace.id} projectId={project.id} />
      ) : (
        <EmptyState
          title={t(`projects.status.${project.status}`)}
          hint={project.status_message ?? t("files.notReady")}
        />
      )}
    </ModePage>
  );
}
