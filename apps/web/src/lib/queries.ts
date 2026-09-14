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
