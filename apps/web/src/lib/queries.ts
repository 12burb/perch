/**
 * TanStack Query definitions shared by routes and components. Keys are stable strings so mutations
 * can invalidate precisely.
 */

import type { components, paths } from "@perch/api-client";
import { queryOptions } from "@tanstack/react-query";
import { UNSETTLED_POLL_MS, unsettled } from "../code/project-status.ts";
import { api, unwrap } from "./api.ts";

export type MyWorkspace = components["schemas"]["MyWorkspace"];
export type Me = components["schemas"]["Me"];
export type Member = components["schemas"]["Member"];
export type AuditRow = components["schemas"]["AuditRow"];
/** Work mode's rows (task 3.26), named once so every layout agrees on what an item is. */
export type WorkItemRow = components["schemas"]["WorkItem"];
export type CycleRow = components["schemas"]["Cycle"];
export type ModuleRow = components["schemas"]["Module"];
export type SavedViewRow = components["schemas"]["SavedView"];
export type RunnerRow = components["schemas"]["Runner"];
export type ProjectRow = components["schemas"]["Project"];
export type DeployKeyRow = components["schemas"]["DeployKey"];
export type SessionRow = components["schemas"]["Session"];
export type SessionEventRecord = components["schemas"]["SessionEventRecord"];
export type CredentialRow = components["schemas"]["Credential"];
export type ModelProfileRow = components["schemas"]["ModelProfile"];
export type CatalogModel = components["schemas"]["CatalogModel"];
export type ProviderRow = components["schemas"]["Provider"];
export type ConnectionRow = components["schemas"]["Connection"];
export type ConnectionProviderRow = components["schemas"]["ConnectionProvider"];
export type ChannelRow = components["schemas"]["Channel"];
export type ChannelMemberRow = components["schemas"]["ChannelMember"];
export type MessageRow = components["schemas"]["Message"];

export const meQuery = queryOptions({
  queryKey: ["me"],
  queryFn: async () => unwrap(await api.GET("/api/me")),
});

export const workspacesQuery = queryOptions({
  queryKey: ["workspaces"],
  queryFn: async () => unwrap(await api.GET("/api/workspaces")).workspaces,
});

export const instanceQuery = queryOptions({
  queryKey: ["instance"],
  queryFn: async () => unwrap(await api.GET("/api/instance")),
  staleTime: Number.POSITIVE_INFINITY,
});

export function membersQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "members"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/members", { params: { path: { ws: workspaceId } } }),
      ).members,
  });
}

/** What the audit page narrows by (task 4.5); an empty field is left out of the request. */
export type AuditFilters = {
  action?: string;
  actor_type?: "user" | "bot" | "system" | "runner";
  from?: string;
  to?: string;
  limit?: number;
};

/** The filters as query parameters, with the empty ones dropped. */
export function auditParams(filters: AuditFilters): Record<string, string | number> {
  const params: Record<string, string | number> = { limit: filters.limit ?? 100 };
  if (filters.action) params.action = filters.action;
  if (filters.actor_type) params.actor_type = filters.actor_type;
  // A date input gives a day; the log is in instants, so a day means all of it.
  if (filters.from) params.from = new Date(`${filters.from}T00:00:00Z`).toISOString();
  if (filters.to) params.to = new Date(`${filters.to}T23:59:59Z`).toISOString();
  return params;
}

export function auditQuery(workspaceId: string, filters: AuditFilters = {}) {
  const params = auditParams(filters);
  return queryOptions({
    queryKey: ["workspace", workspaceId, "audit", params],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/audit", {
          params: { path: { ws: workspaceId }, query: params },
        }),
      ),
  });
}

/** What this instance keeps, for whoever set it up; anybody else is refused and sees nothing. */
export function instanceSettingsQuery() {
  return queryOptions({
    queryKey: ["instance", "settings"],
    retry: false,
    queryFn: async () => unwrap(await api.GET("/api/admin/settings", {})),
  });
}

export function runnersQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "runners"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/runners", { params: { path: { ws: workspaceId } } }),
      ).runners,
  });
}

