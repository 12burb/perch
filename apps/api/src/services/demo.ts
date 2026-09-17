/**
 * The demo workspace (task 4.8; spec §4 "first run", `PERCH_DEMO_WORKSPACE`).
 *
 * A Perch with nothing in it is a set of empty states, and an empty state cannot show what a
 * workspace looks like when it is being used. This puts something in it: a few channels, two bots
 * from the Forge's own templates, and a project made from a starter stack with its dev server
 * running — every one of them the real thing, made through the same services a person's clicks go
 * through, so nothing here is a fixture that only exists in the demo.
 *
 * It is safe to run twice: anything already there is left alone and reported as skipped.
 */

import { templateById } from "@perch/bots/templates";
import { botSpecSchema } from "@perch/db";
import { STACKS, stackById } from "@perch/templates";
import type { ActorContext } from "../auth/authorize.ts";
import { botByHandle } from "../repos/bots.ts";
import { findChannelByName } from "../repos/channels.ts";
import { insertMessage } from "../repos/messages.ts";
import { findProjectByKey } from "../repos/projects.ts";
import type { BotsService } from "./bots.ts";
import { createChannel } from "./channels.ts";
import type { PreviewRunDeps } from "./previews.ts";
import { startPreview } from "./previews.ts";
import { createProject, type ProjectDeps } from "./projects.ts";

export type DemoDeps = ProjectDeps & { bots: BotsService; previews: PreviewRunDeps };

/** The demo's deps from the ones a project route already builds, so neither caller assembles them. */
export function demoDepsFrom(projects: ProjectDeps, bots: BotsService): DemoDeps {
  return {
    ...projects,
    bots,
    previews: {
      db: projects.db,
      bus: projects.bus,
      registry: projects.registry,
      vault: projects.vault,
    },
  };
}

/** The channels the demo opens with, in the order somebody reads them. */
export const DEMO_CHANNELS: { name: string; topic: string }[] = [
  { name: "general", topic: "Everything, until it needs its own channel" },
  { name: "builds", topic: "Previews, deploys and what broke" },
  { name: "the-nest", topic: "Where the bots talk to each other" },
];

/** The two bots the demo installs, by Forge template id. */
export const DEMO_BOTS = ["gpt-helpdesk", "12birb-editor"] as const;

/** The starter stack the demo's project is made from: no install step, so it starts at once. */
export const DEMO_STACK = "bun-api";

export type DemoResult = {
  workspaceId: string;
  channels: { name: string; created: boolean }[];
  bots: { handle: string; created: boolean }[];
  project: { id: string; key: string; created: boolean; status: string } | null;
  preview: { port: number | null; serving: boolean } | null;
};

export type SeedDemoInput = {
  workspaceId: string;
  userId: string;
  by: ActorContext;
  /** Which starter stack the project is made from (default `bun-api`). */
  templateId?: string;
  /** Make the project at all. Off in tests that only want the channels and the bots. */
  project?: boolean;
  /**
   * Start the project's dev server once it is ready. Off by default: the seed runs behind the
   * setup wizard, and a wizard that leaves a process running on a port nobody asked about is a
   * surprise — `perch demo`, where somebody did ask, turns it on.
   */
  preview?: boolean;
  /** How long to wait for the project to be set up before giving up on it. */
  projectWaitMs?: number;
};

async function seedChannels(deps: DemoDeps, input: SeedDemoInput) {
  const out: DemoResult["channels"] = [];
  for (const { name, topic } of DEMO_CHANNELS) {
    if (await findChannelByName(deps.db, input.workspaceId, name)) {
      out.push({ name, created: false });
      continue;
    }
    await createChannel(
      { db: { db: deps.db }, bus: deps.bus },
      {
        workspaceId: input.workspaceId,
        type: "public",
        name,
        topic,
        userId: input.userId,
        by: input.by,
      },
    );
    out.push({ name, created: true });
  }
  return out;
}

