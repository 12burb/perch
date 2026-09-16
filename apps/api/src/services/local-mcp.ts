/**
 * MCP servers that run inside a runner (spec §3.5 "runner-local stdio MCP servers are exposed
 * through the same shape", §7.6 `mcp.spawn`; task 3.24).
 *
 * A project can ship its own tools — a script in the repository that knows the schema, the fixtures,
 * the deploy — and nothing about that server is Perch's to host. So Perch does not host it: the
 * runner spawns it beside the checkout and the api speaks MCP down the stream it answers with. From
 * the other side, `/mcp/{id}` looks exactly like a connection's server, which is the point: a bot
 * attaches it the way it attaches anything.
 *
 * There is no credential in any of this, which is what makes it simpler than a connection. A grant
 * exists to hand a bot somebody else's token; a local server has no token, so what gates it is the
 * workspace it belongs to, the bot spec that names it, and the runner's own policy on what may be
 * run at all (ADR-0142).
 */

import type { Bus } from "@perch/bus";
import { allowed, argsHash, listUpstreamTools, openLocal, type UpstreamTool } from "@perch/connect";
import type { Db, McpServer, Project } from "@perch/db";
import type { RunnerLink } from "@perch/events";
import type { Logger } from "pino";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { rememberTools } from "../repos/mcp-servers.ts";
import type { RunnerRegistry } from "../runners/registry.ts";
import { getProject, projectRunnerLink } from "./projects.ts";
import { runnerCall } from "./runners.ts";

export type LocalMcpDeps = {
  db: Db;
  bus: Bus;
  log: Logger;
  registry: RunnerRegistry;
};

/** A client on a spawned server, and the way to stop it. */
type Open = {
  tools: () => Promise<UpstreamTool[]>;
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>;
  close: () => Promise<void>;
};

export class LocalMcpService {
  constructor(private readonly deps: LocalMcpDeps) {}

  /** What this server can do, from the runner if it is up and from the row if it is not. */
  async tools(
    server: McpServer,
    allowList: string[] | null,
    userId: string,
  ): Promise<UpstreamTool[]> {
    try {
      const open = await this.open(server, userId);
      try {
        const listed = await open.tools();
        await rememberTools(this.deps.db, server.id, listed);
        return allowed(listed, allowList);
      } finally {
        await open.close();
      }
    } catch (error) {
      // A runner that is asleep should not empty a bot's tool list on the spot: the last list it
      // gave is still what this server does.
      this.deps.log.warn(
        { err: error, mcpServerId: server.id },
        "could not list a local MCP server",
      );
      if (server.toolCache.length === 0) throw error;
      return allowed(server.toolCache, allowList);
    }
  }

  /** One call, on a server spawned for it and stopped after it, audited whatever happens. */
  async call(input: {
    server: McpServer;
    allowList: string[] | null;
    tool: string;
    args: Record<string, unknown>;
    by: ActorContext;
    callerId: string;
    userId: string;
  }): Promise<unknown> {
    const hash = await argsHash(input.args);
    const audit = (outcome: "ok" | "error" | "denied") =>
      this.deps.bus.publish(
        "tools.called",
        {
          workspaceId: input.server.workspaceId,
          mcpServerId: input.server.id,
          tool: input.tool,
          callerType: input.by.actor.type === "bot" ? "bot" : "user",
          callerId: input.callerId,
          argsHash: hash,
          outcome,
        },
        input.by,
      );
    if (input.allowList && !input.allowList.includes(input.tool)) {
      await audit("denied");
      throw PerchError.forbidden(`${input.tool} is not one of this server's allowed tools`);
    }
    let open: Open;
    try {
      open = await this.open(input.server, input.userId);
    } catch (error) {
      await audit("error");
      throw error;
    }
    try {
      const answer = await open.call(input.tool, input.args);
      await audit("ok");
      return answer;
    } catch (error) {
      await audit("error");
      throw new PerchError(
        "upstream_failed",
        error instanceof Error ? error.message : String(error),
        undefined,
        502,
      );
    } finally {
      await open.close();
    }
  }

  /** The project this server belongs to, or the reason it cannot be reached. */
  async projectOf(server: McpServer): Promise<Project> {
    if (!server.projectId) {
      throw PerchError.validation("this server is not attached to a project");
    }
    const project = await getProject(this.deps.db, server.workspaceId, server.projectId);
    if (!project) throw PerchError.notFound("project");
    return project;
  }

  /**
   * Spawn one and connect to it. A server per call rather than a pool: a process that lives
   * between calls is a process holding a checkout open, and the runner is where the cost of
   * starting one is smallest.
   */
  private async open(server: McpServer, userId: string): Promise<Open> {
    if (server.transport !== "stdio" || !server.command) {
      throw PerchError.validation("that server is not one a runner hosts");
    }
    const project = await this.projectOf(server);
    const link: RunnerLink = await projectRunnerLink(
      { db: this.deps.db, registry: this.deps.registry },
      project,
      userId,
    );
    if (!link.openStream) {
      throw PerchError.conflict("this runner cannot open a stream for an MCP server");
    }
    const raw = await runnerCall(link, "mcp.spawn", {
      workspace_id: server.workspaceId,
      user_id: userId,
      project: project.id,
      command: server.command.command,
      args: server.command.args,
    });
    const token = (raw as { stream_token?: string }).stream_token;
    if (!token)
      throw new PerchError("upstream_failed", "the runner opened no stream", undefined, 502);
    const stream = await link.openStream(token);
    const client = await openLocal(stream);
    return {
      tools: () => listUpstreamTools(client),
      call: async (tool, args) => await client.callTool({ name: tool, arguments: args }),
      close: async () => {
        await client.close().catch(() => undefined);
        stream.close();
      },
    };
  }
}
