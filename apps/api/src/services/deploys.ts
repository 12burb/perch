/**
 * The Deploy button (spec §5.5 "Vercel … Deploy button via git-based deploy …, preview-URL cards";
 * task 2.15).
 *
 * A deploy is asked for from the IDE and answered in chat: Perch asks the provider to build the
 * project's current branch and posts a card in a channel with where it got to. The card is the
 * record — there is no deployments table (spec §6 has none) — so refreshing rewrites the card in
 * place and the thread always says the truth, which is also what somebody scrolling back tomorrow
 * reads.
 *
 * The connection's token is minted for each call and goes nowhere else (AGENTS.md §1.6).
 */

import type { Bus } from "@perch/bus";
import { apiBaseOf, type FetchLike } from "@perch/connect";
import type { Channel, Connection, Db, Message, MessageBlock, Project } from "@perch/db";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { getMessage, insertMessage, updateMessageBlocks } from "../repos/messages.ts";
import type { ConnectionsService } from "./connections.ts";
import { repoSlug } from "./pull-requests.ts";

export type DeployTarget = "preview" | "production";
export type DeployState = "queued" | "building" | "ready" | "error" | "canceled";

export type Deployment = {
  id: string;
  state: DeployState;
  target: DeployTarget;
  url: string | null;
  inspectorUrl: string | null;
};

export type DeployDeps = {
  db: { db: Db };
  bus: Bus;
  connections: ConnectionsService;
  fetch?: FetchLike;
};

/** The provider's word for where a build got to, as one of ours. */
export function stateOf(raw: unknown): DeployState {
  const value = String(raw ?? "").toUpperCase();
  if (value === "READY") return "ready";
  if (value === "ERROR" || value === "FAILED") return "error";
  if (value === "CANCELED" || value === "CANCELLED") return "canceled";
  if (value === "QUEUED" || value === "INITIALIZING") return "queued";
  return "building";
}

/** Vercel answers a bare hostname; a card wants something a person can click. */
function absolute(url: unknown): string | null {
  const value = typeof url === "string" ? url.trim() : "";
  if (!value) return null;
  return /^https?:\/\//.test(value) ? value : `https://${value}`;
}

type VercelDeployment = {
  id?: unknown;
  url?: unknown;
  readyState?: unknown;
  status?: unknown;
  inspectorUrl?: unknown;
  target?: unknown;
};

function readDeployment(body: VercelDeployment, target: DeployTarget): Deployment {
  const id = typeof body.id === "string" ? body.id : "";
  if (!id)
    throw new PerchError("upstream_failed", "the provider named no deployment", undefined, 502);
  return {
    id,
    state: stateOf(body.readyState ?? body.status),
    target,
    url: absolute(body.url),
    inspectorUrl: absolute(body.inspectorUrl),
  };
}

/** The card a deploy is, in the one shape both halves of this file agree on. */
export function deployCard(input: {
  deployment: Deployment;
  provider: string;
  projectName: string;
  branch?: string | undefined;
  commit?: string | undefined;
}): Extract<MessageBlock, { type: "deploy_card" }> {
  const { deployment } = input;
  return {
    type: "deploy_card",
    provider: input.provider,
    deploymentId: deployment.id,
    target: deployment.target,
    state: deployment.state,
    ...(deployment.url ? { url: deployment.url } : {}),
    ...(deployment.inspectorUrl ? { inspectorUrl: deployment.inspectorUrl } : {}),
    ...(input.branch ? { branch: input.branch } : {}),
    ...(input.commit ? { commit: input.commit } : {}),
    text: input.projectName,
  };
}

export class DeployService {
  constructor(private readonly deps: DeployDeps) {}

  /**
   * Ask the provider to build this project's branch, and say so in a channel. Both halves matter:
   * without the card the deploy is invisible to everyone but whoever pressed the button.
   */
  async start(input: {
    project: Project;
    connection: Connection;
    channel: Channel;
    userId: string;
    target: DeployTarget;
    branch?: string | undefined;
    threadRootId?: string | undefined;
    by: ActorContext;
  }): Promise<{ deployment: Deployment; message: Message }> {
    // A thread is a thread of this channel: checked before the provider is asked for anything.
    const threadRootId = input.threadRootId
      ? await this.rootIn(input.channel, input.threadRootId)
      : undefined;
    const deployment = await this.create(
      input.project,
      input.connection,
      input.target,
      input.branch,
    );
    const message = await this.card({ ...input, threadRootId }, deployment);
    await this.deps.bus.publish(
      "deploy.started",
      {
        workspaceId: input.project.workspaceId,
        projectId: input.project.id,
        provider: input.connection.provider,
        deploymentId: deployment.id,
        target: deployment.target,
        state: deployment.state,
        ...(deployment.url ? { url: deployment.url } : {}),
        messageId: message.id,
      },
      input.by,
    );
    return { deployment, message };
  }

  /**
   * The thread a card goes under: a message in the card's own channel, and that message's own root
   * when it is a reply. One from anywhere else is not there, as it is for a bot's postMessage.
   */
  private async rootIn(channel: Channel, messageId: string): Promise<string> {
    const root = await getMessage(this.deps.db.db, messageId);
    if (!root || root.deletedAt || root.channelId !== channel.id) {
      throw PerchError.notFound("message");
    }
    return root.threadRootId ?? root.id;
  }

