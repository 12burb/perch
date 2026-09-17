/**
 * Previews (spec §5.6; task 1.18): which ports a project is serving, where Perch can reach them,
 * and who is allowed through.
 *
 * The proxy only ever reaches a port on a runner the workspace already uses (§5.6 "the proxy
 * reaches only the workspace's own runner ports"), and a runner says for itself whether the api
 * can route to it — a laptop behind NAT does not, and gets the tunnel of task 1.19 instead.
 */
import type { Bus } from "@perch/bus";
import type { Db, PreviewShare, Project, Workspace } from "@perch/db";
import {
  type PreviewProcess,
  portsListResultSchema,
  previewProcessSchema,
  type RunnerLink,
} from "@perch/events";
import {
  hashShareToken,
  mintPreviewTicket,
  mintShareToken,
  previewUrl,
  SHARE_DEFAULT_MS,
  SHARE_MAX_MS,
  shareAllows,
  shareUrl,
  TICKET_MS,
} from "@perch/preview";
import type { Vault } from "@perch/vault";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import {
  findShareByHash,
  insertShare,
  listSharesForProject,
  revokeShare as revokeShareRow,
} from "../repos/previews.ts";
import { findWorkspaceById, findWorkspaceBySlug } from "../repos/workspaces.ts";
import type { RegisteredRunner, RunnerRegistry } from "../runners/registry.ts";
import { envFor } from "./project-env.ts";
import { projectRunnerLink } from "./projects.ts";
import { runnerCall } from "./runners.ts";

export type PreviewDeps = {
  db: Db;
  bus: Bus;
  registry: RunnerRegistry;
  publicUrl: string;
  previewDomain?: string | undefined;
  /** Signs the tickets a member's browser carries onto a preview origin (ADR-0084). */
  secret: string;
};

/** A port Perch can put in front of a browser. */
export type PreviewPort = {
  port: number;
  runnerId: string;
  url: string;
  /** True when the project's config names this port as its dev server (spec §5.1 preview block). */
  configured: boolean;
};

/**
 * How the api gets to a port. A hosted runner shares a network with the api, so it is proxied to
 * directly; a laptop opened its socket outward and is reached back through it (task 1.19).
 */
export type PreviewReach = { link: RunnerLink; runnerId: string; port: number } & (
  | { kind: "direct"; host: string }
  | { kind: "tunnel" }
);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ports a dev server never means, and Perch should never put a browser in front of. */
const NEVER = new Set([22, 25, 445, 3306, 5432, 6379, 11434, 27017]);

export class PreviewService {
  constructor(private readonly deps: PreviewDeps) {}

  /** The workspace a preview URL named, by slug or by id — both spellings reach the same place. */
  async workspaceOf(nameOrId: string): Promise<Workspace | null> {
    if (UUID.test(nameOrId)) {
      const byId = await findWorkspaceById(this.deps.db, nameOrId);
      if (byId) return byId;
    }
    return findWorkspaceBySlug(this.deps.db, nameOrId);
  }

  /**
   * Where a port actually is. Only a runner this workspace uses, only a port it reported listening,
   * and only a runner that told us where it can be reached.
   */
  reach(workspaceId: string, port: number): PreviewReach {
    if (NEVER.has(port)) throw PerchError.forbidden("that port is not a preview");
    const candidates = this.deps.registry.forWorkspace(workspaceId);
    if (candidates.length === 0) throw PerchError.conflict("this workspace has no runner online");
    const listening = candidates.filter((runner) => runner.ports.some((p) => p.port === port));
    // A port the poller has not caught up with yet is still worth trying on the workspace's own
    // runner: ports.changed is a hint, not a gate.
    const pool = listening.length > 0 ? listening : candidates;
    // A runner that said where it is gets the direct lane; one that did not gets the tunnel, which
    // needs only the socket it already opened.
    const direct = pool.find((runner) => hostOf(runner));
    if (direct) {
      return {
        kind: "direct",
        link: direct.link,
        runnerId: direct.link.id,
        host: hostOf(direct) as string,
        port,
      };
    }
    const tunnelled = pool.find((runner) => runner.link.openStream);
    if (!tunnelled) {
      throw PerchError.conflict("this workspace has no runner that can serve a preview", { port });
    }
    return { kind: "tunnel", link: tunnelled.link, runnerId: tunnelled.link.id, port };
  }

  /**
   * A member's way in (ADR-0084). In wildcard mode the preview is an origin of its own, so Perch's
   * session cookie does not reach it; this ticket does, once, and becomes a cookie there.
   */
  ticket(workspaceId: string, userId: string, port: number): Promise<string> {
    return mintPreviewTicket(this.deps.secret, {
      ws: workspaceId,
      user: userId,
      port,
      exp: Date.now() + TICKET_MS,
    });
  }