async function seedBots(deps: DemoDeps, input: SeedDemoInput) {
  const out: DemoResult["bots"] = [];
  for (const id of DEMO_BOTS) {
    const template = templateById(id);
    if (!template) continue;
    if (await botByHandle(deps.db, input.workspaceId, template.handle)) {
      out.push({ handle: template.handle, created: false });
      continue;
    }
    await deps.bots.create({
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
    out.push({ handle: template.handle, created: true });
  }
  return out;
}

/** The message the demo leaves in #general: what is here, and the first thing worth pressing. */
export function welcome(result: Omit<DemoResult, "workspaceId">): string {
  const lines = [
    "Welcome to Perch. This workspace was seeded so there is something to look at.",
    "",
    `Channels: ${result.channels.map((one) => `#${one.name}`).join(", ")}.`,
  ];
  if (result.bots.length > 0) {
    lines.push(
      `Bots: ${result.bots
        .map((one) => `@${one.handle}`)
        .join(", ")} — they need a model before they can answer, in Settings → Brains.`,
    );
  }
  if (result.project) {
    lines.push(
      `Project: ${result.project.key}, made from the ${DEMO_STACK} starter stack.`,
      result.preview?.serving
        ? `Its dev server is running on port ${result.preview.port}: open Code → Preview.`
        : "Open Code → Preview and press Start to run it.",
    );
  }
  lines.push("", "Delete any of it. Nothing here is special.");
  return lines.join("\n");
}

export async function seedDemo(deps: DemoDeps, input: SeedDemoInput): Promise<DemoResult> {
  const channels = await seedChannels(deps, input);
  const bots = await seedBots(deps, input);
  const wantsProject = input.project ?? true;
  const templateId = input.templateId ?? DEMO_STACK;
  if (wantsProject && !stackById(templateId)) {
    throw new Error(`no such template: ${templateId} (have ${STACKS.map((s) => s.id).join(", ")})`);
  }
  let project: DemoResult["project"] = null;
  let preview: DemoResult["preview"] = null;
  if (wantsProject) {
    const stack = stackById(templateId);
    const key = templateId;
    const existing = await findProjectByKey(deps.db, input.workspaceId, key);
    if (existing) {
      project = { id: existing.id, key: existing.key, created: false, status: existing.status };
    } else {
      const created = await createProject(
        deps,
        {
          workspaceId: input.workspaceId,
          name: stack?.name ?? templateId,
          key,
          source: { kind: "template", templateId },
          userId: input.userId,
          by: input.by,
        },
        ...(input.projectWaitMs === undefined ? [] : [{ runnerWaitMs: input.projectWaitMs }]),
      );
      const ready = await created.setup;
      project = { id: ready.id, key: ready.key, created: true, status: ready.status };
      if ((input.preview ?? false) && ready.status === "ready") {
        try {
          const run = await startPreview(deps.previews, ready, input.userId, input.by);
          preview = { port: run.port, serving: run.serving };
        } catch (error) {
          deps.log.warn({ err: error, projectId: ready.id }, "the demo preview did not start");
        }
      }
    }
  }
  const result: DemoResult = { workspaceId: input.workspaceId, channels, bots, project, preview };
  const general = await findChannelByName(deps.db, input.workspaceId, "general");
  if (general && channels.some((one) => one.name === "general" && one.created)) {
    const message = await insertMessage(deps.db, {
      workspaceId: input.workspaceId,
      channelId: general.id,
      threadRootId: null,
      authorType: "user",
      authorId: input.userId,
      blocks: [{ type: "text", text: welcome(result) }],
    });
    await deps.bus.publish(
      "message.created",
      {
        workspaceId: input.workspaceId,
        channelId: general.id,
        messageId: message.id,
        authorType: "user" as const,
        authorId: input.userId,
      },
      { ...input.by, topics: [`channel:${general.id}`] },
    );
  }
  return result;
}
