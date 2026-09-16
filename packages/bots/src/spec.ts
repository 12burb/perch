/**
 * Spec bots (spec §5.3 "spec bots bots/<handle>/bot.yaml + SYSTEM.md + skills/ in the Agent Skills
 * format, hot-reload on push"; task 3.1).
 *
 * A bot that lives in a repository rather than in a form. The directory is the bot: `bot.yaml` says
 * who it is, `SYSTEM.md` is what it was told, and `skills/<name>/SKILL.md` is what it knows how to
 * do. Nothing here touches a database or a runner — it turns files into the same `BotSpec` the
 * Forge produces, so a spec bot and a form bot are the same bot to everything downstream.
 *
 * The YAML is written the way the spec's example writes it: `daily_usd`, `long_term`, `max_steps`,
 * and triggers that are bare words. This is where that becomes the camel-cased shape §6 stores.
 */
import {
  type BotBudget,
  type BotSpec,
  type BotVisibility,
  botBudgetSchema,
  botSpecSchema,
} from "@perch/db";
import { parse as parseYaml } from "yaml";

/** Where a project keeps its bots, and what names the one file that must be there. */
export const SPEC_BOTS_DIR = "bots";
export const SPEC_BOT_FILE = "bot.yaml";
export const SPEC_PERSONA_FILE = "SYSTEM.md";
/** A code bot's own JavaScript, beside its bot.yaml (spec §5.3; task 3.2). */
export const SPEC_CODE_FILE = "bot.js";
export const SPEC_SKILLS_DIR = "skills";

/** A handle is what people type after an `@`, so it is what a handle may be. */
const HANDLE = /^[a-z0-9][a-z0-9_-]{1,31}$/;

export class SpecBotError extends Error {
  constructor(
    readonly file: string,
    message: string,
  ) {
    super(`${file}: ${message}`);
    this.name = "SpecBotError";
  }
}

export type SpecBotFiles = {
  /** `bots/<handle>/bot.yaml`, as it was written. */
  yaml: string;
  /** `bots/<handle>/SYSTEM.md`, when the directory has one. */
  systemMd?: string | undefined;
  /** `bots/<handle>/bot.js`, when the directory has one: this is a code bot rather than a spec one. */
  code?: string | undefined;
  /** Every `bots/<handle>/skills/**\/SKILL.md`, by path inside the bot's directory. */
  skills?: { path: string; text: string }[] | undefined;
};

/** What a bot directory turns into: the row's columns, and the spec for the `spec` column. */
export type SpecBot = {
  handle: string;
  name: string;
  /** `code` when the directory has a `bot.js`, `spec` otherwise (spec §5.3's four ways). */
  level: "spec" | "code";
  visibility: BotVisibility;
  orchestrator: boolean;
  budget: BotBudget;
  spec: BotSpec;
  /** The JavaScript a code bot runs, or null. */
  code: string | null;
};

type Loose = Record<string, unknown>;

function object(value: unknown, file: string, where: string): Loose {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SpecBotError(file, `${where} should be a block of keys`);
  }
  return value as Loose;
}

/** `daily_usd` → `dailyUsd`. The file is written the way the spec writes it; the column is not. */
function camel(key: string): string {
  return key.replace(/_([a-z0-9])/g, (_, ch: string) => ch.toUpperCase());
}

function camelKeys(value: Loose): Loose {
  const out: Loose = {};
  for (const [key, one] of Object.entries(value)) out[camel(key)] = one;
  return out;
}

/**
 * One trigger, in any of the three ways the spec writes them: a bare word (`dm`), a shorthand
 * block (`{schedule: "0 9 * * 1-5", prompt: "…"}`, `{keyword: "ship it"}`), or the long form the
 * column stores (`{on: keyword, match: "ship it"}`).
 */
function trigger(value: unknown, file: string): Loose {
  if (typeof value === "string") return { on: value.trim() };
  const block = camelKeys(object(value, file, "a trigger"));
  if (typeof block.schedule === "string") {
    const { schedule, ...rest } = block;
    return { on: "schedule", cron: schedule, ...rest };
  }
  if (typeof block.keyword === "string") {
    const { keyword, ...rest } = block;
    return { on: "keyword", match: keyword, ...rest };
  }
  if (typeof block.reaction === "string") {
    const { reaction, ...rest } = block;
    return { on: "reaction", match: reaction, ...rest };
  }
  return block;
}

/**
 * The Agent Skills format: YAML frontmatter with a name and the line that says when to use it,
 * then the instructions. A file without frontmatter is still a skill — its name comes from its
 * directory, which is how a skill written in a hurry still works.
 */