export function projectsQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "projects"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects", { params: { path: { ws: workspaceId } } }),
      ).projects,
    // The socket is how this list normally hears about a setup finishing; the poller is what
    // happens when it does not (ADR-0115).
    refetchInterval: (query) => (unsettled(query.state.data) ? UNSETTLED_POLL_MS : false),
  });
}

/** A project's board (spec §4 "Work (Plane)"; task 3.13). */
/**
 * What a finished item cost (task 3.22). Nothing is stored, so this is asked for per item and only
 * where it is shown — a board of two hundred cards does not roll up two hundred sessions.
 */
export function workItemCostQuery(workItemId: string) {
  return queryOptions({
    queryKey: ["work-item", workItemId, "cost"],
    queryFn: async () =>
      unwrap(await api.GET("/api/work-items/{id}/cost", { params: { path: { id: workItemId } } })),
  });
}

export function workItemsQuery(workspaceId: string, projectId: string, viewId?: string) {
  return queryOptions({
    // A view is part of the key: two views of one project are two lists, and switching between
    // them should not show the other's rows for a frame (task 3.26).
    queryKey: ["workspace", workspaceId, "work", projectId, viewId ?? ""],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/work-items", {
          // A board shows what is in front of you, urgent and oldest first. Past 200 the answer
          // is a filter, not more cards, so the columns stay a size a browser can draw.
          params: {
            path: { ws: workspaceId, project: projectId },
            query: { limit: 200, ...(viewId ? { view: viewId } : {}) },
          },
        }),
      ),
    enabled: Boolean(projectId),
  });
}

/**
 * The planning around the items (task 3.26): the cycles and modules of a project, the views this
 * person can see, what is waiting in intake, and one item's relations.
 */
export function cyclesQuery(workspaceId: string, projectId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "cycles", projectId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/cycles", {
          params: { path: { ws: workspaceId, project: projectId } },
        }),
      ),
    enabled: Boolean(projectId),
  });
}

export function modulesQuery(workspaceId: string, projectId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "modules", projectId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/modules", {
          params: { path: { ws: workspaceId, project: projectId } },
        }),
      ),
    enabled: Boolean(projectId),
  });
}

export function viewsQuery(workspaceId: string, projectId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "views", projectId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/views", {
          params: { path: { ws: workspaceId }, query: projectId ? { project: projectId } : {} },
        }),
      ),
  });
}

export function intakeQuery(workspaceId: string, projectId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "intake", projectId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/intake", {
          params: { path: { ws: workspaceId, project: projectId } },
        }),
      ),
    enabled: Boolean(projectId),
  });
}

export function relationsQuery(itemId: string) {
  return queryOptions({
    queryKey: ["work-item", itemId, "relations"],
    queryFn: async () =>
      unwrap(await api.GET("/api/work-items/{id}/relations", { params: { path: { id: itemId } } })),
    enabled: Boolean(itemId),
  });
}

export function burndownQuery(cycleId: string) {
  return queryOptions({
    queryKey: ["cycle", cycleId, "burndown"],
    queryFn: async () =>
      unwrap(await api.GET("/api/cycles/{id}/burndown", { params: { path: { id: cycleId } } })),
    enabled: Boolean(cycleId),
  });
}

/** What a workspace has spent, and the ceilings on it (task 4.2). */
export function usageQuery(workspaceId: string, groupBy: "model" | "provider" | "actor" | "day") {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "usage", groupBy],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/usage", {
          params: { path: { ws: workspaceId }, query: { group_by: groupBy } },
        }),
      ),
  });
}

export function budgetsQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "budgets"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/budgets", { params: { path: { ws: workspaceId } } }),
      ),
  });
}

export function deployKeyQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "deploy-key"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/deploy-key", { params: { path: { ws: workspaceId } } }),
      ),
  });
}

/** A project's file tree and files (task 1.6): one query per directory, one per open file. */
export type FsEntry = {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  size: number;
  mtime: string;
};
export type FsFile = {
  content: string;
  encoding: "utf8" | "base64";
  size: number;
  truncated: boolean;
};
export type FsMatch = { path: string; line: number; column: number; text: string };

export function fsKey(workspaceId: string, projectId: string) {
  return ["workspace", workspaceId, "project", projectId, "fs"] as const;
}

