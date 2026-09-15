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
import type { RunnerLink } from "@perch/events";
import {
  hashShareToken,
  mintShareToken,
  previewUrl,
  SHARE_DEFAULT_MS,
  SHARE_MAX_MS,
  shareAllows,
  shareUrl,
} from "@perch/preview";
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

export type PreviewDeps = {
  db: Db;
  bus: Bus;
  registry: RunnerRegistry;
  publicUrl: string;
  previewDomain?: string | undefined;
};

/** A port Perch can put in front of a browser. */
export type PreviewPort = {
  port: number;
  runnerId: string;
  url: string;
  /** True when the project's config names this port as its dev server (spec §5.1 preview block). */
  configured: boolean;
};

export type PreviewReach = { link: RunnerLink; runnerId: string; host: string; port: number };

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
    const reachable = pool.find((runner) => hostOf(runner));
    if (!reachable) {
      const why = pool.some((runner) => runner.link.info.kind !== "hosted")
        ? "previews on a local runner travel through the runner's own connection, which arrives with task 1.19"
        : "the runner did not say where its ports can be reached";
      throw PerchError.conflict(why, { port });
    }
    const host = hostOf(reachable) as string;
    return { link: reachable.link, runnerId: reachable.link.id, host, port };
  }

  /** Every port this workspace's runners are listening on, as URLs a browser can open. */
  ports(workspace: Workspace, project: Project): PreviewPort[] {
    const configured = configuredPort(project);
    const seen = new Map<number, PreviewPort>();
    for (const runner of this.deps.registry.forWorkspace(workspace.id)) {
      if (!hostOf(runner)) continue;
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