export function parseSkill(path: string, raw: string): BotSpecSkill {
  const fenced = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw);
  const body = (fenced ? raw.slice(fenced[0].length) : raw).trim();
  const front = fenced ? object(parseYaml(fenced[1] ?? "") ?? {}, path, "the frontmatter") : {};
  const fallback = path
    .split("/")
    .filter((part) => part !== "" && part.toUpperCase() !== "SKILL.MD")
    .pop();
  const name = typeof front.name === "string" && front.name.trim() ? front.name.trim() : fallback;
  if (!name) throw new SpecBotError(path, "a skill needs a name, in its frontmatter or its folder");
  if (body === "") throw new SpecBotError(path, "a skill with no instructions does nothing");
  return {
    name: name.slice(0, 64),
    description: typeof front.description === "string" ? front.description.slice(0, 500) : "",
    instructions: body.slice(0, 20_000),
  };
}

type BotSpecSkill = NonNullable<BotSpec["skills"]>[number];

/**
 * A bot directory, read. `dir` is the folder's name, which is the handle when the file does not
 * say one — a bot should not have to repeat itself.
 */
export function parseSpecBot(dir: string, files: SpecBotFiles): SpecBot {
  const file = `${SPEC_BOTS_DIR}/${dir}/${SPEC_BOT_FILE}`;
  let parsed: unknown;
  try {
    parsed = parseYaml(files.yaml);
  } catch (error) {
    throw new SpecBotError(file, error instanceof Error ? error.message : String(error));
  }
  const doc = camelKeys(object(parsed ?? {}, file, "bot.yaml"));

  const handle = (typeof doc.handle === "string" ? doc.handle : dir).trim().toLowerCase();
  if (!HANDLE.test(handle)) {
    throw new SpecBotError(file, `\`${handle}\` is not a handle somebody could type after an @`);
  }
  const name = typeof doc.name === "string" && doc.name.trim() ? doc.name.trim() : handle;

  // The persona is either written here or pointed at; `./SYSTEM.md` is what the spec's example says.
  const persona =
    typeof doc.persona === "string" && !/^\.?\/?SYSTEM\.md$/i.test(doc.persona.trim())
      ? doc.persona
      : files.systemMd;

  const brainRaw =
    doc.brain === undefined ? undefined : camelKeys(object(doc.brain, file, "brain"));
  // `model:` in the file names the model profile, because a self-hosted Perch reaches every model
  // through one (ADR-0116): a raw vendor id would be a credential nobody granted.
  const brain =
    brainRaw === undefined
      ? undefined
      : (() => {
          const { model, ...rest } = brainRaw;
          return typeof model === "string" && rest.profile === undefined
            ? { ...rest, profile: model }
            : rest;
        })();

  const skills = (files.skills ?? []).map((one) => parseSkill(one.path, one.text));
  const spec = botSpecSchema.safeParse({
    ...(persona ? { persona } : {}),
    ...(brain ? { brain } : {}),
    ...(doc.tools === undefined ? {} : { tools: doc.tools }),
    ...(doc.triggers === undefined
      ? {}
      : {
          triggers: (Array.isArray(doc.triggers) ? doc.triggers : [doc.triggers]).map((one) =>
            trigger(one, file),
          ),
        }),
    ...(doc.scope === undefined ? {} : { scope: camelKeys(object(doc.scope, file, "scope")) }),
    ...(doc.memory === undefined ? {} : { memory: camelKeys(object(doc.memory, file, "memory")) }),
    ...(doc.maxSteps === undefined ? {} : { maxSteps: doc.maxSteps }),
    ...(doc.timezone === undefined ? {} : { timezone: doc.timezone }),
    ...(skills.length > 0 ? { skills } : {}),
  });
  if (!spec.success) {
    throw new SpecBotError(
      file,
      spec.error.issues.map((i) => `${i.path.join(".")} ${i.message}`)[0] ?? "is not a bot",
    );
  }

  const budget = botBudgetSchema.safeParse(
    doc.budget === undefined ? {} : camelKeys(object(doc.budget, file, "budget")),
  );
  if (!budget.success) {
    throw new SpecBotError(file, `budget: ${budget.error.issues[0]?.message ?? "is not a budget"}`);
  }

  const visibility = doc.visibility === "private" ? "private" : "workspace";
  const code = files.code?.trim() ? files.code : null;
  return {
    handle,
    name: name.slice(0, 120),
    level: code ? "code" : "spec",
    visibility,
    orchestrator: doc.orchestrator === true,
    budget: budget.data,
    spec: spec.data,
    code,
  };
}

/**
 * Which files under a project belong to a bot, and which bot. Everything else in the tree is
 * ignored, so a repository with one `bots/` folder is a repository with bots in it and nothing
 * about the rest of it changes.
 */
export function botDirOf(path: string): string | null {
  // Three parts at least: `bots/<handle>/<something>`. A file lying directly in `bots/` is not a
  // bot, it is a file somebody left there.
  const parts = path.replace(/^\.?\//, "").split("/");
  return parts[0] === SPEC_BOTS_DIR && parts.length >= 3 && parts[1] ? parts[1] : null;
}
