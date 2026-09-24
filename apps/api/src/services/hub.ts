/**
 * Installing something from the Hub (task 4.12).
 *
 * The index itself is `@perch/hub` — data, no database. This is the half that changes a workspace,
 * and it does it by calling the services a person's own clicks call: a bot is created the way the
 * Forge creates one, a project the way the New project button makes one, a skill by updating the
 * bot it goes on. Nothing here has a second code path, which is the point of the Hub being a
 * front door rather than a feature.
 *
 * A connector is the exception and says so: connecting one is an OAuth round trip or a pasted
 * token, neither of which a server can do on somebody's behalf. Its install returns where to go
 * (ADR-0158) instead of pretending to have done something.
 */
import { templateById } from "@perch/bots/templates";
import type { Bot } from "@perch/db";
import { botSpecSchema } from "@perch/db";
import { type HubItem, hubItem } from "@perch/hub";
import type { ActorContext } from "../auth/authorize.ts";
import { PerchError } from "../errors.ts";
import { botByHandle } from "../repos/bots.ts";
import type { BotsService } from "./bots.ts";
import { channelFor } from "./channels.ts";
import { createProject, type ProjectDeps } from "./projects.ts";

export type HubDeps = ProjectDeps & { bots: BotsService };

export function hubDepsFrom(projects: ProjectDeps, bots: BotsService): HubDeps {
  return { ...projects, bots };
}

export type HubInstallInput = {
  workspaceId: string;
  userId: string;
  /**
   * Whether the caller answers for the workspace's bots (`bots.admin`). A skill changes a bot, and
   * changing somebody else's bot is that person's or an admin's — the same rule as the Forge.
   */
  botsAdmin: boolean;
  kind: string;
  id: string;
  /** For a skill: the handle of the bot it goes on. */
  bot?: string | undefined;
  /** For a bot: a channel to put it in as well, so one press is enough to talk to it. */
  channel?: string | undefined;
  /** For a template: what the project is called; the stack's own name otherwise. */
  name?: string | undefined;
  by: ActorContext;
};

export type HubInstallResult = {
  item: HubItem;
  /** False when there was nothing to do, which is not a failure: the thing is already here. */
  installed: boolean;
  /** What happened, in one line, for the card that appears afterwards. */
  detail: string;
  /** Where to go next: the bot, the project, or the Connections card. */
  href?: string;
  /** What was made, when something was. */
  botId?: string;
  projectId?: string;
};

/** Installs one Hub item into a workspace, or says why it could not. */
export async function installFromHub(
  deps: HubDeps,
  input: HubInstallInput,
  workspaceSlug: string,
): Promise<HubInstallResult> {
  const item = hubItem(input.kind, input.id);
  if (!item) throw PerchError.notFound("hub item");
  switch (item.kind) {
    case "connector":
      return {
        item,
        installed: false,
        detail: `Connect ${item.name} from Settings: sign in, or paste a token.`,
        href: `/${workspaceSlug}/settings?connect=${item.id}`,
      };
    case "bot":
      return await installBot(deps, input, item, workspaceSlug);
    case "skill":
      return await installSkill(deps, input, item, workspaceSlug);
    case "template":
      return await installTemplate(deps, input, item, workspaceSlug);
  }
}

