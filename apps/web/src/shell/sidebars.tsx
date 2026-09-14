/**
 * The per-mode sidebars (spec §4 rail tabs). Every section exists from day one with an empty hint so
 * the shape of the product is visible; the lists fill in as the phases land.
 */
import { type MessageKey, type RailMode, Sidebar, SidebarSection, t } from "@perch/ui";
import type { MyWorkspace } from "../lib/queries.ts";

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
      {SECTIONS[props.mode].map((section) => (
        <SidebarSection key={section.title} title={t(section.title)}>
          <li className="px-2 py-1 text-sm text-fg-subtle">{t(section.empty)}</li>
        </SidebarSection>
      ))}
    </Sidebar>
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
        </SidebarSection>
      ) : null}
    </Sidebar>
  );
}