  /** Every port this workspace's runners are listening on, as URLs a browser can open. */
  ports(workspace: Workspace, project: Project): PreviewPort[] {
    const configured = configuredPort(project);
    const seen = new Map<number, PreviewPort>();
    for (const runner of this.deps.registry.forWorkspace(workspace.id)) {
      // Either lane will do: a hosted runner is proxied to, a laptop is tunnelled through.
      if (!hostOf(runner) && !runner.link.openStream) continue;
      for (const { port } of runner.ports) {
        if (NEVER.has(port) || seen.has(port)) continue;
        seen.set(port, {
          port,
          runnerId: runner.link.id,
          url: this.urlFor(workspace, port, configPath(project)),
          configured: port === configured,
        });
      }
    }
    // A configured port that is not up yet still belongs on the card: that is the Start button.
    if (configured && !seen.has(configured)) {
      seen.set(configured, {
        port: configured,
        runnerId: "",
        url: this.urlFor(workspace, configured, configPath(project)),
        configured: true,
      });
    }
    return [...seen.values()].sort((a, b) => a.port - b.port);
  }

  urlFor(workspace: Workspace, port: number, path = "/"): string {
    return previewUrl({
      publicUrl: this.deps.publicUrl,
      ...(this.deps.previewDomain ? { previewDomain: this.deps.previewDomain } : {}),
      workspaceSlug: workspace.slug,
      workspaceId: workspace.id,
      port,
      path,
    });
  }

  /** The share a token opens, if it may open anything here (spec §5.6: expiring, revocable). */
  async shareFor(
    token: string,
    request: { workspaceId: string; port: number },
  ): Promise<PreviewShare | null> {
    if (!token) return null;
    const share = await findShareByHash(this.deps.db, await hashShareToken(token));
    if (!share) return null;
    const verdict = shareAllows(
      {
        workspaceId: share.workspaceId,
        projectId: share.projectId,
        runnerId: share.runnerId ?? "",
        port: share.port,
        path: share.path,
        public: share.public,
        expiresAt: share.expiresAt,
        revokedAt: share.revokedAt,
      },
      request,
    );
    return verdict.ok ? share : null;
  }

  async shares(workspace: Workspace, project: Project): Promise<PreviewShare[]> {
    return listSharesForProject(this.deps.db, workspace.id, project.id);
  }

  /**
   * A new share. The token is returned once, here, and never again — only its hash is kept, so a
   * lost link is revoked and replaced rather than looked up.
   */
  async createShare(input: {
    workspace: Workspace;
    project: Project;
    port: number;
    path?: string;
    public?: boolean;
    expiresInMs?: number;
    userId: string;
    by: ActorContext;
  }): Promise<{ share: PreviewShare; url: string; token: string }> {
    const reach = this.reach(input.workspace.id, input.port);
    const ms = Math.min(input.expiresInMs ?? SHARE_DEFAULT_MS, SHARE_MAX_MS);
    const token = mintShareToken();
    const path = input.path ?? configPath(input.project);
    const share = await insertShare(this.deps.db, {
      workspaceId: input.workspace.id,
      projectId: input.project.id,
      // Provenance only: a share is resolved by port when it is used (ADR-0084).
      runnerId: UUID.test(reach.runnerId) ? reach.runnerId : null,
      port: input.port,
      path,
      tokenHash: await hashShareToken(token),
      public: input.public ?? false,
      expiresAt: new Date(Date.now() + ms),
      createdBy: input.userId,
    });
    await this.deps.bus.publish(
      "preview.share_created",
      {
        workspaceId: input.workspace.id,
        projectId: input.project.id,
        shareId: share.id,
        port: input.port,
      },
      input.by,
    );
    return {
      share,
      token,
      url: shareUrl({
        publicUrl: this.deps.publicUrl,
        ...(this.deps.previewDomain ? { previewDomain: this.deps.previewDomain } : {}),
        workspaceSlug: input.workspace.slug,
        workspaceId: input.workspace.id,
        port: input.port,
        path,
        token,
      }),
    };
  }

  async revoke(share: PreviewShare, by: ActorContext): Promise<PreviewShare> {
    const revoked = await revokeShareRow(this.deps.db, share.id);
    if (!revoked) throw PerchError.conflict("that share is already revoked");
    await this.deps.bus.publish(
      "preview.share_revoked",
      { workspaceId: share.workspaceId, shareId: share.id },
      by,
    );
    return revoked;
  }
}

/** Where the api can reach this runner's ports, if the runner said (task 1.18). */
function hostOf(runner: RegisteredRunner): string | undefined {
  return runner.link.info.preview_host;
}

/** The dev server port the project's own config names (spec §5.1 `preview.port`). */
export function configuredPort(project: Project): number | undefined {
  return project.config?.preview?.port;
}

