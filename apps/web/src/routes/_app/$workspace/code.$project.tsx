import { EmptyState, t } from "@perch/ui";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { EditorPane } from "../../../code/editor-pane.tsx";
import { projectsQuery } from "../../../lib/queries.ts";
import { useAppShell } from "../../../shell/app-shell.tsx";
import { ModePage } from "../../../shell/mode-page.tsx";

/** A project open in Code mode (task 1.6): the file tree in the sidebar, the editor in main. */
export const Route = createFileRoute("/_app/$workspace/code/$project")({ component: ProjectCode });

function ProjectCode() {
  const { shell, workspace } = useAppShell();
  const { project: key } = Route.useParams();
  const projects = useQuery({ ...projectsQuery(workspace?.id ?? ""), enabled: workspace !== null });
  if (!workspace) return null;
  const project = projects.data?.find((p) => p.key === key) ?? null;
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
