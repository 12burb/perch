import { describe, expect, test } from "bun:test";
import { botDirOf, parseSkill, parseSpecBot, SpecBotError } from "../src/spec.ts";

/**
 * Task 3.1 (spec §5.3): a bot that lives in a repository. The file is written the way the spec's
 * own example writes it, and what comes out is the same shape the Forge produces.
 */

const GROK = `handle: grok
name: Grok
brain:
  model: Newsroom brain
  temperature: 0.7
persona: ./SYSTEM.md
tools: [web_search, http_fetch]
triggers:
  - dm
  - mention
  - schedule: "0 9 * * 1-5"
    prompt: "Post today's gaming + crypto headlines to #newsroom"
    channel: newsroom
scope:
  channels: [newsroom, general]
memory:
  window: 30
  long_term: false
budget:
  daily_usd: 5
  per_thread_usd: 1
`;

describe("a bot directory", () => {
  test("is the spec's own example, in the shape the column stores", () => {
    const bot = parseSpecBot("grok", {
      yaml: GROK,
      systemMd: "You are Grok. You read the news.\n",
    });
    expect(bot.handle).toBe("grok");
    expect(bot.name).toBe("Grok");
    // The file does not say, so the sync decides from who is syncing (ADR-0176).
    expect(bot.visibility).toBeNull();
    expect(bot.spec.persona).toContain("You read the news");
    // `model:` names the workspace's model profile: a self-hosted Perch reaches every model
    // through one, and a raw vendor id would be a credential nobody granted (ADR-0116).
    expect(bot.spec.brain).toEqual({ profile: "Newsroom brain", temperature: 0.7 });
    expect(bot.spec.tools).toEqual(["web_search", "http_fetch"]);
    expect(bot.spec.triggers).toEqual([
      { on: "dm" },
      { on: "mention" },
      {
        on: "schedule",
        cron: "0 9 * * 1-5",
        prompt: "Post today's gaming + crypto headlines to #newsroom",
        channel: "newsroom",
      },
    ]);
    expect(bot.spec.scope).toEqual({ channels: ["newsroom", "general"] });
    expect(bot.spec.memory).toEqual({ window: 30, longTerm: false });
    expect(bot.budget).toEqual({ dailyUsd: 5, perThreadUsd: 1 });
  });

  test("takes its handle from the folder, and its persona from the file when it is written there", () => {
    const bot = parseSpecBot("scribe", { yaml: "name: Scribe\npersona: Take notes.\n" });
    expect(bot.handle).toBe("scribe");
    expect(bot.spec.persona).toBe("Take notes.");
  });

  test("reads the shorthand triggers as well as the long form", () => {
    const bot = parseSpecBot("watch", {
      yaml: 'triggers:\n  - keyword: "ship it"\n  - reaction: "eyes"\n  - on: channel_join\n',
    });
    expect(bot.spec.triggers).toEqual([
      { on: "keyword", match: "ship it" },
      { on: "reaction", match: "eyes" },
      { on: "channel_join" },
    ]);
  });

  test("refuses a keyword pattern that could stall the api, as the Forge does", () => {
    const yaml = 'triggers:\n  - on: keyword\n    match: "^(a+)+$"\n    regex: true\n';
    expect(() => parseSpecBot("stall", { yaml })).toThrow(SpecBotError);
    expect(() => parseSpecBot("stall", { yaml })).toThrow(/cannot repeat a group/);
  });

  test("says which file is wrong, and why", () => {
    expect(() => parseSpecBot("grok", { yaml: "handle: Not A Handle\n" })).toThrow(SpecBotError);
    expect(() => parseSpecBot("grok", { yaml: "handle: Not A Handle\n" })).toThrow(
      /bots\/grok\/bot\.yaml/,
    );
    expect(() => parseSpecBot("grok", { yaml: "tools: [rm_rf]\n" })).toThrow(SpecBotError);
    expect(() => parseSpecBot("grok", { yaml: "budget: {daily_usd: -1}\n" })).toThrow(/budget/);
    expect(() => parseSpecBot("grok", { yaml: "brain: [1, 2]\n" })).toThrow(/brain/);
    expect(() => parseSpecBot("grok", { yaml: ": : :\n" })).toThrow(SpecBotError);
  });

  test("carries its skills, in the Agent Skills format", () => {
    const bot = parseSpecBot("grok", {
      yaml: "name: Grok\n",
      skills: [
        {
          path: "skills/headlines/SKILL.md",
          text: "---\nname: Headlines\ndescription: When asked for the news.\n---\nRead the wire, then say the three that matter.\n",
        },
      ],
    });
    expect(bot.spec.skills).toEqual([
      {
        name: "Headlines",
        description: "When asked for the news.",
        instructions: "Read the wire, then say the three that matter.",
      },
    ]);
  });
});

describe("a skill", () => {
  test("is named by its folder when the frontmatter does not say", () => {
    expect(parseSkill("skills/triage/SKILL.md", "Sort it by who is waiting.\n")).toEqual({
      name: "triage",
      description: "",
      instructions: "Sort it by who is waiting.",
    });
  });

  test("with no instructions is refused", () => {
    expect(() => parseSkill("skills/empty/SKILL.md", "---\nname: Empty\n---\n")).toThrow(
      /does nothing/,
    );
  });
});

describe("which files belong to a bot", () => {
  test("is the folder under bots/, and nothing else in the tree", () => {
    expect(botDirOf("bots/grok/bot.yaml")).toBe("grok");
    expect(botDirOf("bots/grok/skills/headlines/SKILL.md")).toBe("grok");
    expect(botDirOf("./bots/grok/SYSTEM.md")).toBe("grok");
    expect(botDirOf("src/index.ts")).toBeNull();
    expect(botDirOf("bots/bot.yaml")).toBeNull();
    expect(botDirOf("docs/bots/grok/bot.yaml")).toBeNull();
  });
});
