/**
 * TanStack Query definitions shared by routes and components. Keys are stable strings so mutations
 * can invalidate precisely.
 */

import type { components } from "@perch/api-client";
import { queryOptions } from "@tanstack/react-query";
import { api, unwrap } from "./api.ts";

export type MyWorkspace = components["schemas"]["MyWorkspace"];
export type Me = components["schemas"]["Me"];
export type Member = components["schemas"]["Member"];
export type AuditRow = components["schemas"]["AuditRow"];
export type RunnerRow = components["schemas"]["Runner"];
export type ProjectRow = components["schemas"]["Project"];
export type DeployKeyRow = components["schemas"]["DeployKey"];
export type SessionRow = components["schemas"]["Session"];
export type SessionEventRecord = components["schemas"]["SessionEventRecord"];

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

export function auditQuery(workspaceId: string) {
  return queryOptions({
    queryKey: ["workspace", workspaceId, "audit"],
    queryFn: async () =>
      unwrap(
        await api.GET("/api/workspaces/{ws}/audit", {
          params: { path: { ws: workspaceId }, query: { limit: 30 } },
        }),
      ).rows,
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