/** The path a preview should open on (spec §5.1 `preview.path`). */
export function configPath(project: Project): string {
  const path = project.config?.preview?.path;
  return path?.startsWith("/") ? path : path ? `/${path}` : "/";
}

/** The command that starts the dev server, when the project names one. */
export function previewCommand(project: Project): string | undefined {
  return project.config?.preview?.command;
}

/**
 * Start a project's dev server (task 4.8, ADR-0154). Perch could watch a port; this is what puts
 * something on it. The command is the project's own `preview.command` — never anything a caller
 * sends — so pressing Start cannot run something the project did not already say it runs.
 */
export type PreviewRunDeps = Pick<PreviewDeps, "db" | "registry"> & {
  vault: Vault;
  bus: Bus;
};

/** How long Start waits for the port to answer before it reports what the log says instead. */
export const PREVIEW_START_MS = 45_000;

export type PreviewRunState = PreviewProcess & { port: number | null; serving: boolean };

/** Is the port up, asked of the runner rather than of the registry's last notification? */
async function serving(
  link: RunnerLink,
  project: Project,
  userId: string,
  port: number | null,
): Promise<boolean> {
  if (port === null) return false;
  const raw = await runnerCall(link, "ports.list", {
    workspace_id: project.workspaceId,
    user_id: userId,
  });
  const ports = portsListResultSchema.parse(raw);
  return ports.ports.some((p) => p.port === port);
}

async function runState(
  link: RunnerLink,
  project: Project,
  userId: string,
  process: PreviewProcess,
): Promise<PreviewRunState> {
  const port = configuredPort(project) ?? null;
  return { ...process, port, serving: await serving(link, project, userId, port) };
}

export async function previewStatus(
  deps: PreviewRunDeps,
  project: Project,
  userId: string,
): Promise<PreviewRunState> {
  const link = await projectRunnerLink(deps, project, userId);
  const raw = await runnerCall(link, "preview.status", {
    workspace_id: project.workspaceId,
    user_id: userId,
    project: project.id,
  });
  return runState(link, project, userId, previewProcessSchema.parse(raw));
}

export async function startPreview(
  deps: PreviewRunDeps,
  project: Project,
  userId: string,
  by: ActorContext,
  options: { waitMs?: number } = {},
): Promise<PreviewRunState> {
  const command = previewCommand(project);
  if (!command) {
    throw PerchError.validation(
      "this project does not say how to start its dev server; add preview.command to .perch/project.json",
      { field: "preview.command" },
    );
  }
  const link = await projectRunnerLink(deps, project, userId);
  const port = configuredPort(project) ?? null;
  // Already serving: Start is a no-op with a truthful answer, not a second dev server.
  if (await serving(link, project, userId, port)) {
    const raw = await runnerCall(link, "preview.status", {
      workspace_id: project.workspaceId,
      user_id: userId,
      project: project.id,
    });
    return { ...previewProcessSchema.parse(raw), port, serving: true };
  }
  const env = await envFor({ db: deps.db, vault: deps.vault }, project);
  const raw = await runnerCall(link, "preview.start", {
    workspace_id: project.workspaceId,
    user_id: userId,
    project: project.id,
    command,
    ...(Object.keys(env).length > 0 ? { env } : {}),
  });
  const process = previewProcessSchema.parse(raw);
  await deps.bus.publish(
    "project.updated",
    { workspaceId: project.workspaceId, projectId: project.id, changes: ["preview"] },
    by,
  );
  // Wait for the port, so "Start" means the preview is there when the button comes back.
  const deadline = Date.now() + (options.waitMs ?? PREVIEW_START_MS);
  for (;;) {
    if (await serving(link, project, userId, port)) break;
    if (Date.now() >= deadline) break;
    await Bun.sleep(400);
  }
  const latest = await runnerCall(link, "preview.status", {
    workspace_id: project.workspaceId,
    user_id: userId,
    project: project.id,
  });
  const after = previewProcessSchema.parse(latest);
  return {
    ...after,
    started: process.started,
    port,
    serving: await serving(link, project, userId, port),
  };
}

export async function stopPreview(
  deps: PreviewRunDeps,
  project: Project,
  userId: string,
  by: ActorContext,
): Promise<PreviewRunState> {
  const link = await projectRunnerLink(deps, project, userId);
  const raw = await runnerCall(link, "preview.stop", {
    workspace_id: project.workspaceId,
    user_id: userId,
    project: project.id,
  });
  await deps.bus.publish(
    "project.updated",
    { workspaceId: project.workspaceId, projectId: project.id, changes: ["preview"] },
    by,
  );
  return runState(link, project, userId, previewProcessSchema.parse(raw));
}