export function fsListQuery(workspaceId: string, projectId: string, path: string) {
  return queryOptions({
    queryKey: [...fsKey(workspaceId, projectId), "list", path],
    queryFn: async (): Promise<FsEntry[]> =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/fs/list", {
          params: { path: { ws: workspaceId, project: projectId }, query: { path } },
        }),
      ).entries,
  });
}

export function fsReadQuery(workspaceId: string, projectId: string, path: string) {
  return queryOptions({
    queryKey: [...fsKey(workspaceId, projectId), "read", path],
    queryFn: async (): Promise<FsFile> =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/fs/read", {
          params: { path: { ws: workspaceId, project: projectId }, query: { path } },
        }),
      ),
    staleTime: 0,
  });
}

export function fsSearchQuery(workspaceId: string, projectId: string, q: string) {
  return queryOptions({
    queryKey: [...fsKey(workspaceId, projectId), "search", q],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/fs/search", {
          params: { path: { ws: workspaceId, project: projectId }, query: { q, limit: 200 } },
        }),
      ),
    enabled: q.trim().length > 0,
  });
}

export function sessionsQuery(workspaceId: string, projectId: string) {
  return queryOptions({
    queryKey: ["sessions", workspaceId, projectId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/sessions", {
          params: { path: { ws: workspaceId, project: projectId } },
        }),
      ).sessions,
    enabled: workspaceId !== "" && projectId !== "",
  });
}

export function sessionQuery(sessionId: string) {
  return queryOptions({
    queryKey: ["session", sessionId],
    queryFn: async () =>
      unwrap(await api.GET("/api/sessions/{s}", { params: { path: { s: sessionId } } })),
    enabled: sessionId !== "",
  });
}

/** The diff of one turn (its checkpoint to the next) or of the whole session (task 1.13). */
export function sessionDiffQuery(sessionId: string, turn: number | null) {
  return queryOptions({
    queryKey: ["session", sessionId, "diff", turn ?? "all"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/sessions/{s}/diff", {
          params: { path: { s: sessionId }, query: turn === null ? {} : { turn } },
        }),
      ),
    enabled: sessionId !== "",
    staleTime: 0,
  });
}

export function checkpointsQuery(sessionId: string) {
  return queryOptions({
    queryKey: ["session", sessionId, "checkpoints"],
    queryFn: async () =>
      unwrap(await api.GET("/api/sessions/{s}/checkpoints", { params: { path: { s: sessionId } } }))
        .checkpoints,
    enabled: sessionId !== "",
  });
}

/** The providers a brain can run on, and a local Ollama when one is answering (task 1.15). */
export function providersQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "providers"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/providers", { params: { path: { ws: workspaceId } } }),
      ),
    enabled: workspaceId !== "",
  });
}

export function credentialsQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "credentials"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/credentials", {
          params: { path: { ws: workspaceId } },
        }),
      ).credentials,
    enabled: workspaceId !== "",
  });
}

export function modelProfilesQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "model-profiles"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/model-profiles", {
          params: { path: { ws: workspaceId } },
        }),
      ).profiles,
    enabled: workspaceId !== "",
  });
}

/** What a credential can reach; the same call is the test button (task 1.15). */
export function catalogQuery(workspaceId: string, credentialId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "models", credentialId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/models", {
          params: { path: { ws: workspaceId }, query: { credential: credentialId } },
        }),
      ).models,
    enabled: workspaceId !== "" && credentialId !== "",
    retry: false,
  });
}

/** The channels this member can see, with what is unread in each (task 2.1). */
/** The bots of a workspace (task 2.8). */
export type BotRow = {
  id: string;
  handle: string;
  name: string;
  /** The parts of the spec the client reads by name; the rest is the api's business. */
  spec: { brain?: { profile?: string; pick?: boolean } } & Record<string, unknown>;
  owner_id: string;
  visibility: "private" | "workspace";
  status: "active" | "paused" | "disabled";
  budget: Record<string, unknown>;
  channels: string[];
};

export function botsQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "bots"],
    queryFn: async () =>
      unwrap(await api.GET("/api/workspaces/{ws}/bots", { params: { path: { ws: workspaceId } } }))
        .bots,
    enabled: workspaceId !== "",
  });
}

