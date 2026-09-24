/**
 * Installing the Nest (spec §5.3 "Nest agents (Birbus orchestrator; Dawn, Julius, Paige, Kimi
 * specialists) join via the Bot API or the hermes adapter"; task 3.9).
 *
 * The roster in `@perch/bots/nest` says who they are; this makes them bots in a workspace. Two
 * doors, and the door decides what the bot is:
 *
 * - `bot_api` → an **external** bot with a token minted once. The agent runs wherever it already
 *   runs — a Hermes process, a script, somebody's laptop — and Perch is somewhere it talks (§7.3).
 * - `hermes` → an **agent bot** on the `hermes` engine (task 3.8): Perch runs it on a runner, and a
 *   mention opens a session on one of its projects (task 3.7).
 *
 * Nothing here is privileged. What comes out is ordinary bots an admin can edit, install in a
 * channel, or delete; no connection is granted by installing one, because a grant is somebody's
 * decision and not a side effect (spec §3.5, AGENTS.md §1.6). Running it twice installs what is
 * missing and leaves the rest alone.
 */
import { NEST_AGENTS, type NestAgent } from "@perch/bots/nest";
import type { Bot, BotSpec, Db } from "@perch/db";
import type { ActorContext } from "../auth/authorize.ts";
import { insertBotToken } from "../repos/bot-tokens.ts";
import { botByHandle } from "../repos/bots.ts";
import { listProjects } from "../repos/projects.ts";
import { handleTaken } from "../repos/users.ts";
import { botTokenHint, botTokenValue } from "./bot-api.ts";
import type { BotsService } from "./bots.ts";
import { hashToken } from "./tokens.ts";

/** The scopes a Nest agent's own token gets: everything it needs to be a member and nothing more. */
export const NEST_TOKEN_SCOPES = [
  "chat:write",
  "chat:read",
  "channels:read",
  "tools:call",
  "files:write",
] as const;

export type NestInstalled = {
  handle: string;
  name: string;
  botId: string;
  door: NestAgent["door"];
  /** Minted once, for an agent that joins over the Bot API. Never readable again. */
  token?: string;
  /** Providers this agent expects a grant for; an admin still has to give it (spec §3.5). */
  connections: string[];
};

export type NestResult = {
  installed: NestInstalled[];
  /** Agents that were already here: left exactly as they are. */
  already: string[];
  /** Roster handles a person in this workspace already has: those agents are not installed. */
  taken: string[];
};

export type NestDeps = { db: Db; bots: BotsService };

/** The spec a roster entry becomes, with the projects a hermes agent may work on filled in. */
export function specFor(agent: NestAgent, projects: readonly string[]): BotSpec {
  return {
    persona: agent.persona,
    ...(agent.tools?.length ? { tools: agent.tools as BotSpec["tools"] } : {}),
    triggers: agent.triggers as BotSpec["triggers"],
    ...(agent.skills?.length ? { skills: agent.skills } : {}),
    ...(agent.door === "hermes"
      ? { engine: "hermes", ...(projects.length ? { projects: [...projects] } : {}) }
      : {}),
  };
}

export class NestService {
  constructor(private readonly deps: NestDeps) {}

  /**
   * Makes the ones that are missing. `handles` narrows it to some of the roster; without it, the
   * whole Nest. A handle already taken — by a bot or by a person — is left alone and reported,
   * because taking somebody's name is never the helpful thing to do.
   */
  async install(input: {
    workspaceId: string;
    ownerId: string;
    handles?: readonly string[];
    by: ActorContext;
  }): Promise<NestResult> {
    const wanted = input.handles?.length
      ? NEST_AGENTS.filter((one) => input.handles?.includes(one.handle))
      : NEST_AGENTS;
    // A hermes agent works on this workspace's projects; an empty workspace gets an agent with
    // none, which says so when it is asked rather than failing to install.
    const projects = (await listProjects(this.deps.db, input.workspaceId)).map((one) => one.name);
    const installed: NestInstalled[] = [];
    const already: string[] = [];
    const taken: string[] = [];
    for (const agent of wanted) {
      if (await botByHandle(this.deps.db, input.workspaceId, agent.handle)) {
        already.push(agent.handle);
        continue;
      }
      // Checked before anything is made: a conflict half-way would lose the tokens already minted
      // for the agents before it, and those are shown once.
      if (await handleTaken(this.deps.db, agent.handle, input.workspaceId)) {
        taken.push(agent.handle);
        continue;
      }
      const bot = await this.make(agent, projects, input);
      installed.push(bot);
    }
    return { installed, already, taken };
  }

  private async make(
    agent: NestAgent,
    projects: readonly string[],
    input: { workspaceId: string; ownerId: string; by: ActorContext },
  ): Promise<NestInstalled> {
    const bot: Bot = await this.deps.bots.create({
      workspaceId: input.workspaceId,
      ownerId: input.ownerId,
      handle: agent.handle,
      name: agent.name,
      spec: specFor(agent, projects),
      // The Nest is a team: everybody in the workspace can talk to them.
      visibility: "workspace",
      budget: agent.budget,
      ...(agent.orchestrator ? { orchestrator: true } : {}),
      ...(agent.door === "bot_api" ? { level: "external" as const } : {}),
      by: input.by,
    });
    const out: NestInstalled = {
      handle: bot.handle,
      name: bot.name,
      botId: bot.id,
      door: agent.door,
      connections: agent.connections ? [...agent.connections] : [],
    };
    if (agent.door !== "bot_api") return out;
    // The token is the door: shown once here, stored as a hash, and never readable again (§7.3).
    const token = botTokenValue();
    await insertBotToken(this.deps.db, {
      botId: bot.id,
      workspaceId: bot.workspaceId,
      name: `${agent.name} (Nest)`,
      tokenHash: hashToken(token),
      hint: botTokenHint(token),
      scopes: [...NEST_TOKEN_SCOPES],
      createdBy: input.ownerId,
    });
    return { ...out, token };
  }
}
