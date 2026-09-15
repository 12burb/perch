/**
 * The per-mode sidebars (spec §4 rail tabs). Every section exists from day one with an empty hint so
 * the shape of the product is visible; the lists fill in as the phases land.
 */
import { type MessageKey, type RailMode, Sidebar, SidebarItem, SidebarSection, t } from "@perch/ui";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { useEditorStore } from "../code/editor-store.ts";
import { FileTree } from "../code/file-tree.tsx";
import { SessionsSection } from "../code/sessions-list.tsx";
import { type MyWorkspace, previewsQuery, projectsQuery } from "../lib/queries.ts";
import { useAppShell } from "./app-shell.tsx";

type Section = { title: MessageKey; empty: MessageKey };

const SECTIONS: Record<RailMode, Section[]> = {
  home: [
    { title: "shell.home.channels", empty: "shell.home.channelsEmpty" },
    { title: "shell.home.dms", empty: "shell.home.dmsEmpty" },
    { title: "shell.home.bots", empty: "shell.home.botsEmpty" },
    { title: "shell.home.later", empty: "shell.home.laterEmpty" },
  ],
  code: [
    { title: "shell.code.projects", empty: "shell.code.projectsEmpty" },
    { title: "shell.code.sessions", empty: "shell.code.sessionsEmpty" },
    { title: "shell.code.previews", empty: "shell.code.previewsEmpty" },
  ],
  work: [
    { title: "shell.work.projects", empty: "shell.work.projectsEmpty" },
    { title: "shell.work.cycles", empty: "shell.work.cyclesEmpty" },
    { title: "shell.work.modules", empty: "shell.work.modulesEmpty" },
    { title: "shell.work.views", empty: "shell.work.viewsEmpty" },
    { title: "shell.work.intake", empty: "shell.work.intakeEmpty" },
  ],
  bots: [
    { title: "shell.bots.bots", empty: "shell.bots.botsEmpty" },
    { title: "shell.bots.templates", empty: "shell.bots.templatesEmpty" },
    { title: "shell.bots.skills", empty: "shell.bots.skillsEmpty" },
    { title: "shell.bots.connections", empty: "shell.bots.connectionsEmpty" },
  ],
  inbox: [
    { title: "shell.inbox.needsYou", empty: "shell.inbox.needsYouEmpty" },
    { title: "shell.inbox.mentions", empty: "shell.inbox.mentionsEmpty" },
    { title: "shell.inbox.threads", empty: "shell.inbox.threadsEmpty" },
    { title: "shell.inbox.later", empty: "shell.inbox.laterEmpty" },
  ],
  search: [{ title: "shell.search.filters", empty: "shell.search.filtersEmpty" }],
};

export function ModeSidebar(props: { mode: RailMode; workspace: MyWorkspace | null }) {
  return (
    <Sidebar
      header={
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-semibold">
            {props.workspace?.name ?? t("shell.noWorkspace")}
          </span>
          <span className="truncate text-sm text-fg-muted">{t(`ui.mode.${props.mode}`)}</span>
        </div>
      }
    >
      {SECTIONS[props.mode].map((section) =>
        section.title === "shell.code.projects" && props.workspace ? (
          <ProjectsSection key={section.title} workspace={props.workspace} empty={section.empty} />
        ) : section.title === "shell.code.sessions" && props.workspace ? (
          <OpenProjectSessions
            key={section.title}
            workspace={props.workspace}
            empty={section.empty}
          />
        ) : section.title === "shell.code.previews" && props.workspace ? (
          <OpenProjectPreviews
            key={section.title}
            workspace={props.workspace}
            empty={section.empty}
          />
        ) : (
          <SidebarSection key={section.title} title={t(section.title)}>
            <li className="px-2 py-1 text-sm text-fg-subtle">{t(section.empty)}</li>
          </SidebarSection>
        ),
      )}
    </Sidebar>
  );
}

/**
 * Code mode's Previews section (task 1.18): the ports the open project is serving, each a link that
 * puts the Preview in main. Nothing is listed until a project is open, because a port belongs to a
 * project's runner, not to the workspace.
 */
function OpenProjectPreviews(props: { workspace: MyWorkspace; empty: MessageKey }) {
  const params = useParams({ strict: false }) as { project?: string };
  const projects = useQuery(projectsQuery(props.workspace.id)).data ?? [];
  const open = params.project ? projects.find((p) => p.key === params.project) : undefined;
  const previews = useQuery(previewsQuery(props.workspace.id, open?.id ?? ""));
  const ports = previews.data?.ports ?? [];
  return (
    <SidebarSection title={t("shell.code.previews")}>
      {!open || ports.length === 0 ? (
        <li className="px-2 py-1 text-sm text-fg-subtle">{t(props.empty)}</li>
      ) : (
        ports.map((port) => (
          <SidebarItem
            key={port.port}
            label={`:${port.port}${port.configured ? " ★" : ""}`}
            href={`/${props.workspace.slug}/code/${open.key}?view=preview&port=${port.port}`}
            muted={port.runner_id === ""}
          />
        ))
      )}
    </SidebarSection>
  );
}