/** The Nest roster, and which of them this workspace already has (spec §5.3; task 3.9). */
export function nestQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "nest"],
    queryFn: async () =>
      unwrap(await api.GET("/api/workspaces/{ws}/nest", { params: { path: { ws: workspaceId } } }))
        .agents,
    enabled: workspaceId !== "",
  });
}

/**
 * The chat this person has with this bot (task 2.9). Opening it is what makes it, so the ask is a
 * POST — it finds the room the second time rather than starting another — and the answer says where
 * the room is and which brain it is running on.
 */
export function botDmQuery(workspaceId: string, botId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "bots", botId, "dm"],
    queryFn: async () =>
      unwrap(
        await api.POST("/api/workspaces/{ws}/bots/{bot}/dm", {
          params: { path: { ws: workspaceId, bot: botId } },
        }),
      ),
    enabled: workspaceId !== "" && botId !== "",
  });
}

/** What one bot has done, and what it cost (task 2.6). */
export function botRunsQuery(workspaceId: string, botId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "bots", botId, "runs"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/bots/{bot}/runs", {
          params: { path: { ws: workspaceId, bot: botId }, query: { limit: 10 } },
        }),
      ).runs,
    enabled: workspaceId !== "" && botId !== "",
  });
}

/**
 * What needs this person (spec §7.1 `/api/inbox?status`; task 2.10). The inbox is personal and
 * crosses workspaces, so the key has no workspace in it.
 */
export function inboxQuery(options: { status?: InboxStatusFilter; kind?: InboxKindFilter } = {}) {
  const status = options.status ?? "open";
  return queryOptions({
    queryKey: ["inbox", status, options.kind ?? "any"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/inbox", {
          params: {
            query: { status, ...(options.kind ? { kind: options.kind } : {}), limit: 100 },
          },
        }),
      ),
  });
}

export type InboxStatusFilter = NonNullable<
  NonNullable<paths["/api/inbox"]["get"]["parameters"]["query"]>["status"]
>;
export type InboxKindFilter = NonNullable<
  NonNullable<paths["/api/inbox"]["get"]["parameters"]["query"]>["kind"]
>;
export type InboxItemRow = components["schemas"]["InboxItem"];

/** What may happen in this workspace (spec §5.7; task 2.11): the document and what it parsed to. */
export function policyQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "policy"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/policy", { params: { path: { ws: workspaceId } } }),
      ),
    enabled: workspaceId !== "",
  });
}

/** What a project's environment carries — keys only, never values (task 2.13). */
export function projectEnvQuery(workspaceId: string, projectId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "project", projectId, "env"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/env", {
          params: { path: { ws: workspaceId, project: projectId } },
        }),
      ).vars,
    enabled: workspaceId !== "" && projectId !== "",
  });
}

/** Who may use one connection, and for what (spec §3.5 grants; task 2.14). */
export function connectionGrantsQuery(workspaceId: string, connectionId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "connections", connectionId, "grants"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/connections/{id}/grants", {
          params: { path: { ws: workspaceId, id: connectionId } },
        }),
      ).grants,
    enabled: workspaceId !== "" && connectionId !== "",
  });
}

export type BotTokenRow = components["schemas"]["BotTokenRow"];
export type BotScope = BotTokenRow["scopes"][number];

/** A bot's Bot API tokens (spec §7.3; task 2.19). Hints only: a token is shown once. */
export function botTokensQuery(workspaceId: string, botId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "bots", botId, "tokens"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/bots/{bot}/tokens", {
          params: { path: { ws: workspaceId, bot: botId } },
        }),
      ).tokens,
    enabled: workspaceId !== "" && botId !== "",
  });
}

export function channelsQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "channels"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/channels", { params: { path: { ws: workspaceId } } }),
      ).channels,
    enabled: workspaceId !== "",
  });
}

/** Who is in one channel (task 2.1). */
export function channelMembersQuery(workspaceId: string, channelId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "channels", channelId, "members"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/channels/{channel}/members", {
          params: { path: { ws: workspaceId, channel: channelId } },
        }),
      ).members,
    enabled: workspaceId !== "" && channelId !== "",
  });
}