async function installBot(
  deps: HubDeps,
  input: HubInstallInput,
  item: HubItem,
  workspaceSlug: string,
): Promise<HubInstallResult> {
  const template = templateById(item.id);
  if (!template) throw PerchError.notFound("hub item");
  const existing = await botByHandle(deps.db, input.workspaceId, template.handle);
  if (existing) {
    return {
      item,
      installed: false,
      detail: `@${template.handle} is already in this workspace.`,
      href: `/${workspaceSlug}/bots`,
      botId: existing.id,
    };
  }
  const bot = await deps.bots.create({
    workspaceId: input.workspaceId,
    ownerId: input.userId,
    handle: template.handle,
    name: template.name,
    visibility: "workspace",
    spec: botSpecSchema.parse({
      persona: template.persona,
      tools: template.tools,
      triggers: template.triggers,
      ...(template.skills ? { skills: template.skills } : {}),
    }),
    ...(template.budget.dailyUsd ? { budget: { dailyUsd: template.budget.dailyUsd } } : {}),
    by: input.by,
  });
  const where = await putInChannel(deps, input, bot);
  return {
    item,
    installed: true,
    detail: where
      ? `@${template.handle} is in ${where.name ? `#${where.name}` : "that channel"}. Say its name and it answers.`
      : `@${template.handle} is here. Put it in a channel and say its name.`,
    href: where ? `/${workspaceSlug}/home/${where.id}` : `/${workspaceSlug}/bots`,
    botId: bot.id,
  };
}

/**
 * The channel a bot install was asked to put it in, if it was asked for one. Putting a bot somewhere
 * is putting it in a channel you are in yourself, so a private channel the installer is not in is
 * not there — the same answer the Forge's install gives.
 */
async function putInChannel(
  deps: HubDeps,
  input: HubInstallInput,
  bot: Bot,
): Promise<{ id: string; name: string | null } | null> {
  if (!input.channel) return null;
  const channel = await channelFor(
    { db: { db: deps.db }, bus: deps.bus },
    input.workspaceId,
    input.channel,
    input.userId,
  );
  await deps.bots.install(bot, channel, input.by);
  return { id: channel.id, name: channel.name };
}

/** Whether the bot a Hub install would change is the caller's to change. */
function mayChange(input: HubInstallInput, bot: Bot): void {
  if (bot.ownerId === input.userId) return;
  // Somebody else's private bot is not there at all; a shared one is visible but not theirs.
  if (bot.visibility === "private") throw PerchError.notFound("bot");
  if (!input.botsAdmin) {
    throw PerchError.forbidden("changing a bot is its owner's, or an admin's", {
      action: "bots.admin",
    });
  }
}

async function installSkill(
  deps: HubDeps,
  input: HubInstallInput,
  item: HubItem,
  workspaceSlug: string,
): Promise<HubInstallResult> {
  const handle = (input.bot ?? "").replace(/^@/, "").trim();
  if (!handle) {
    throw PerchError.validation("a skill is installed onto a bot: name one", { field: "bot" });
  }
  const bot = await botByHandle(deps.db, input.workspaceId, handle);
  if (!bot) throw PerchError.notFound("bot");
  mayChange(input, bot);
  const source = item.parent ? templateById(item.parent) : undefined;
  const skill = source?.skills?.find((one) => one.name === item.id);
  if (!skill) throw PerchError.notFound("hub item");
  const skills = bot.spec.skills ?? [];
  if (skills.some((one) => one.name === skill.name)) {
    return {
      item,
      installed: false,
      detail: `@${handle} already knows ${skill.name}.`,
      href: `/${workspaceSlug}/bots`,
      botId: bot.id,
    };
  }
  // Everything the bot had, plus the one skill: a skill is an addition, never a replacement.
  const spec = botSpecSchema.parse({ ...bot.spec, skills: [...skills, skill] });
  await deps.bots.update(bot, { spec });
  return {
    item,
    installed: true,
    detail: `@${handle} knows ${skill.name} now.`,
    href: `/${workspaceSlug}/bots`,
    botId: bot.id,
  };
}

async function installTemplate(
  deps: HubDeps,
  input: HubInstallInput,
  item: HubItem,
  workspaceSlug: string,
): Promise<HubInstallResult> {
  const { project } = await createProject(deps, {
    workspaceId: input.workspaceId,
    name: (input.name ?? "").trim() || item.name,
    source: { kind: "template", templateId: item.id },
    userId: input.userId,
    by: input.by,
  });
  return {
    item,
    installed: true,
    detail: `${project.name} is ready. Open it and press Start.`,
    href: `/${workspaceSlug}/code/${project.key}`,
    projectId: project.id,
  };
}