/**
 * Code mode's Projects section: the workspace's projects (task 1.4), and, with a project open, that
 * project's file tree (task 1.6) with a way back to the list.
 */
function ProjectsSection(props: { workspace: MyWorkspace; empty: MessageKey }) {
  const projects = useQuery(projectsQuery(props.workspace.id)).data ?? [];
  const params = useParams({ strict: false }) as { project?: string };
  const open = params.project ? projects.find((p) => p.key === params.project) : undefined;
  const navigate = useNavigate();
  const { shell } = useAppShell();
  const openFile = useEditorStore((state) => state.open);
  const activePath = useEditorStore((state) =>
    open ? (state.byProject[open.id]?.active ?? null) : null,
  );
  if (open) {
    return (
      <SidebarSection title={open.name}>
        <SidebarItem label={t("files.backToProjects")} href={`/${props.workspace.slug}/code`} />
        <li className="h-[60vh] min-h-48">
          {open.status === "ready" ? (
            <FileTree
              workspaceId={props.workspace.id}
              projectId={open.id}
              selectedPath={activePath}
              onOpen={(path, line) => {
                openFile(open.id, path, line === undefined ? undefined : { line });
                // On a phone the sidebar is a sheet: close it to show the editor.
                if (shell.state.mobileSheet) {
                  shell.onStateChange({ ...shell.state, mobileSheet: null });
                }
                void navigate({
                  to: "/$workspace/code/$project",
                  params: { workspace: props.workspace.slug, project: open.key },
                });
              }}
            />
          ) : (
            <p className="px-2 py-1 text-sm text-fg-subtle">{t("files.notReady")}</p>
          )}
        </li>
      </SidebarSection>
    );
  }
  return (
    <SidebarSection title={t("shell.code.projects")}>
      {projects.length === 0 ? (
        <li className="px-2 py-1 text-sm text-fg-subtle">{t(props.empty)}</li>
      ) : (
        projects.map((project) => (
          <SidebarItem
            key={project.id}
            label={project.name}
            href={`/${props.workspace.slug}/code/${project.key}`}
            muted={project.status !== "ready"}
          />
        ))
      )}
    </SidebarSection>
  );
}

/** The Sessions section: the open project's sessions (task 1.12), or the hint without one. */
function OpenProjectSessions(props: { workspace: MyWorkspace; empty: MessageKey }) {
  const projects = useQuery(projectsQuery(props.workspace.id)).data ?? [];
  const params = useParams({ strict: false }) as { project?: string };
  const search = useSearch({ strict: false }) as { session?: string };
  const open = params.project ? projects.find((p) => p.key === params.project) : undefined;
  const navigate = useNavigate();
  const { shell } = useAppShell();
  if (open?.status !== "ready") {
    return (
      <SidebarSection title={t("shell.code.sessions")}>
        <li className="px-2 py-1 text-fg-subtle text-sm">{t(props.empty)}</li>
      </SidebarSection>
    );
  }
  return (
    <SessionsSection
      workspaceId={props.workspace.id}
      projectId={open.id}
      activeSessionId={search.session ?? null}
      onOpen={(sessionId) => {
        if (shell.state.mobileSheet) shell.onStateChange({ ...shell.state, mobileSheet: null });
        void navigate({
          to: "/$workspace/code/$project",
          params: { workspace: props.workspace.slug, project: open.key },
          search: { session: sessionId },
        });
      }}
    />
  );
}

export function SettingsSidebar(props: {
  workspace: MyWorkspace | null;
  renderItem: (item: { key: string; label: string; to: string }) => React.ReactNode;
}) {
  const account = [
    { key: "profile", label: t("settings.profile"), to: "/settings/profile" },
    { key: "security", label: t("settings.security"), to: "/settings/security" },
  ];
  return (
    <Sidebar
      header={
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-semibold">{t("settings.title")}</span>
          <span className="truncate text-sm text-fg-muted">
            {props.workspace?.name ?? t("shell.noWorkspace")}
          </span>
        </div>
      }
    >
      <SidebarSection title={t("settings.account")}>{account.map(props.renderItem)}</SidebarSection>
      {props.workspace ? (
        <SidebarSection title={t("settings.workspaceSection")}>
          {props.renderItem({
            key: "workspace",
            label: t("settings.workspace"),
            to: `/${props.workspace.slug}/settings`,
          })}
          {props.renderItem({
            key: "environments",
            label: t("environments.title"),
            to: `/${props.workspace.slug}/environments`,
          })}
        </SidebarSection>
      ) : null}
    </Sidebar>
  );
}