/** A page of a channel, oldest first (task 2.2). */
export function messagesQuery(workspaceId: string, channelId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "messages", channelId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/channels/{channel}/messages", {
          params: { path: { ws: workspaceId, channel: channelId }, query: { limit: 200 } },
        }),
      ).messages,
    enabled: workspaceId !== "" && channelId !== "",
  });
}

/** A thread: its root and everything hanging off it (task 2.2). */
export function threadQuery(workspaceId: string, rootId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "thread", rootId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/messages/{message}/thread", {
          params: { path: { ws: workspaceId, message: rootId } },
        }),
      ).messages,
    enabled: workspaceId !== "" && rootId !== "",
  });
}

/** The services this instance can connect to, with the URLs a wizard needs (task 1.16). */
export function connectionProvidersQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "connection-providers"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/connection-providers", {
          params: { path: { ws: workspaceId } },
        }),
      ).providers,
    enabled: workspaceId !== "",
  });
}

export function connectionsQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "connections"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/connections", {
          params: { path: { ws: workspaceId } },
        }),
      ).connections,
    enabled: workspaceId !== "",
  });
}

/**
 * The starter stacks a project can be made from (task 4.8). They are files in the build rather
 * than rows, so this never goes stale within a version and is fetched once.
 */
export function templatesQuery() {
  return queryOptions({
    queryKey: ["templates"],
    queryFn: async () => unwrap(await api.GET("/api/templates", {})).templates,
    staleTime: Number.POSITIVE_INFINITY,
  });
}

/** The ports a project is serving and the links shared from them (task 1.18). */
/**
 * Everything working right now (task 3.19). The socket is how this normally hears about a change;
 * the poller is the belt to its braces, because a list that is quietly wrong about what is running
 * is worse than one that is a few seconds late.
 */
export function agentsQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "agents"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/agents", { params: { path: { ws: workspaceId } } }),
      ),
    enabled: workspaceId !== "",
    refetchInterval: 10_000,
  });
}

/** The connection's open pull requests for this project (task 3.20). */
export function pullRequestsQuery(workspaceId: string, projectId: string, connectionId: string) {
  return queryOptions({
    queryKey: ["pull-requests", workspaceId, projectId, connectionId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/pull-requests", {
          params: {
            path: { ws: workspaceId, project: projectId },
            query: { connection_id: connectionId },
          },
        }),
      ),
    enabled: workspaceId !== "" && projectId !== "" && connectionId !== "",
  });
}

/** One of them, with its inline comments, its reviews and its checks. */
export function pullRequestQuery(
  workspaceId: string,
  projectId: string,
  connectionId: string,
  number: number,
) {
  return queryOptions({
    queryKey: ["pull-requests", workspaceId, projectId, connectionId, number],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/pull-requests/{number}", {
          params: {
            path: { ws: workspaceId, project: projectId, number },
            query: { connection_id: connectionId },
          },
        }),
      ),
    enabled: workspaceId !== "" && projectId !== "" && connectionId !== "" && number > 0,
  });
}

export function previewsQuery(workspaceId: string, projectId: string) {
  return queryOptions({
    queryKey: ["previews", workspaceId, projectId],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/previews", {
          params: { path: { ws: workspaceId, project: projectId } },
        }),
      ),
    enabled: workspaceId !== "" && projectId !== "",
    // A dev server comes up while somebody is looking at the tab; the poller is how they find out.
    refetchInterval: 4_000,
  });
}

/** What changed in a project's working tree (task 1.20). */
export function gitStatusQuery(workspaceId: string, projectId: string) {
  return queryOptions({
    queryKey: ["git", workspaceId, projectId, "status"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/git/status", {
          params: { path: { ws: workspaceId, project: projectId } },
        }),
      ),
    enabled: workspaceId !== "" && projectId !== "",
  });
}

/** The project's branches, and which one it is on (task 1.20). */
export function gitBranchesQuery(workspaceId: string, projectId: string) {
  return queryOptions({
    queryKey: ["git", workspaceId, projectId, "branches"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/projects/{project}/git/branches", {
          params: { path: { ws: workspaceId, project: projectId } },
        }),
      ),
    enabled: workspaceId !== "" && projectId !== "",
  });
}