  /**
   * Ask again, and rewrite the card. Nothing here trusts what the card said before: the provider is
   * the only thing that knows whether a build finished.
   */
  async refresh(input: {
    connection: Connection;
    messageId: string;
    by: ActorContext;
  }): Promise<Deployment> {
    const message = await getMessage(this.deps.db.db, input.messageId);
    if (!message || message.workspaceId !== input.connection.workspaceId) {
      throw PerchError.notFound("message");
    }
    const at = message.blocks.findIndex((block) => block.type === "deploy_card");
    const card = message.blocks[at];
    if (card?.type !== "deploy_card") {
      throw PerchError.validation("that message is not a deploy");
    }
    const fresh = await this.read(input.connection, card.deploymentId, card.target);
    if (fresh.state === card.state && fresh.url === (card.url ?? null)) return fresh;
    const blocks = [...message.blocks];
    blocks[at] = {
      ...card,
      state: fresh.state,
      ...(fresh.url ? { url: fresh.url } : {}),
      ...(fresh.inspectorUrl ? { inspectorUrl: fresh.inspectorUrl } : {}),
    };
    // A build moving is not an edit somebody made, so it keeps no edit history.
    await updateMessageBlocks(this.deps.db.db, message, blocks, {
      type: "system",
      id: message.authorId,
      history: false,
    });
    await this.deps.bus.publish(
      "message.updated",
      {
        workspaceId: message.workspaceId,
        channelId: message.channelId,
        messageId: message.id,
      },
      input.by,
    );
    return fresh;
  }

  /** The provider's create call. Git-based: the repository Vercel already knows, at this ref. */
  private async create(
    project: Project,
    connection: Connection,
    target: DeployTarget,
    branch?: string | undefined,
  ): Promise<Deployment> {
    if (!project.repoUrl) {
      throw PerchError.validation("this project has no repository to deploy from");
    }
    const slug = repoSlug(project.repoUrl);
    if (!slug) throw PerchError.validation(`${project.repoUrl} is not a repository URL`);
    const ref = branch?.trim() || project.head || project.defaultBranch;
    const body = {
      name: project.key,
      project: project.key,
      target,
      gitSource: { type: "github", org: slug.owner, repo: slug.repo, ref },
    };
    const answer = await this.call(connection, "/v13/deployments?forceNew=1", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return readDeployment(answer, target);
  }

  private async read(
    connection: Connection,
    deploymentId: string,
    target: DeployTarget,
  ): Promise<Deployment> {
    const answer = await this.call(
      connection,
      `/v13/deployments/${encodeURIComponent(deploymentId)}`,
    );
    return readDeployment(answer, target);
  }

  /** One call to the provider, on a token minted for it and attached to nothing else. */
  private async call(
    connection: Connection,
    path: string,
    init: { method?: string; body?: string } = {},
  ): Promise<VercelDeployment> {
    const manifest = this.deps.connections.manifest(connection.provider);
    const base = apiBaseOf(manifest, connection.metadata.apiBase);
    const token = await this.deps.connections.tokenFor(connection);
    const call: FetchLike = this.deps.fetch ?? fetch;
    let response: Response;
    try {
      response = await call(`${base}${path}`, {
        method: init.method ?? "GET",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "user-agent": "perch",
        },
        ...(init.body === undefined ? {} : { body: init.body }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new PerchError(
        "upstream_failed",
        `could not reach ${manifest.name}: ${error instanceof Error ? error.message : String(error)}`,
        undefined,
        502,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      // The provider's own words, which is what makes a failed deploy fixable; never the token.
      const reason = reasonOf(text) ?? `${response.status} ${response.statusText}`.trim();
      throw new PerchError(
        "upstream_failed",
        `${manifest.name} refused: ${reason}`,
        undefined,
        502,
      );
    }
    try {
      return JSON.parse(text) as VercelDeployment;
    } catch {
      throw new PerchError(
        "upstream_failed",
        `${manifest.name} answered with no deployment`,
        undefined,
        502,
      );
    }
  }

  private async card(
    input: {
      project: Project;
      connection: Connection;
      channel: Channel;
      userId: string;
      branch?: string | undefined;
      threadRootId?: string | undefined;
      by: ActorContext;
    },
    deployment: Deployment,
  ): Promise<Message> {
    const block = deployCard({
      deployment,
      provider: input.connection.provider,
      projectName: input.project.name,
      branch: input.branch?.trim() || input.project.head || input.project.defaultBranch,
    });
    const message = await insertMessage(this.deps.db.db, {
      workspaceId: input.project.workspaceId,
      channelId: input.channel.id,
      threadRootId: input.threadRootId ?? null,
      // The deploy is the person's, not a bot's: they pressed the button.
      authorType: "user",
      authorId: input.userId,
      blocks: [block],
    });
    await this.deps.bus.publish(
      "message.created",
      {
        workspaceId: input.project.workspaceId,
        channelId: input.channel.id,
        messageId: message.id,
        ...(input.threadRootId ? { threadRootId: input.threadRootId } : {}),
        authorType: "user" as const,
        authorId: input.userId,
      },
      { ...input.by, topics: [`channel:${input.channel.id}`] },
    );
    return message;
  }
}

/** What a provider said went wrong, out of whatever shape it said it in. */
function reasonOf(text: string): string | null {
  try {
    const body = JSON.parse(text) as { error?: { message?: unknown }; message?: unknown };
    const message = body.error?.message ?? body.message;
    return typeof message === "string" && message ? message : null;
  } catch {
    return null;
  }
}
